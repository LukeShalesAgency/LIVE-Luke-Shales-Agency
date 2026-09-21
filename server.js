/**
 * Sitewright Chatbot Kit — backend
 *
 * Multi-client AI chat backend with:
 *   1. Memory       — the widget sends recent conversation history; the model sees it.
 *   2. Lead capture — the model marks replies with [[CAPTURE_LEAD]] when it should ask
 *                      for contact info; the server strips the marker and tells the
 *                      widget to show the capture form.
 *   3. Retrieval    — only the most relevant knowledge-base paragraphs are sent per
 *                      question, not the whole file (see retrieval.js).
 *   4. Streaming    — replies stream token-by-token over a chunked HTTP response.
 *   5. Admin API    — list clients, edit a client's knowledge base, view leads/handoffs.
 *   6. Handoff      — a visitor (or the bot, when stuck) can flag a conversation for a
 *                      human; logged per client and optionally pushed to a webhook.
 *
 * Plus the maintenance-reduction layer (see lib/ and scheduler.js):
 *   - lib/stats.js    shared stats logic, all-time and monthly-window
 *   - lib/report.js   builds + saves the monthly client report
 *   - lib/alerts.js   fallback-rate watchdog, alerts once/day via webhook
 *   - scheduler.js    runs reports + alerts on a schedule (or once with --now)
 *   - the knowledge/draft endpoint below: AI drafts a knowledge-base edit
 *     from a client's message, you review it in the admin dashboard before
 *     it's saved — draft-then-approve, not auto-apply.
 *
 * Setup: see README.md
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const { topChunks, readKnowledge, writeKnowledge, rollbackKnowledge, knowledgeChangelog } = require('./retrieval');
const { crawlSites, guessBusinessName, fetchHomepage } = require('./lib/scraper');
const { computeStats, readJsonl, ANALYTICS_DIR, LEADS_DIR, HANDOFFS_DIR } = require('./lib/stats');
const { buildReport, saveReport, listSavedReports, sendReportWebhook } = require('./lib/report');
const { ensureDir } = require('./lib/paths');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// ---------- password protection for YOUR side of the app ----------
//
// admin.html and every /api/clients* route (managing clients, their
// knowledge bases, leads, handoffs) require a password. The public-facing
// pieces — the chat widget itself, lead capture, handoff, the client-facing
// stats used by dashboard.html — stay open, since visitors on a client's
// site and the client themselves need those to work with no login at all.
//
// Set ADMIN_PASSWORD as an environment variable (same way as
// ANTHROPIC_API_KEY) to turn this on. Until it's set, everything stays open
// — that's so testing locally with no setup still works — but the server
// prints a warning at startup so it's never silently unprotected once live.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

function requireAdminAuth(req, res, next) {
  if (!ADMIN_PASSWORD) return next(); // not configured — see warning at startup
  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const password = decoded.slice(decoded.indexOf(':') + 1); // username can be anything, only the password matters
    if (password === ADMIN_PASSWORD) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Chatbot admin"');
  res.status(401).send('Password required.');
}

// admin.html specifically needs to be caught here, BEFORE the static file
// server below, or the static server would hand it out unprotected.
app.get('/admin.html', requireAdminAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

// every /api/clients* route (list/create clients, edit knowledge, scrape,
// rollback, changelog, reports) is admin-only — this one line covers all of
// them, registered here so it runs before any of those routes further down.
app.use('/api/clients', requireAdminAuth);

const CLIENTS_DIR = ensureDir('clients');
// Same reasoning as lib/paths.js's ensureDir: this used to throw straight
// out of a top-level statement and crash the ENTIRE server over one
// unwritable folder (e.g. the disk having a permissions hiccup on just the
// "analytics" folder), taking down chat and everything else with it. Now it
// warns and keeps going instead — whatever actually tries to use that
// folder will surface its own clear error when it's used.
[ANALYTICS_DIR, LEADS_DIR, HANDOFFS_DIR].forEach((d) => {
  try {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  } catch (err) {
    console.error(
      `⚠️  Could not create data folder "${d}" (${err.code || err.message}). The app will keep starting, but anything that reads/writes this folder will fail until this is fixed.`
    );
  }
});

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ---------- small file-backed helpers ----------

function listClients() {
  if (!fs.existsSync(CLIENTS_DIR)) return [];
  return fs
    .readdirSync(CLIENTS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(CLIENTS_DIR, f), 'utf8')));
}

function loadClient(clientId) {
  const file = path.join(CLIENTS_DIR, `${clientId}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function saveClient(client) {
  fs.writeFileSync(path.join(CLIENTS_DIR, `${client.clientId}.json`), JSON.stringify(client, null, 2), 'utf8');
}

// A client with no `status` field at all (every client made before this
// feature existed) is treated as active — so nothing already deployed
// changes behavior on its own. Only an explicit 'paused' turns the bot off.
function isClientPaused(client) {
  return client.status === 'paused';
}

// clients can have more than one source site (main site + a separate FAQ/support
// site, say). websiteUrls is the current field; websiteUrl (singular) is kept
// readable for any client file saved before this existed.
function clientWebsiteUrls(client) {
  if (Array.isArray(client.websiteUrls) && client.websiteUrls.length) return client.websiteUrls;
  if (client.websiteUrl) return [client.websiteUrl];
  return [];
}

function mergeWebsiteUrls(client, newUrls) {
  const merged = [...new Set([...clientWebsiteUrls(client), ...newUrls])];
  client.websiteUrls = merged;
  delete client.websiteUrl; // fold the legacy singular field into the array form
  return merged;
}

// where a knowledge-change notification goes: a dedicated webhook if the
// client has one, otherwise whichever of the other two webhooks is set
function notifyUrl(client) {
  return client.knowledgeWebhookUrl || client.handoffWebhookUrl || client.reportWebhookUrl || '';
}

async function postWebhook(url, text) {
  if (!url) return;
  try {
    await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
  } catch (err) {
    console.error('Knowledge-change webhook failed:', err.message);
  }
}

const DEFAULT_SYSTEM_PROMPT_TEMPLATE =
  'You are the AI assistant for {{businessName}}. Answer ONLY using the information in the RELEVANT INFO ' +
  "block below — never invent prices, policies, hours, or stock that aren't stated there. Keep answers " +
  'short (2-4 sentences), friendly, and specific.\n\n' +
  "If the RELEVANT INFO doesn't cover the question, say so plainly and offer to connect them with a " +
  'person — then end your reply with the exact marker [[CAPTURE_LEAD]] on its own line.\n\n' +
  'If the visitor asks for a quote, says they want to buy/book/schedule something, or otherwise shows ' +
  'real buying intent, answer their question normally and ALSO end your reply with [[CAPTURE_LEAD]] on ' +
  'its own line so we can follow up.\n\n' +
  'Never show the marker or mention it — it is stripped before the visitor sees your reply.\n\n' +
  'RELEVANT INFO:\n{{context}}';

function slugify(name) {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'client'
  );
}

function uniqueClientId(base) {
  let id = base;
  let n = 2;
  while (fs.existsSync(path.join(CLIENTS_DIR, `${id}.json`))) {
    id = `${base}-${n}`;
    n += 1;
  }
  return id;
}

/**
 * Shared by the "new client from URL" flow and the manual re-scrape endpoint:
 * turns a set of crawled pages into draft knowledge-base text via Claude.
 * Throws only on a hard API failure; a malformed model response instead
 * resolves with a fallback summary so callers can still respond usefully.
 */
