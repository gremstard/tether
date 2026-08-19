'use strict';

/**
 * Orchestrates the end-to-end test.
 *
 * Runs the app twice as separate processes against one profile directory: the
 * second launch is a genuine restart, which is the only way to test that a
 * signed-in session, the conversation list and local history actually survive.
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tether-e2e-'));
const state = path.join(profile, 'state.json');
const electron = require('electron');

const env = {
  ...process.env,
  TETHER_AUTH_EMULATOR: process.env.TETHER_AUTH_EMULATOR ?? '127.0.0.1:9099',
  TETHER_FIRESTORE_EMULATOR: process.env.TETHER_FIRESTORE_EMULATOR ?? '127.0.0.1:8085',
  TETHER_E2E_STATE: state,
};

let failed = 0;
for (const phase of ['signup', 'restore']) {
  const run = spawnSync(
    electron,
    [path.join(__dirname, '..', 'test', 'e2e.js'), `--user-data-dir=${profile}`, phase],
    { stdio: 'inherit', env }
  );
  if (run.status !== 0) {
    failed = run.status ?? 1;
    // Still attempt the restore phase after a signup failure: how far it gets
    // is diagnostic in itself.
  }
}

fs.rmSync(profile, { recursive: true, force: true });
process.exit(failed);
