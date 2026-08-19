'use strict';

/**
 * End-to-end smoke test.
 *
 * Runs the *real* main process — its IPC handlers, its local HTTP origin, its
 * store — and drives the *real* renderer bundle, against the Firebase
 * emulators. That combination is the point: every user-facing breakage so far
 * (an unlaunchable package, signup dying on a permission check, sign-in blocked
 * by CSP, sessions lost to a moving origin) lived in the wiring between pieces
 * that unit tests exercise happily in isolation.
 *
 * Runs in two phases, as two separate processes sharing one profile directory:
 *
 *   signup  — create an account, open a conversation, send a message
 *   restore — relaunch and check the session, conversations and history came back
 *
 * The split is the whole point of the second phase. An earlier version simply
 * recreated the window inside one process, which kept the same origin and so
 * passed happily even with the ephemeral-port bug that lost people's sessions in
 * the first place. Only a real process restart exercises what a user does.
 *
 * Run with `npm run test:e2e`, which orchestrates both phases.
 */

const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const results = [];
const ok = (name, condition, detail = '') =>
  results.push([condition ? 'PASS' : 'FAIL', condition ? name : `${name}${detail ? ` — ${detail}` : ''}`]);

const cspViolations = [];
const rendererErrors = [];

/** Poll until the page reports what we're waiting for, or give up. */
async function waitFor(win, expression, { timeout = 20000, label = expression } = {}) {
  const started = Date.now();
  for (;;) {
    let value = false;
    try {
      value = await win.webContents.executeJavaScript(`(() => { try { return ${expression}; } catch { return false; } })()`);
    } catch {
      // Page mid-navigation; try again.
    }
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

const visibleScreen = `(['setup','auth','finish','chat'].find(id => !document.getElementById(id).classList.contains('hidden')) || null)`;

function watch(win) {
  win.webContents.on('console-message', (event) => {
    const text = String(event.message);
    if (/Content Security Policy|violates/i.test(text)) cspViolations.push(text.slice(0, 200));
    else if (event.level === 'error') rendererErrors.push(text.slice(0, 200));
  });
}

async function typeInto(win, id, value) {
  await win.webContents.executeJavaScript(`(() => {
    const el = document.getElementById(${JSON.stringify(id)});
    el.value = ${JSON.stringify(value)};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
}

const click = (win, id) =>
  win.webContents.executeJavaScript(`(document.getElementById(${JSON.stringify(id)}).click(), true)`);

const PHASE = process.argv[process.argv.length - 1];
const STATE_FILE = process.env.TETHER_E2E_STATE;

const readState = () => JSON.parse(require('node:fs').readFileSync(STATE_FILE, 'utf8'));
const writeState = (state) => require('node:fs').writeFileSync(STATE_FILE, JSON.stringify(state));

/** Checks that apply on every launch, whatever the phase. */
async function checkLaunch(win) {
  ok('app reaches a usable screen', ['auth', 'chat'].includes(await waitFor(win, visibleScreen, { label: 'a screen' })));

  const origin = await win.webContents.executeJavaScript('location.origin');
  ok('renderer is served over http', origin.startsWith('http://localhost:'), origin);
  ok('renderer origin uses the fixed port', origin.endsWith(':47821'), origin);
  ok('preload bridge is available', await win.webContents.executeJavaScript('typeof window.tether === "object"'));
  return origin;
}

/** Phase 1: sign up, open a conversation, send a message. */
async function phaseSignup(win) {
  const stamp = Date.now();
  const account = {
    username: `probe${String(stamp).slice(-6)}`,
    email: `probe${stamp}@example.com`,
    password: 'test-password-123',
    peerUsername: `peer${String(stamp).slice(-6)}`,
    // Deliberately non-overlapping: if the edited text contained the original
    // as a substring, "the original is gone" would match itself and pass
    // whatever the app did.
    message: 'first draft of the message',
    editedMessage: 'completely rewritten wording',
    doomedMessage: 'this one gets removed',
  };

  const origin = await checkLaunch(win);
  writeState({ ...account, origin });

  await typeInto(win, 'username', account.username);
  await typeInto(win, 'email', account.email);
  await typeInto(win, 'password', account.password);
  await click(win, 'auth-submit');

  const screen = await waitFor(win, visibleScreen + ' === "chat" ? "chat" : false', {
    label: 'the chat screen after signup',
    timeout: 30000,
  }).catch(async () => {
    const err = await win.webContents.executeJavaScript('document.getElementById("auth-error").textContent');
    throw new Error(`signup did not reach chat (auth error: ${err || 'none'})`);
  });
  ok('signup signs the user in', screen === 'chat');

  ok('username is claimed and shown',
    (await win.webContents.executeJavaScript('document.getElementById("my-username").textContent')).includes(account.username));

  // Talking to yourself is refused, so create a second real account to message.
  // Seeded through the emulators' REST APIs rather than a hook in the app, so
  // nothing test-only ships in the renderer.
  const peerUid = await createEmulatorUser(`peer${stamp}@example.com`);
  ok('second account created for the conversation', Boolean(peerUid), String(peerUid));

  await seedDoc(`usernames/${account.peerUsername}`, { uid: { stringValue: peerUid } });
  await seedDoc(`users/${peerUid}`, { username: { stringValue: account.peerUsername } });

  await typeInto(win, 'peer-input', account.peerUsername);
  await win.webContents.executeJavaScript(`document.getElementById('peer-form').requestSubmit()`);

  ok('conversation opens by username',
    await waitFor(win, `document.querySelectorAll('#thread-list li').length > 0`, { label: 'a conversation in the sidebar' }));

  await typeInto(win, 'input', account.message);
  await win.webContents.executeJavaScript(`document.getElementById('composer').requestSubmit()`);

  ok('message appears in the thread',
    await waitFor(win, `[...document.querySelectorAll('#messages .msg')].some(n => n.textContent.includes(${JSON.stringify(account.message)}))`,
      { label: 'the sent message' }));

  // --- editing and deleting your own messages --------------------------
  const hasText = (text) =>
    `[...document.querySelectorAll('#messages .msg')].some(n => n.textContent.includes(${JSON.stringify(text)}))`;

  ok('own messages offer edit and delete',
    await waitFor(win, `document.querySelectorAll('#messages .msg.mine .actions button').length >= 2`,
      { label: 'message actions' }));

  // Edit: click Edit, change the text, submit.
  await win.webContents.executeJavaScript(
    `([...document.querySelectorAll('#messages .msg.mine .actions button')].find(b => b.textContent === 'Edit').click(), true)`
  );
  ok('editing preloads the existing text',
    await waitFor(win, `document.getElementById('input').value === ${JSON.stringify(account.message)}`,
      { label: 'the composer preloaded for editing' }));

  await typeInto(win, 'input', account.editedMessage);
  await win.webContents.executeJavaScript(`document.getElementById('composer').requestSubmit()`);

  ok('edit replaces the message text',
    await waitFor(win, hasText(account.editedMessage), { label: 'the edited message' }));
  ok('the original text is gone', !(await win.webContents.executeJavaScript(hasText(account.message))));
  ok('an edit is disclosed as edited',
    await waitFor(win, `[...document.querySelectorAll('#messages .msg .meta')].some(n => n.textContent.includes('edited'))`,
      { label: 'the edited marker' }));

  // Send a second message and delete it.
  await typeInto(win, 'input', account.doomedMessage);
  await win.webContents.executeJavaScript(`document.getElementById('composer').requestSubmit()`);
  ok('second message sends', await waitFor(win, hasText(account.doomedMessage), { label: 'the second message' }));

  await win.webContents.executeJavaScript(`(() => {
    const nodes = [...document.querySelectorAll('#messages .msg.mine')];
    const target = nodes.find(n => n.textContent.includes(${JSON.stringify(account.doomedMessage)}));
    [...target.querySelectorAll('.actions button')].find(b => b.textContent === 'Delete').click();
    return true;
  })()`);

  ok('delete removes the message from view',
    await waitFor(win, `!${hasText(account.doomedMessage)}`, { label: 'the deleted message to disappear' }));

  ok('no CSP violations while signing up and messaging', cspViolations.length === 0, cspViolations[0]);
  ok('no renderer errors while signing up and messaging', rendererErrors.length === 0, rendererErrors[0]);
}

/**
 * Phase 2, in a fresh process against the same profile: everything the user
 * expects to still be there.
 */
async function phaseRestore(win) {
  const state = readState();
  const origin = await checkLaunch(win);

  // If the origin moved, storage moved with it — which is precisely how the
  // session was being lost.
  ok('origin is identical to the previous launch', origin === state.origin, `${state.origin} -> ${origin}`);

  const screen = await waitFor(win, visibleScreen + ' === "chat" ? "chat" : false', {
    label: 'chat screen after restart (session persistence)',
    timeout: 30000,
  }).catch(() => null);
  ok('stays signed in across a real restart', screen === 'chat');

  if (screen !== 'chat') return;

  ok('still signed in as the same account',
    (await win.webContents.executeJavaScript('document.getElementById("my-username").textContent')).includes(state.username));

  ok('conversations are restored after a restart',
    await waitFor(win, `document.querySelectorAll('#thread-list li').length > 0`,
      { label: 'restored conversations', timeout: 20000 }).catch(() => false));

  // The edited text, not the original, is what must come back — and the
  // deleted message must stay gone. Local history is the only copy by now.
  ok('the edited message survives a restart',
    await waitFor(win, `(document.querySelector('#thread-list li')?.click(), true) &&
      [...document.querySelectorAll('#messages .msg')].some(n => n.textContent.includes(${JSON.stringify(state.editedMessage)}))`,
      { label: 'restored edited message', timeout: 20000 }).catch(() => false));

  ok('the pre-edit text does not come back',
    !(await win.webContents.executeJavaScript(
      `[...document.querySelectorAll('#messages .msg')].some(n => n.textContent.includes(${JSON.stringify(state.message)}) && !n.textContent.includes(${JSON.stringify(state.editedMessage)}))`
    )));

  ok('a deleted message stays deleted',
    !(await win.webContents.executeJavaScript(
      `[...document.querySelectorAll('#messages .msg')].some(n => n.textContent.includes(${JSON.stringify(state.doomedMessage)}))`
    )));

  ok('no CSP violations after restart', cspViolations.length === 0, cspViolations[0]);
}

async function run() {
  const win = await waitForWindow();
  watch(win);
  if (PHASE === 'signup') await phaseSignup(win);
  else if (PHASE === 'restore') await phaseRestore(win);
  else throw new Error(`unknown phase: ${PHASE}`);
  return results;
}

const PROJECT_ID = require('../config/firebase.config.default.json').projectId;

/** Create a user in the Auth emulator and return its uid. */
async function createEmulatorUser(email) {
  const res = await fetch(
    `http://${process.env.TETHER_AUTH_EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-api-key`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'test-password-123', returnSecureToken: true }),
    }
  );
  const data = await res.json();
  return data.localId ?? null;
}

/**
 * Write a document straight into the Firestore emulator. `Bearer owner` bypasses
 * security rules, which is what fixtures want — the rules themselves have their
 * own suites.
 */
async function seedDoc(docPath, fields) {
  const at = docPath.lastIndexOf('/');
  const collection = docPath.slice(0, at);
  const id = docPath.slice(at + 1);
  const res = await fetch(
    `http://${process.env.TETHER_FIRESTORE_EMULATOR}/v1/projects/${PROJECT_ID}/databases/(default)/documents/${collection}?documentId=${id}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' },
      body: JSON.stringify({ fields }),
    }
  );
  if (!res.ok) throw new Error(`seeding ${docPath} failed: ${res.status} ${await res.text()}`);
}

function waitForWindow() {
  return new Promise((resolve) => {
    const existing = BrowserWindow.getAllWindows()[0];
    if (existing) return resolve(existing);
    app.on('browser-window-created', (_e, win) => resolve(win));
  });
}

// Boot the real app, then drive it.
require('../main/index.js');

app.whenReady().then(async () => {
  let failed = 0;
  try {
    await run();
  } catch (err) {
    results.push(['FAIL', `harness error — ${err.message}`]);
  }
  for (const [status, name] of results) console.log(`${status}  [${PHASE}] ${name}`);
  failed = results.filter(([s]) => s === 'FAIL').length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  app.exit(failed ? 1 : 0);
});
