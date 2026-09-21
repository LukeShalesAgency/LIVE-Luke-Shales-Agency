/**
 * Fallback-rate alerting — watches each client's resolved rate and pings a
 * webhook only when something actually needs attention.
 *
 * When a client has autoApplyKnowledgeEdits on AND at least one known site
 * (remembered automatically the first time you scrape them from admin.html —
 * a client can have several, e.g. a main site plus a separate FAQ site), this
 * also tries to fix the problem on its own: it re-scrapes all of their known
 * sites, and only adds/updates knowledge-base paragraphs that are actually
 * grounded in what's really on the page. It will NOT invent an answer to a question
 * just because the question was asked — if the site genuinely doesn't cover
 * a topic (e.g. "do you deliver to hotels"), it says so in the alert instead
 * of guessing, because a wrong fact stated confidently to a customer is worse
 * than the bot saying "let me connect you with someone."
 *
 * Every automated write is versioned (see retrieval.js writeKnowledge), so
 * any auto-fix here can be undone with one call to
 * POST /api/clients/:id/knowledge/rollback.
 */

const fs = require('fs');
const path = require('path');
const { computeStats, readJsonl, ANALYTICS_DIR } = require('./stats');
const { readKnowledge, writeKnowledge } = require('../retrieval');

const STATE_FILE = path.join(__dirname, '..', 'reports', '.alert-state.json');

