/**
 * Runs the automated maintenance tasks: monthly reports + daily fallback-rate
 * checks, for every client. Two ways to use it:
 *
 *   node scheduler.js --now      run everything once, right now, then exit
 *                                 (use this to test, or trigger from a
 *                                 platform's own cron/scheduled-job feature)
 *
 *   node scheduler.js            stay running and fire on a schedule:
 *                                 reports on the 1st of each month at 9am,
 *                                 fallback checks daily at 9am
 *                                 (needs `npm install node-cron` first)
 *
 * Either way, this reads the same clients/*.json and analytics/*.jsonl files
 * the live server uses — nothing needs to be running at the same time.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { buildReport, saveReport, sendReportWebhook } = require('./lib/report');
const { checkClient } = require('./lib/alerts');
const { dataPath } = require('./lib/paths');

const CLIENTS_DIR = dataPath('clients');

function listClients() {
  if (!fs.existsSync(CLIENTS_DIR)) return [];
  return fs.readdirSync(CLIENTS_DIR).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(CLIENTS_DIR, f), 'utf8')));
}

async function runMonthlyReports() {
  const clients = listClients();
  for (const client of clients) {
    const report = buildReport(client);
    saveReport(client.clientId, report);
    await sendReportWebhook(client, report);
    console.log(`[reports] ${client.clientId}: saved ${report.period} report (${report.stats.totalConversations} conversations)`);
  }
}

async function runFallbackChecks() {
  const clients = listClients();
  for (const client of clients) {
    const result = await checkClient(client);
    if (result.alerted) {
      console.log(`[alerts] ${client.clientId}: ALERTED — ${result.message}`);
    } else {
      console.log(`[alerts] ${client.clientId}: ok (${result.reason})`);
    }
  }
}

async function runOnce() {
  console.log('Running monthly reports + fallback checks for all clients...\n');
  await runMonthlyReports();
  await runFallbackChecks();
  console.log('\nDone.');
}

if (process.argv.includes('--now')) {
  runOnce().then(() => process.exit(0));
} else {
  let cron;
  try {
    cron = require('node-cron');
  } catch {
    console.error('node-cron is not installed. Run: npm install node-cron');
    console.error('Or use `node scheduler.js --now` to run once without it (good for testing, or for a platform-level cron job).');
    process.exit(1);
  }

  console.log('Scheduler running: monthly reports on the 1st at 9am, fallback checks daily at 9am.');
  cron.schedule('0 9 1 * *', runMonthlyReports);
  cron.schedule('0 9 * * *', runFallbackChecks);
}
