/**
 * Retrieval-lite: pulls the most relevant paragraphs from a client's
 * knowledge/<clientId>.txt file for a given question, instead of stuffing
 * the whole file into every request.
 *
 * This is keyword/TF scoring, not embeddings — zero extra API keys or
 * dependencies, and good enough for a knowledge base up to a few hundred
 * paragraphs. Swap in a real embeddings provider (Voyage AI, OpenAI) once
 * a client's content outgrows this — the call site (server.js) only needs
 * `topChunks()` to keep returning an array of strings, so the upgrade is
 * contained to this file.
 */

const fs = require('fs');
const path = require('path');

const STOPWORDS = new Set([
  'a','an','the','is','are','was','were','be','been','being','to','of','in','on','at','for',
  'with','and','or','but','if','so','do','does','did','can','could','would','should','will',
  'i','you','he','she','it','we','they','my','your','his','her','its','our','their','this',
  'that','these','those','what','when','where','how','why','who','which','me','us','them',
  'have','has','had','not','no','yes','than','then','there','here','from','about','into',
]);

// crude suffix-stripping so "rent"/"rental"/"rentals" and similar all collapse
// to one token — this is what a real stemmer (e.g. Porter) does properly;
// this is the minimal version that covers common English inflections.
function stem(word) {
  if (word.length > 5 && word.endsWith('ies')) word = word.slice(0, -3) + 'y';
  else if (word.length > 5 && word.endsWith('es')) word = word.slice(0, -2);
  else if (word.length > 4 && word.endsWith('s') && !word.endsWith('ss')) word = word.slice(0, -1);
  if (word.length > 6 && word.endsWith('ing')) word = word.slice(0, -3);
  if (word.length > 5 && word.endsWith('ed')) word = word.slice(0, -2);
  if (word.length > 6 && word.endsWith('tion')) word = word.slice(0, -4) + 't';
  if (word.length > 5 && word.endsWith('al')) word = word.slice(0, -2);
  return word;
}

function tokenize(text) {
  return (text.toLowerCase().match(/[a-z0-9']+/g) || [])
    .filter((w) => !STOPWORDS.has(w) && w.length > 1)
    .map(stem);
}

function loadChunks(clientId) {
  const file = path.join(__dirname, 'knowledge', `${clientId}.txt`);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split(/\n\s*\n/)
    .map((c) => c.trim())
    .filter(Boolean);
}

/**
 * Returns the top `k` chunks most relevant to `query`, by shared-token overlap
 * weighted toward rarer (more distinctive) words. Falls back to the first
 * few chunks if nothing scores above zero, so the bot always has *some*
 * context rather than none.
 */
function topChunks(clientId, query, k = 3) {
  const chunks = loadChunks(clientId);
  if (chunks.length === 0) return [];

  const queryTokens = new Set(tokenize(query));
  if (queryTokens.size === 0) return chunks.slice(0, k);

  // crude inverse-document-frequency: words that show up in fewer chunks score higher
  const docFreq = {};
  const chunkTokenSets = chunks.map((c) => {
    const tokens = new Set(tokenize(c));
    tokens.forEach((t) => { docFreq[t] = (docFreq[t] || 0) + 1; });
    return tokens;
  });

  const scored = chunks.map((chunk, i) => {
    let score = 0;
    queryTokens.forEach((qt) => {
      if (chunkTokenSets[i].has(qt)) {
        score += 1 / Math.log(2 + (docFreq[qt] || 1));
      }
    });
    return { chunk, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const top = scored.filter((s) => s.score > 0).slice(0, k);
  if (top.length === 0) return chunks.slice(0, k); // no keyword hits — hand over the basics rather than nothing
  return top.map((s) => s.chunk);
}

function readKnowledge(clientId) {
  const file = path.join(__dirname, 'knowledge', `${clientId}.txt`);
  if (!fs.existsSync(file)) return '';
  return fs.readFileSync(file, 'utf8');
}

// ---------- versioned writes: every change (manual, AI-drafted, or scraped)
// snapshots what was live before overwriting it, so any automated edit can be
// undone in one call. This is what makes auto-applying an AI-drafted edit
// safe to turn on: nothing is destructive.

const HISTORY_LIMIT = 20; // keep this many prior versions per client, prune older ones

function knowledgeDir() {
  const dir = path.join(__dirname, 'knowledge');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
  return dir;
}

function historyDir(clientId) {
  const dir = path.join(knowledgeDir(), `${clientId}.history`);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function changelogFile(clientId) {
  return path.join(knowledgeDir(), `${clientId}.changelog.jsonl`);
}

function appendChangelog(clientId, entry) {
  fs.appendFileSync(changelogFile(clientId), JSON.stringify(entry) + '\n', 'utf8');
}

/**
 * Overwrites a client's live knowledge base, but only after snapshotting
 * whatever was there before into knowledge/<clientId>.history/. `meta.source`
 * records who/what made the change (manual, draft-auto, scrape-auto,
 * alert-auto) and `meta.summary` is a one-line description, both logged to
 * knowledge/<clientId>.changelog.jsonl so admin.html can show a history.
 */
function writeKnowledge(clientId, text, meta = {}) {
  const file = path.join(knowledgeDir(), `${clientId}.txt`);

  if (fs.existsSync(file)) {
    const hDir = historyDir(clientId);
    fs.copyFileSync(file, path.join(hDir, `${Date.now()}.txt`));
    const snapshots = fs.readdirSync(hDir).filter((f) => f.endsWith('.txt')).sort();
    while (snapshots.length > HISTORY_LIMIT) fs.unlinkSync(path.join(hDir, snapshots.shift()));
  }

  fs.writeFileSync(file, text, 'utf8');
  appendChangelog(clientId, {
    ts: Date.now(),
    source: meta.source || 'manual',
    summary: meta.summary || '',
    chars: text.length,
  });
}

/**
 * Undoes the most recent write by restoring the newest snapshot. Calling it
 * again steps one version further back. Returns { ok:false } if there's
 * nothing left to roll back to.
 */
function rollbackKnowledge(clientId) {
  const hDir = historyDir(clientId);
  const snapshots = fs.readdirSync(hDir).filter((f) => f.endsWith('.txt')).sort();
  if (!snapshots.length) return { ok: false, reason: 'No earlier version to roll back to.' };

  const last = snapshots[snapshots.length - 1];
  const file = path.join(knowledgeDir(), `${clientId}.txt`);
  fs.copyFileSync(path.join(hDir, last), file);
  fs.unlinkSync(path.join(hDir, last));

  appendChangelog(clientId, {
    ts: Date.now(),
    source: 'rollback',
    summary: `Restored the version from before the last change.`,
    chars: fs.readFileSync(file, 'utf8').length,
  });
  return { ok: true };
}

function knowledgeChangelog(clientId, limit = 20) {
  if (!fs.existsSync(changelogFile(clientId))) return [];
  const rows = fs
    .readFileSync(changelogFile(clientId), 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  return rows.slice(-limit).reverse();
}

module.exports = { topChunks, readKnowledge, writeKnowledge, rollbackKnowledge, knowledgeChangelog };
