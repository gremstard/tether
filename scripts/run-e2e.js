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

/**
 * CI runners do not have Chromium's SUID sandbox helper configured, and npm
 * cannot set it up. Disabling the sandbox is a concession to that environment
 * only — it is never set locally or in a shipped build, and it does not affect
 * anything these tests actually assert.
 */
const sandboxArgs = process.env.TETHER_E2E_NO_SANDBOX ? ['--no-sandbox'] : [];

let failed = 0;
for (const phase of ['signup', 'restore']) {
  const run = spawnSync(
    electron,
    [
      path.join(__dirname, '..', 'test', 'e2e.js'),
      `--user-data-dir=${profile}`,
      ...sandboxArgs,
      phase,
    ],
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
