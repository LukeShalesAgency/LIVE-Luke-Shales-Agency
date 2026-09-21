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
function ensureDir(...segments) {
  const dir = dataPath(...segments);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

module.exports = { DATA_ROOT, dataPath, ensureDir };