async function draftKnowledgeFromPages(client, pages, currentText) {
  const pagesBlock = pages
    .map((p) => `--- PAGE: ${p.url}${p.title ? ` (${p.title})` : ''}${p.site ? ` [from ${p.site}]` : ''} ---\n${p.text}`)
    .join('\n\n');

  const completion = await anthropic.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 8000,
    system:
      "You build a business's chatbot knowledge base from raw scraped website text. Output plain-text " +
      'paragraphs, one per fact/topic (hours, pricing, services, service area, policies, location, ' +
      "contact info, what makes them different, etc.), written in third person, factual, no marketing " +
      'fluff, and no invented facts — use only what appears in the scraped pages. If a topic is covered ' +
      'on multiple pages, merge it into a single clear paragraph rather than repeating it. If the CURRENT ' +
      'knowledge base already has good paragraphs, keep them and only add new ones or update ones the ' +
      'scrape contradicts. draftText must never be empty as long as SCRAPED PAGES has any real content — ' +
      'if you genuinely find nothing usable, still return whatever CURRENT KNOWLEDGE BASE had rather than ' +
      'an empty string. Reply with strict JSON only, no markdown fences, no code block: ' +
      '{"draftText": "<the full knowledge base>", "summary": "<one or two sentences on what was drafted, ' +
      'and anything you noticed was missing or unclear on the site>"}',
    messages: [
      { role: 'user', content: `CURRENT KNOWLEDGE BASE:\n${currentText || '(empty)'}\n\nSCRAPED PAGES:\n${pagesBlock}` },
    ],
  });

  // Find the first actual text block rather than assuming content[0] is one
  // (a response can in principle include other block types first).
  const textBlock = (completion.content || []).find((b) => b.type === 'text');
  let raw = (textBlock?.text || '').trim();
  // Strip a markdown code fence if the model added one despite instructions
  // not to, rather than letting that alone break the JSON parse below.
  if (raw.startsWith('```')) {
    raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  }
  if (!raw) raw = '{}';

  console.log(`[draftKnowledgeFromPages] ${client.clientId}: raw model output (first 500 chars): ${raw.slice(0, 500)}`);

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { draftText: currentText, summary: `Could not parse a clean draft. Raw model output: ${raw.slice(0, 300)}`, failed: true };
  }

  const draftText = typeof parsed.draftText === 'string' ? parsed.draftText.trim() : '';
  if (!draftText) {
    // The model returned parseable JSON but with nothing usable in it — treat
    // this as a real failure instead of silently reporting success with
    // empty (or unchanged) content, so the dashboard shows an honest error.
    return {
      draftText: currentText,
      summary: 'The AI returned an empty draft — nothing was saved. This usually means the scraped pages had too little usable text, or a temporary API issue. Try scraping again.',
      failed: true,
    };
  }

  return { draftText, summary: parsed.summary || `Drafted from ${pages.length} page(s).` };
}