function loadState() {
  if (!fs.existsSync(STATE_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

const DEFAULT_THRESHOLD = 0.15; // 15% fallback rate
const MIN_SAMPLE = 10; // don't alert on 1 bad conversation out of 2

function notifyUrl(client) {
  return client.knowledgeWebhookUrl || client.handoffWebhookUrl || client.reportWebhookUrl || '';
}

async function postWebhook(url, text) {
  if (!url) return;
  try {
    await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
  } catch (err) {
    console.error('Alert webhook failed:', err.message);
  }
}

function recentFallbackQuestions(clientId, limit = 15) {
  const entries = readJsonl(ANALYTICS_DIR, clientId).filter((e) => e.fallback);
  const seen = new Set();
  const out = [];
  for (let i = entries.length - 1; i >= 0 && out.length < limit; i--) {
    const q = entries[i].question.trim();
    const key = q.toLowerCase();
    if (!seen.has(key)) { seen.add(key); out.push(q); }
  }
  return out;
}

// a client can have more than one source site (main site + a separate FAQ or
// support site); websiteUrls is the current field, websiteUrl (singular) is
// kept readable for any client file saved before this existed
function clientWebsiteUrls(client) {
  if (Array.isArray(client.websiteUrls) && client.websiteUrls.length) return client.websiteUrls;
  if (client.websiteUrl) return [client.websiteUrl];
  return [];
}

/**
 * Attempts a grounded auto-fix: re-scrapes all of the client's known sites,
 * and asks Claude to close as many of the given fallback questions as it
 * honestly can using only what's really on the pages. Returns null if it
 * can't attempt this (no sites on file, no API key, or the crawl found
 * nothing).
 */
async function attemptAutoFix(client, fallbackQuestions) {
  const siteUrls = clientWebsiteUrls(client);
  if (!siteUrls.length || !process.env.ANTHROPIC_API_KEY) return null;

  let pages;
  try {
    const { crawlSites } = require('./scraper');
    pages = await crawlSites(siteUrls, 12);
  } catch {
    return null;
  }
  if (!pages.length) return null;

  const Anthropic = require('@anthropic-ai/sdk');
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const currentText = readKnowledge(client.clientId);
  const pagesBlock = pages
    .map((p) => `--- PAGE: ${p.url}${p.title ? ` (${p.title})` : ''}${p.site ? ` [from ${p.site}]` : ''} ---\n${p.text}`)
    .join('\n\n');
  const questionsBlock = fallbackQuestions.map((q) => `- ${q}`).join('\n');

  try {
    const completion = await anthropic.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 4000,
      system:
        "You maintain a business's chatbot knowledge base. Visitors have been asking questions the bot " +
        "couldn't answer. You're given those questions, the CURRENT knowledge base, and a fresh scrape of " +
        "the business's real website. For each question, check whether the scraped pages actually contain " +
        'a real answer. If yes, add or update a paragraph with that real information. If no page covers it, ' +
        'do NOT guess or invent an answer — list that question under "unresolvedTopics" instead, since a ' +
        'wrong fact told to a customer is worse than the bot admitting it doesn\'t know. Never remove or ' +
        'alter paragraphs unrelated to these questions. Reply with strict JSON only, no markdown fences: ' +
        '{"draftText": "<the full updated knowledge base>", "summary": "<what was added/updated, one or two ' +
        'sentences>", "unresolvedTopics": ["<question or topic the site genuinely doesn\'t cover>", ...]}',
      messages: [
        {
          role: 'user',
          content:
            `QUESTIONS THE BOT COULDN'T ANSWER:\n${questionsBlock}\n\n` +
            `CURRENT KNOWLEDGE BASE:\n${currentText || '(empty)'}\n\n` +
            `FRESH SCRAPE OF ${siteUrls.join(', ')}:\n${pagesBlock}`,
        },
      ],
    });

    const raw = completion.content?.[0]?.text?.trim() || '{}';
    const parsed = JSON.parse(raw);
    return {
      draftText: parsed.draftText || currentText,
      summary: parsed.summary || '',
      unresolvedTopics: Array.isArray(parsed.unresolvedTopics) ? parsed.unresolvedTopics : [],
      changed: (parsed.draftText || currentText) !== currentText,
    };
  } catch (err) {
    console.error(`Auto-fix drafting failed for ${client.clientId}:`, err.message);
    return null;
  }
}

/**
 * Checks one client's current fallback rate against their threshold. Sends
 * at most one alert per day per client (tracked in .alert-state.json).
 */
async function checkClient(client) {
  const threshold = client.fallbackAlertThreshold ?? DEFAULT_THRESHOLD;
  const stats = computeStats(client.clientId);
  const fallbackFraction = stats.fallbackRate / 100;

  if (stats.totalMessages < MIN_SAMPLE) {
    return { clientId: client.clientId, alerted: false, reason: 'not enough volume yet' };
  }
  if (fallbackFraction < threshold) {
    return { clientId: client.clientId, alerted: false, reason: 'within threshold' };
  }

  const state = loadState();
  const today = new Date().toISOString().slice(0, 10);
  if (state[client.clientId] === today) {
    return { clientId: client.clientId, alerted: false, reason: 'already alerted today' };
  }

  const headline =
    `⚠️ ${client.businessName}'s chatbot is at a ${stats.fallbackRate}% fallback rate ` +
    `(threshold ${Math.round(threshold * 100)}%) over ${stats.totalMessages} messages.`;

  let message = `${headline} Worth reviewing its knowledge base — check the admin dashboard for the questions it's missing.`;
  let autoFixed = false;

  if (client.autoApplyKnowledgeEdits) {
    const fallbackQuestions = recentFallbackQuestions(client.clientId);
    const fix = fallbackQuestions.length ? await attemptAutoFix(client, fallbackQuestions) : null;

    if (fix && fix.changed) {
      writeKnowledge(client.clientId, fix.draftText, { source: 'alert-auto', summary: fix.summary });
      autoFixed = true;
      message =
        `${headline}\n` +
        `✅ Auto-fixed from the site: ${fix.summary}\n` +
        (fix.unresolvedTopics.length
          ? `❗ Still needs your input (not covered on the site): ${fix.unresolvedTopics.join('; ')}\n`
          : '') +
        `Undo anytime in admin.html ("Recent changes") or POST /api/clients/${client.clientId}/knowledge/rollback.`;
    } else if (fix && !fix.changed && fix.unresolvedTopics.length) {
      message =
        `${headline}\n` +
        `Re-checked their site — nothing new to add automatically. These questions genuinely aren't ` +
        `covered on the site and need your input: ${fix.unresolvedTopics.join('; ')}`;
    }
    // if fix is null (no websiteUrl on file yet, or crawl failed), falls through to the default message above
  }

  await postWebhook(notifyUrl(client), message);

  state[client.clientId] = today;
  saveState(state);

  return { clientId: client.clientId, alerted: true, autoFixed, message };
}

module.exports = { checkClient, DEFAULT_THRESHOLD };
