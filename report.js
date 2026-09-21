/**
 * Monthly report generation — turns raw stats into the client-facing summary
 * that justifies the retainer, and saves a copy so past reports are never lost.
 */

const fs = require('fs');
const path = require('path');
const { computeStatsForWindow } = require('./stats');
const { ensureDir } = require('./paths');

const REPORTS_DIR = ensureDir('reports');

function monthLabel(date) {
  return date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

function startOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1).getTime();
}

/**
 * Builds the report for the month containing `atDate` (defaults to now —
 * i.e. "this month so far" when run mid-month, or the full prior month when
 * run on the 1st for the month that just ended).
 */
function buildReport(client, atDate = new Date()) {
  const since = startOfMonth(atDate);
  const until = new Date(atDate.getFullYear(), atDate.getMonth() + 1, 1).getTime();
  const stats = computeStatsForWindow(client.clientId, since, until);

  const lines = [];
  lines.push(`${client.businessName} — chatbot report for ${monthLabel(atDate)}`);
  lines.push('='.repeat(lines[0].length));
  lines.push('');
  lines.push(`Conversations:     ${stats.totalConversations}`);
  lines.push(`Messages handled:  ${stats.totalMessages}`);
  lines.push(`Resolved rate:     ${100 - stats.fallbackRate}%`);
  lines.push(`Leads captured:    ${stats.leadCount}`);
  lines.push(`Handed to a human: ${stats.handoffCount}`);
  lines.push('');

  if (stats.topQuestions.length) {
    lines.push('Most asked questions:');
    stats.topQuestions.forEach((q, i) => lines.push(`  ${i + 1}. ${q.question} (${q.count}x)`));
    lines.push('');
  }

  if (stats.unresolvedQuestions.length) {
    lines.push("Questions the bot couldn't fully answer (candidates to add to the knowledge base):");
    stats.unresolvedQuestions.forEach((q) => lines.push(`  - ${q}`));
    lines.push('');
  }

  if (stats.totalConversations === 0) {
    lines.push('No conversations yet this month.');
  }

  return { period: monthLabel(atDate), stats, text: lines.join('\n') };
}

function saveReport(clientId, report) {
  const dir = path.join(REPORTS_DIR, clientId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
  const slug = report.period.replace(/\s+/g, '-').toLowerCase();
  fs.writeFileSync(path.join(dir, `${slug}.txt`), report.text, 'utf8');
  fs.writeFileSync(path.join(dir, `${slug}.json`), JSON.stringify(report, null, 2), 'utf8');
}

function listSavedReports(clientId) {
  const dir = path.join(REPORTS_DIR, clientId);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.txt')).sort().reverse();
}

async function sendReportWebhook(client, report) {
  if (!client.reportWebhookUrl) return;
  try {
    await fetch(client.reportWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: `Monthly report for ${client.businessName} (${report.period}):\n\n${report.text}` }),
    });
  } catch (err) {
    console.error(`Report webhook failed for ${client.clientId}:`, err.message);
  }
}

module.exports = { buildReport, saveReport, listSavedReports, sendReportWebhook };