function appendJsonl(dir, clientId, entry) {
  fs.appendFileSync(path.join(dir, `${clientId}.jsonl`), JSON.stringify(entry) + '\n');
}

function buildSystemPrompt(client, question) {
  const chunks = topChunks(client.clientId, question, 3);
  const context = chunks.length ? chunks.join('\n\n') : '(no matching info found in the knowledge base)';
  return client.systemPromptTemplate
    .replace('{{businessName}}', client.businessName)
    .replace('{{context}}', context);
}

function looksLikeFallback(replyText) {
  const flags = ["i don't know", "i'm not sure", "not sure about that", 'connect you with', 'connect with a person'];
  const lower = replyText.toLowerCase();
  return flags.some((f) => lower.includes(f));
}

// ---------- abuse protection & cost visibility ----------
//
// Two separate, deliberately different-shaped protections:
//
// 1. A per-visitor rate limit — stops one browser/bot from hammering a
//    client's chat with requests. This BLOCKS: once someone goes over the
//    limit, they get a "slow down" message instead of a real (paid-for)
//    answer, until the window passes. This is about abuse, not cost.
//
// 2. A per-client daily volume alert — this does NOT block anything. Real
//    customers should never be turned away because their business is
//    having a busy day. It just pings you (the same webhook used for other
//    alerts) once, the first time a client crosses an unusually high
//    number of messages in a day, so a real traffic spike (or a client
//    getting spammed from many different IPs, which the rate limit above
//    can't catch) shows up on your radar instead of silently costing you
//    money until the next time you happen to check.
//
// Both live in memory only (they reset if the server restarts) — that's
// fine here, since the goal is catching abuse/spikes as they happen, not
// keeping a permanent record. Permanent records already exist separately,
// in analytics/*.jsonl.

const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_PER_WINDOW = 12; // ~1 message every 5 seconds, sustained — generous for a real person typing
const rateLimitHits = new Map(); // key: `${clientId}:${ip}` -> array of request timestamps (ms)

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

function isRateLimited(clientId, ip) {
  const key = `${clientId}:${ip}`;
  const now = Date.now();
  const hits = (rateLimitHits.get(key) || []).filter((ts) => now - ts < RATE_LIMIT_WINDOW_MS);
  hits.push(now);
  rateLimitHits.set(key, hits);
  return hits.length > RATE_LIMIT_MAX_PER_WINDOW;
}

// occasionally sweep old entries so this Map can't grow forever on a
// long-running server with lots of distinct visitors
setInterval(() => {
  const now = Date.now();
  for (const [key, hits] of rateLimitHits.entries()) {
    const fresh = hits.filter((ts) => now - ts < RATE_LIMIT_WINDOW_MS);
    if (fresh.length) rateLimitHits.set(key, fresh);
    else rateLimitHits.delete(key);
  }
}, 5 * 60 * 1000).unref();

// Default daily message count, per client, that triggers one alert. Override
// per-deployment with the DAILY_MESSAGE_ALERT_THRESHOLD env var if a
// business's normal volume is naturally higher or lower than this.
const DAILY_MESSAGE_ALERT_THRESHOLD = Number(process.env.DAILY_MESSAGE_ALERT_THRESHOLD) || 300;
const dailyVolume = new Map(); // key: clientId -> { date: 'YYYY-MM-DD', count, alerted }

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

