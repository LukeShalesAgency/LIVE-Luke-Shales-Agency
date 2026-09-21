/**
 * Shared stats logic — used by the live server's /api/stats endpoint AND by
 * the scheduler (report generation, fallback alerts), so both always agree.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ANALYTICS_DIR = path.join(ROOT, 'analytics');
const LEADS_DIR = path.join(ROOT, 'leads');
const HANDOFFS_DIR = path.join(ROOT, 'handoffs');

function readJsonl(dir, clientId) {
  const file = path.join(dir, `${clientId}.jsonl`);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/**
 * All-time stats (what /api/stats has always returned).
 */
function computeStats(clientId) {
  const entries = readJsonl(ANALYTICS_DIR, clientId);
  const sessions = new Set(entries.map((e) => e.sessionId));
  const fallbacks = entries.filter((e) => e.fallback).length;

  const counts = {};
  entries.forEach((e) => {
    const key = e.question.trim().toLowerCase().replace(/[?.!]+$/g, '');
    counts[key] = (counts[key] || 0) + 1;
  });
  const topQuestions = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([question, count]) => ({ question, count }));

  return {
    totalConversations: sessions.size,
    totalMessages: entries.length,
    fallbackRate: entries.length ? Math.round((fallbacks / entries.length) * 100) : 0,
    leadCount: readJsonl(LEADS_DIR, clientId).length,
    handoffCount: readJsonl(HANDOFFS_DIR, clientId).length,
    topQuestions,
  };
}

/**
 * Stats scoped to a date window — used for the monthly report, so "this
 * month's" numbers don't include everything since the bot went live.
 */
function computeStatsForWindow(clientId, sinceTs, untilTs) {
  const inWindow = (arr) => arr.filter((e) => e.ts >= sinceTs && e.ts < untilTs);

  const entries = inWindow(readJsonl(ANALYTICS_DIR, clientId));
  const leads = inWindow(readJsonl(LEADS_DIR, clientId));
  const handoffs = inWindow(readJsonl(HANDOFFS_DIR, clientId));

  const sessions = new Set(entries.map((e) => e.sessionId));
  const fallbacks = entries.filter((e) => e.fallback).length;

  const counts = {};
  entries.forEach((e) => {
    const key = e.question.trim().toLowerCase().replace(/[?.!]+$/g, '');
    counts[key] = (counts[key] || 0) + 1;
  });
  const topQuestions = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([question, count]) => ({ question, count }));

  const unresolved = entries.filter((e) => e.fallback).slice(0, 5).map((e) => e.question);

  return {
    totalConversations: sessions.size,
    totalMessages: entries.length,
    fallbackRate: entries.length ? Math.round((fallbacks / entries.length) * 100) : 0,
    leadCount: leads.length,
    handoffCount: handoffs.length,
    topQuestions,
    unresolvedQuestions: unresolved,
  };
}

module.exports = { computeStats, computeStatsForWindow, readJsonl, ANALYTICS_DIR, LEADS_DIR, HANDOFFS_DIR };
