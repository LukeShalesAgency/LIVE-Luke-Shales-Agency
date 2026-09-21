/**
 * lib/paths.js
 *
 * Every folder the app writes to (clients/, knowledge/, analytics/, leads/,
 * handoffs/, reports/) needs to live under ONE directory so a single Render
 * persistent disk — which mounts at exactly one path — can cover all of it.
 *
 * Locally (no DATA_DIR set), everything stays exactly where it's always
 * been: right in the project folder, so nothing changes for local dev/testing.
 *
 * In production, set the DATA_DIR environment variable to wherever your
 * persistent disk is mounted (e.g. /var/data) and every one of these folders
 * automatically moves onto that disk — surviving deploys instead of being
 * wiped by them.
 */

const path = require('path');
const fs = require('fs');

const DATA_ROOT = process.env.DATA_DIR || path.join(__dirname, '..');

function dataPath(...segments) {
  const full = path.join(DATA_ROOT, ...segments);
  return full;
}

// convenience: get-or-create a directory under DATA_ROOT
//
// Several of these (reports/, analytics/, leads/, handoffs/) get created at
// module-load time, before the server has even started listening — so a
// failure here used to throw straight out of `require(...)` and crash the
// ENTIRE app on startup (no chat, no knowledge base, nothing), even though
// only one minor feature (say, monthly reports) was actually affected. A
// single unwritable folder should never be able to take the whole app down,
// so this now logs a loud warning and keeps going instead of throwing —
// whatever feature actually needs that folder will surface its own clear
// error when it's used, instead of the whole server refusing to start.
function ensureDir(...segments) {
  const dir = dataPath(...segments);
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    console.error(
      `⚠️  Could not create data folder "${dir}" (${err.code || err.message}). ` +
        'The app will keep starting, but anything that reads/writes this folder will fail until this is fixed — ' +
        'check that your persistent disk is mounted and writable at DATA_DIR.'
    );
  }
  return dir;
}

module.exports = { DATA_ROOT, dataPath, ensureDir };