async function trackDailyVolumeAndAlert(client) {
  const today = todayKey();
  let entry = dailyVolume.get(client.clientId);
  if (!entry || entry.date !== today) entry = { date: today, count: 0, alerted: false };
  entry.count += 1;
  dailyVolume.set(client.clientId, entry);

  if (entry.count === DAILY_MESSAGE_ALERT_THRESHOLD && !entry.alerted) {
    entry.alerted = true;
    await postWebhook(
      notifyUrl(client),
      `📈 Heads up: ${client.businessName} has crossed ${DAILY_MESSAGE_ALERT_THRESHOLD} chat messages today — well above a typical day. Worth a quick look at the dashboard in case it's a spike worth knowing about (or something to pause if it looks like spam).`
    );
  }
}

// ---------- 4. streaming chat, with 1/2/3 built in ----------

app.post('/api/chat/stream', async (req, res) => {
  const { clientId, sessionId, message, history } = req.body || {};
  if (!clientId || !sessionId || !message) {
    return res.status(400).json({ error: 'clientId, sessionId, and message are required' });
  }

  const client = loadClient(clientId);
  if (!client) return res.status(404).json({ error: `Unknown clientId "${clientId}"` });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  // Paused clients (stopped paying, offboarded, etc.) get a plain "not
  // available" message instead of a real answer — no API call is made, so
  // pausing a client also stops costing you anything for their traffic. The
  // widget itself stays on the client's site either way; this is the actual
  // remote off-switch, since you can't remove code from their site yourself.
  if (isClientPaused(client)) {
    const reply = "This chat isn't available right now. Please contact us directly.";
    send('delta', { text: reply });
    appendJsonl(ANALYTICS_DIR, clientId, { ts: Date.now(), sessionId, question: message, reply, fallback: false, paused: true });
    send('done', { captureLead: false });
    return res.end();
  }

  // Abuse protection: one visitor sending far more messages than a real
  // person could type gets slowed down instead of getting a real (paid-for)
  // answer every time. No AI call happens for a rate-limited message.
  if (isRateLimited(clientId, clientIp(req))) {
    const reply = "You're sending messages a little too fast — please wait a moment and try again.";
    send('delta', { text: reply });
    send('done', { captureLead: false });
    return res.end();
  }
  trackDailyVolumeAndAlert(client).catch(() => {});

  if (!process.env.ANTHROPIC_API_KEY) {
    const reply = `(demo mode — no API key set) Thanks for asking! Once this is connected to a live model, I'll answer using ${client.businessName}'s real info.`;
    for (const word of reply.split(' ')) {
      send('delta', { text: word + ' ' });
      await new Promise((r) => setTimeout(r, 25));
    }
    appendJsonl(ANALYTICS_DIR, clientId, { ts: Date.now(), sessionId, question: message, reply, fallback: false, demo: true });
    send('done', { captureLead: false });
    return res.end();
  }

  try {
    // 1. memory: recent turns come from the widget, capped so tokens stay bounded
    const trimmedHistory = Array.isArray(history) ? history.slice(-10) : [];
    const messages = [...trimmedHistory, { role: 'user', content: message }];

    // 3. retrieval: only the relevant knowledge-base chunks go into the system prompt
    const system = buildSystemPrompt(client, message);

    const stream = anthropic.messages.stream({
      model: 'claude-sonnet-5',
      max_tokens: 400,
      system,
      messages,
    });

    let fullText = '';
    stream.on('text', (delta) => {
      fullText += delta;
      send('delta', { text: delta });
    });

    await stream.finalMessage();

    // 2. lead capture: strip the model's marker, tell the widget whether to show the form
    const captureLead = fullText.includes('[[CAPTURE_LEAD]]');
    const cleanText = fullText.replace('[[CAPTURE_LEAD]]', '').trim();
    const fallback = captureLead || looksLikeFallback(cleanText);

    appendJsonl(ANALYTICS_DIR, clientId, { ts: Date.now(), sessionId, question: message, reply: cleanText, fallback });
    send('done', { captureLead });
    res.end();
  } catch (err) {
    console.error(err);
    send('error', { message: 'Something went wrong generating a reply.' });
    res.end();
  }
});

// non-streaming fallback (same logic, one-shot JSON) — useful for testing with curl
app.post('/api/chat', async (req, res) => {
  const { clientId, sessionId, message, history } = req.body || {};
  if (!clientId || !sessionId || !message) {
    return res.status(400).json({ error: 'clientId, sessionId, and message are required' });
  }
  const client = loadClient(clientId);
  if (!client) return res.status(404).json({ error: `Unknown clientId "${clientId}"` });

  if (isClientPaused(client)) {
    const reply = "This chat isn't available right now. Please contact us directly.";
    appendJsonl(ANALYTICS_DIR, clientId, { ts: Date.now(), sessionId, question: message, reply, fallback: false, paused: true });
    return res.json({ reply, captureLead: false });
  }

  if (isRateLimited(clientId, clientIp(req))) {
    return res.json({ reply: "You're sending messages a little too fast — please wait a moment and try again.", captureLead: false });
  }
  trackDailyVolumeAndAlert(client).catch(() => {});

  if (!process.env.ANTHROPIC_API_KEY) {
    const reply = `(demo mode — no API key set) Thanks for your message!`;
    appendJsonl(ANALYTICS_DIR, clientId, { ts: Date.now(), sessionId, question: message, reply, fallback: false, demo: true });
    return res.json({ reply, captureLead: false });
  }

  try {
    const trimmedHistory = Array.isArray(history) ? history.slice(-10) : [];
    const system = buildSystemPrompt(client, message);
    const completion = await anthropic.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 400,
      system,
      messages: [...trimmedHistory, { role: 'user', content: message }],
    });
    const fullText = completion.content?.[0]?.text?.trim() || '';
    const captureLead = fullText.includes('[[CAPTURE_LEAD]]');
    const cleanText = fullText.replace('[[CAPTURE_LEAD]]', '').trim();
    const fallback = captureLead || looksLikeFallback(cleanText);
    appendJsonl(ANALYTICS_DIR, clientId, { ts: Date.now(), sessionId, question: message, reply: cleanText, fallback });
    res.json({ reply: cleanText, captureLead });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong generating a reply.' });
  }
});

// ---------- 2. lead capture submission ----------

app.post('/api/lead', (req, res) => {
  const { clientId, sessionId, name, contact, note } = req.body || {};
  if (!clientId || !contact) return res.status(400).json({ error: 'clientId and contact are required' });
  appendJsonl(LEADS_DIR, clientId, { ts: Date.now(), sessionId, name: name || '', contact, note: note || '' });
  res.json({ ok: true });
});

app.get('/api/leads', requireAdminAuth, (req, res) => {
  const { clientId } = req.query;
  if (!clientId) return res.status(400).json({ error: 'clientId is required' });
  res.json(readJsonl(LEADS_DIR, clientId).reverse());
});

// ---------- 6. human handoff ----------

app.post('/api/handoff', async (req, res) => {
  const { clientId, sessionId, reason, transcript } = req.body || {};
  if (!clientId || !sessionId) return res.status(400).json({ error: 'clientId and sessionId are required' });

  const entry = { ts: Date.now(), sessionId, reason: reason || 'visitor requested a person', transcript: transcript || [] };
  appendJsonl(HANDOFFS_DIR, clientId, entry);

  const client = loadClient(clientId);
  if (client && client.handoffWebhookUrl) {
    try {
      await fetch(client.handoffWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: `New chat handoff for ${client.businessName} — session ${sessionId}: ${entry.reason}`,
        }),
      });
    } catch (err) {
      console.error('Handoff webhook failed:', err.message);
    }
  }
  res.json({ ok: true });
});

app.get('/api/handoffs', requireAdminAuth, (req, res) => {
  const { clientId } = req.query;
  if (!clientId) return res.status(400).json({ error: 'clientId is required' });
  res.json(readJsonl(HANDOFFS_DIR, clientId).reverse());
});

// ---------- analytics ----------

app.get('/api/stats', (req, res) => {
  const { clientId } = req.query;
  if (!clientId) return res.status(400).json({ error: 'clientId is required' });
  res.json(computeStats(clientId));
});

// ---------- automated monthly report ----------

app.get('/api/clients/:id/report', async (req, res) => {
  const client = loadClient(req.params.id);
  if (!client) return res.status(404).json({ error: `Unknown clientId "${req.params.id}"` });

  const report = buildReport(client);
  if (req.query.save === 'true') {
    saveReport(client.clientId, report);
    if (req.query.notify === 'true') await sendReportWebhook(client, report);
  }
  res.json(report);
});

app.get('/api/clients/:id/reports', (req, res) => {
  res.json(listSavedReports(req.params.id));
});

// ---------- AI-assisted knowledge editing (draft, human approves before saving) ----------

app.post('/api/clients/:id/knowledge/draft', async (req, res) => {
  const { instruction } = req.body || {};
  if (!instruction) return res.status(400).json({ error: 'instruction is required' });

  const client = loadClient(req.params.id);
  if (!client) return res.status(404).json({ error: `Unknown clientId "${req.params.id}"` });

  const currentText = readKnowledge(client.clientId);

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.json({
      draftText: currentText,
      summary: '(demo mode — no API key set) Add your Anthropic key to draft real edits.',
    });
  }

  try {
    const completion = await anthropic.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 1500,
      system:
        "You maintain a business's chatbot knowledge base. It's a plain-text file, one paragraph " +
        'per fact/topic, written in third person, factual, no marketing language. You will be given ' +
        "the CURRENT knowledge base and an INSTRUCTION (often a client's raw email or message). " +
        'Update the knowledge base to reflect the instruction: edit the relevant paragraph if one ' +
        'exists, add a new paragraph if it introduces a new topic, and leave everything else ' +
        'untouched. Reply with strict JSON only, no markdown fences: ' +
        '{"draftText": "<the full updated knowledge base>", "summary": "<one sentence describing exactly what changed>"}',
      messages: [
        {
          role: 'user',
          content: `CURRENT KNOWLEDGE BASE:\n${currentText || '(empty)'}\n\nINSTRUCTION:\n${instruction}`,
        },
      ],
    });

    const raw = completion.content?.[0]?.text?.trim() || '{}';
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // model didn't return clean JSON — hand back the raw text as the summary rather than fail silently
      return res.json({ draftText: currentText, summary: `Could not parse a clean draft. Raw model output: ${raw.slice(0, 300)}`, applied: false });
    }

    const draftText = parsed.draftText || currentText;
    const summary = parsed.summary || 'No summary provided.';

    if (client.autoApplyKnowledgeEdits && draftText !== currentText) {
      writeKnowledge(client.clientId, draftText, { source: 'draft-auto', summary });
      await postWebhook(
        notifyUrl(client),
        `✅ ${client.businessName}'s knowledge base was auto-updated from your instruction.\n` +
          `Change: ${summary}\n` +
          `Undo anytime in admin.html ("Recent changes") or POST /api/clients/${client.clientId}/knowledge/rollback.`
      );
      return res.json({ draftText, summary, applied: true });
    }

    res.json({ draftText, summary, applied: false });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong drafting the update.' });
  }
});

// ---------- AI-assisted knowledge base from a website scrape (draft, human approves) ----------

app.post('/api/clients/:id/knowledge/scrape', async (req, res) => {
  // accepts either { urls: [...] } (one or more sites — main site, FAQ site,
  // support subdomain, whatever) or the older single { url } for compatibility
  const body = req.body || {};
  const urls = Array.isArray(body.urls) ? body.urls : body.url ? [body.url] : [];
  const cleanUrls = urls.map((u) => (u || '').trim()).filter(Boolean);
  if (!cleanUrls.length) return res.status(400).json({ error: 'At least one url is required' });

  for (const u of cleanUrls) {
    try {
      new URL(u);
    } catch {
      return res.status(400).json({ error: `"${u}" doesn't look like a valid URL. Include the https://.` });
    }
  }

  const client = loadClient(req.params.id);
  if (!client) return res.status(404).json({ error: `Unknown clientId "${req.params.id}"` });

  let pages;
  try {
    pages = await crawlSites(cleanUrls, body.maxPagesPerSite || 12);
  } catch (err) {
    console.error(err);
    return res.status(400).json({ error: `Could not reach or crawl those site(s). Check the URL(s) and try again.` });
  }

  if (!pages.length) {
    return res.status(400).json({
      error: `Crawled ${cleanUrls.join(', ')} but found no readable page text. The site(s) may block bots, redirect oddly, or render content with JavaScript (this scraper only sees server-rendered HTML).`,
    });
  }

  // remember the site(s) so the fallback-rate watchdog can re-scrape them later without being told again
  mergeWebsiteUrls(client, cleanUrls);
  saveClient(client);

  const currentText = readKnowledge(client.clientId);
  const siteCount = cleanUrls.length;
  const siteLabel = siteCount === 1 ? cleanUrls[0] : `${siteCount} sites (${cleanUrls.join(', ')})`;

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.json({
      draftText: currentText,
      summary: `(demo mode — no API key set) Crawled ${pages.length} page(s) across ${siteCount} site(s) but can't draft without a key.`,
      pagesScraped: pages.map((p) => p.url),
      applied: false,
    });
  }

  try {
    const { draftText, summary, failed } = await draftKnowledgeFromPages(client, pages, currentText);

    if (failed) {
      // A real drafting failure — never auto-apply, and say so plainly rather
      // than reporting success with nothing (or stale content) saved.
      return res.status(502).json({ error: summary, pagesScraped: pages.map((p) => p.url), applied: false });
    }

    if (client.autoApplyKnowledgeEdits && draftText !== currentText) {
      writeKnowledge(client.clientId, draftText, { source: 'scrape-auto', summary });
      await postWebhook(
        notifyUrl(client),
        `✅ ${client.businessName}'s knowledge base was auto-built from a scrape of ${siteLabel} (${pages.length} page(s) total).\n` +
          `${summary}\n` +
          `Undo anytime in admin.html ("Recent changes") or POST /api/clients/${client.clientId}/knowledge/rollback.`
      );
      return res.json({ draftText, summary, pagesScraped: pages.map((p) => p.url), applied: true });
    }

    res.json({ draftText, summary, pagesScraped: pages.map((p) => p.url), applied: false });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong drafting the knowledge base from the scrape.' });
  }
});

// ---------- one box, one URL: create a brand-new client end-to-end ----------
//
// This is the "just enter the URL" flow: creates the client record (guessing
// its name from the site), crawls the site, and drafts + (if autoApply is on)
// applies the knowledge base — all from a single call. Everything it does is
// exactly what the multi-step admin.html flow does by hand, just chained.

app.post('/api/clients', async (req, res) => {
  // Everything below is wrapped in one top-level try/catch: whatever else
  // goes wrong (a network hiccup, a site that responds in a shape we didn't
  // expect, anything), the request still always gets back a real JSON
  // response instead of hanging or crashing — so the dashboard can always
  // show a real message instead of the generic "something went wrong".
  try {
    // `url` is the primary site (used to name the client). `extraUrls` is
    // optional — additional sites to crawl right away, like a separate FAQ
    // or support site. More can always be added later via the scrape panel.
    const { url, extraUrls, autoApply } = req.body || {};
    if (!url) return res.status(400).json({ error: 'url is required' });

    let parsed;
    try {
      parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('bad protocol');
    } catch {
      return res.status(400).json({ error: `"${url}" doesn't look like a valid website URL. Include the https://.` });
    }
    const siteUrl = parsed.toString();
    const cleanExtraUrls = (Array.isArray(extraUrls) ? extraUrls : []).map((u) => (u || '').trim()).filter(Boolean);
    const allUrls = [siteUrl, ...cleanExtraUrls];

    const homepageHtml = await fetchHomepage(siteUrl).catch(() => null);
    const businessName = (homepageHtml && guessBusinessName(homepageHtml)) || parsed.hostname.replace(/^www\./, '');
    const clientId = uniqueClientId(slugify(businessName));

    const client = {
      clientId,
      businessName,
      brandColor: '#2563eb',
      handoffWebhookUrl: '',
      reportWebhookUrl: '',
      knowledgeWebhookUrl: '',
      fallbackAlertThreshold: 0.15,
      autoApplyKnowledgeEdits: autoApply !== false, // defaults on for this "just works" flow
      websiteUrls: allUrls,
      systemPromptTemplate: DEFAULT_SYSTEM_PROMPT_TEMPLATE,
    };
    saveClient(client);

    let pages = [];
    try {
      pages = await crawlSites(allUrls, 12);
    } catch (err) {
      console.error(err);
      return res.json({ client, built: false, error: `Created "${businessName}", but couldn't crawl ${allUrls.join(', ')}. You can retry the scrape from admin.html.` });
    }

    if (!pages.length) {
      return res.json({
        client,
        built: false,
        error: `Created "${businessName}", but found no readable page text at ${allUrls.join(', ')}. The site(s) may block bots or be JS-rendered — you'll need to add the knowledge base by hand or retry from admin.html.`,
      });
    }

    if (!process.env.ANTHROPIC_API_KEY) {
      return res.json({
        client,
        built: false,
        pagesScraped: pages.map((p) => p.url),
        summary: '(demo mode — no API key set) Client created and site crawled, but drafting needs a key.',
      });
    }

    try {
      const { draftText, summary, failed } = await draftKnowledgeFromPages(client, pages, '');

      if (failed) {
        // Same real-failure case as the scrape endpoint — never write empty
        // content and never report built:true when nothing usable came back.
        return res.json({
          client,
          built: false,
          pagesScraped: pages.map((p) => p.url),
          error: `Created "${businessName}" and crawled the site, but ${summary.charAt(0).toLowerCase()}${summary.slice(1)} You can retry the scrape from admin.html, or add the knowledge base by hand.`,
        });
      }

      if (client.autoApplyKnowledgeEdits) {
        writeKnowledge(client.clientId, draftText, { source: 'scrape-auto', summary: `Initial build: ${summary}` });
        return res.json({ client, built: true, pagesScraped: pages.map((p) => p.url), summary });
      }
      res.json({ client, built: false, draftText, pagesScraped: pages.map((p) => p.url), summary, needsReview: true });
    } catch (err) {
      console.error(err);
      res.json({
        client,
        built: false,
        pagesScraped: pages.map((p) => p.url),
        error: 'Client created and site crawled, but drafting the knowledge base failed — retry the scrape from admin.html.',
      });
    }
  } catch (err) {
    console.error('Unexpected error in POST /api/clients:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: `Something unexpected went wrong creating that client: ${err && err.message ? err.message : 'unknown error'}. Please try again.` });
    }
  }
});

// ---------- 5. admin: multi-client management ----------

app.get('/api/clients', (req, res) => {
  res.json(
    listClients().map((c) => ({
      clientId: c.clientId,
      businessName: c.businessName,
      brandColor: c.brandColor,
      status: c.status === 'paused' ? 'paused' : 'active',
    }))
  );
});

app.get('/api/clients/:id', (req, res) => {
  const client = loadClient(req.params.id);
  if (!client) return res.status(404).json({ error: `Unknown clientId "${req.params.id}"` });
  res.json({ ...client, websiteUrls: clientWebsiteUrls(client), status: client.status === 'paused' ? 'paused' : 'active' });
});

// Pause or resume a client's chatbot without touching any code on their
// website. Paused = the widget stays wherever it's embedded, but every
// question just gets a plain "not available" reply instead of a real
// answer, and no AI API call (and no cost) happens. This is the actual
// "take the product back" lever if a client stops paying — the widget's
// script tag lives on THEIR site, so you can't remove it yourself, but you
// fully control what it's allowed to say.
app.post('/api/clients/:id/status', (req, res) => {
  const { status } = req.body || {};
  if (status !== 'active' && status !== 'paused') {
    return res.status(400).json({ error: 'status must be "active" or "paused"' });
  }
  const client = loadClient(req.params.id);
  if (!client) return res.status(404).json({ error: `Unknown clientId "${req.params.id}"` });
  client.status = status;
  saveClient(client);
  res.json({ ok: true, status });
});

// Rename a client — just changes the display name (c.businessName), never
// the clientId, so the embed code already on their site keeps working.
app.post('/api/clients/:id/rename', (req, res) => {
  const { businessName } = req.body || {};
  const clean = typeof businessName === 'string' ? businessName.trim() : '';
  if (!clean) return res.status(400).json({ error: 'businessName is required' });
  const client = loadClient(req.params.id);
  if (!client) return res.status(404).json({ error: `Unknown clientId "${req.params.id}"` });
  client.businessName = clean;
  saveClient(client);
  res.json({ ok: true, businessName: clean });
});

app.get('/api/clients/:id/knowledge', (req, res) => {
  res.json({ text: readKnowledge(req.params.id) });
});

app.post('/api/clients/:id/knowledge', (req, res) => {
  const { text } = req.body || {};
  if (typeof text !== 'string') return res.status(400).json({ error: 'text is required' });
  writeKnowledge(req.params.id, text, { source: 'manual', summary: 'Manual edit via admin dashboard' });
  res.json({ ok: true });
});

app.get('/api/clients/:id/knowledge/changelog', (req, res) => {
  res.json(knowledgeChangelog(req.params.id));
});

app.post('/api/clients/:id/knowledge/rollback', (req, res) => {
  const result = rollbackKnowledge(req.params.id);
  if (!result.ok) return res.status(400).json(result);
  res.json({ ok: true, text: readKnowledge(req.params.id) });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Sitewright chatbot kit running at http://localhost:${PORT}`);
  if (!ADMIN_PASSWORD) {
    console.warn(
      '\n⚠️  ADMIN_PASSWORD is not set — admin.html and every client\'s data are open to anyone with this URL.\n' +
        '   Set ADMIN_PASSWORD as an environment variable before this is reachable by anyone but you.\n'
    );
  }
});
