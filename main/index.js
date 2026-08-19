'use strict';

const { app, BrowserWindow, Notification, ipcMain, shell, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const { MessageStore } = require('./store.js');
const { encodeInvite, decodeInvite } = require('./invite.js');
const { startRendererServer, PREFERRED_PORT } = require('./server.js');
const { signInWithGoogle } = require('./google-auth.js');
const {
  createTray,
  getLaunchAtLogin,
  setLaunchAtLogin,
  startedHidden,
} = require('./tray.js');

const CONFIG_DIR = path.join(__dirname, '..', 'config');

/**
 * Where the app points itself.
 *
 * The shipped default is committed and travels inside the package — a
 * downloaded build has to reach the directory project without the user
 * configuring anything. A Firebase client config is public by design (security
 * lives in the Firestore rules), so there is nothing here to protect.
 *
 * A local `firebase.config.json` overrides it, for pointing a dev build at a
 * different project without touching the default.
 */
const CONFIG_PATHS = [
  path.join(CONFIG_DIR, 'firebase.config.json'),
  path.join(CONFIG_DIR, 'firebase.config.default.json'),
];

/**
 * Phase 0 identity. Two hardcoded UIDs; which one *this* machine is comes from
 * TETHER_UID so the same build can run both sides of the conversation.
 */
const UIDS = { me: 'phase0-user-a', friend: 'phase0-user-b' };

function resolveIdentity() {
  const selfUid = process.env.TETHER_UID || UIDS.me;
  const peerUid = selfUid === UIDS.me ? UIDS.friend : UIDS.me;
  return { selfUid, peerUid };
}

function loadFirebaseConfig() {
  for (const candidate of CONFIG_PATHS) {
    try {
      return JSON.parse(fs.readFileSync(candidate, 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      throw new Error(`${path.basename(candidate)} is not valid JSON: ${err.message}`);
    }
  }
  return null;
}

const AUTH_POPUP_HOSTS = new Set(['accounts.google.com', 'apis.google.com']);

/** Hosts that signInWithPopup legitimately opens: the project's authDomain and Google's. */
function isAuthPopupUrl(rawUrl) {
  let host;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'https:') return false;
    host = parsed.hostname;
  } catch {
    return false;
  }
  if (AUTH_POPUP_HOSTS.has(host)) return true;
  const config = loadFirebaseConfig();
  return Boolean(config?.authDomain) && host === config.authDomain;
}

let mainWindow = null;
let store = null;
let rendererUrl = null;
let tray = null;

/**
 * Closing the window hides it; only an explicit Quit ends the process. This is
 * what makes messages arrive while the app is "closed" — the renderer stays
 * alive, holding its Firestore listener and running the sweep.
 */
let quitting = false;

function createWindow({ startHidden = false } = {}) {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 680,
    title: 'Tether',
    backgroundColor: '#14161a',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    show: !startHidden,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Served over http://localhost rather than loaded from file:// — see
  // main/server.js for why Google sign-in depends on it.
  mainWindow.loadURL(rendererUrl);

  // Surface renderer-side errors in the terminal; without this a thrown error
  // in the bundle just silently leaves you on a blank screen.
  mainWindow.webContents.on('console-message', (event) => {
    if (event.level === 'error' || event.level === 'warning') {
      console.error(`[renderer:${event.level}] ${event.message}`);
    }
  });
  mainWindow.webContents.on('did-finish-load', () => console.log('[tether] renderer loaded'));
  // Hide rather than destroy, so the listener survives the window.
  mainWindow.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    mainWindow.hide();
    if (process.platform === 'darwin') app.dock?.hide();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Google sign-in needs a real in-app popup: signInWithPopup opens a window on
  // the Firebase authDomain and postMessages the credential back, so sending it
  // to the system browser would strand the flow. Everything else goes external.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAuthPopupUrl(url)) return { action: 'allow' };
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

// --- IPC -------------------------------------------------------------------

/**
 * Emulator targets, when the app is being driven by the end-to-end tests.
 *
 * Passed through to the renderer rather than read there, because the renderer
 * has no environment of its own. Absent in every normal run, so a shipped build
 * cannot be pointed at a test backend by accident.
 */
function emulatorConfig() {
  const auth = process.env.TETHER_AUTH_EMULATOR;
  const firestore = process.env.TETHER_FIRESTORE_EMULATOR;
  if (!auth && !firestore) return null;
  return { auth: auth ?? null, firestore: firestore ?? null };
}

ipcMain.handle('tether:bootstrap', () => ({
  firebaseConfig: loadFirebaseConfig(),
  emulators: emulatorConfig(),
  ...resolveIdentity(),
}));

/** Bring the window back from hiding, creating it if it was never made. */
function showWindow() {
  if (!mainWindow) {
    createWindow();
  } else {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
  if (process.platform === 'darwin') app.dock?.show();
}

/**
 * Native OS notification, fired from the main process — macOS routes this
 * through UNUserNotificationCenter, Windows through the toast API. No push
 * service involved (§3.4).
 */
ipcMain.on('tether:notify', (_event, { title, body, peerUid }) => {
  if (!Notification.isSupported()) {
    console.warn('[tether] native notifications unsupported on this platform');
    return;
  }
  const notification = new Notification({ title, body });

  // Clicking a notification should land on the conversation it came from, not
  // just raise whatever happened to be on screen.
  notification.on('click', () => {
    showWindow();
    if (peerUid) mainWindow?.webContents.send('tether:open-thread', peerUid);
  });

  notification.show();
});

// --- local history ---------------------------------------------------------
// The renderer never touches the filesystem; it asks main for a thread's
// history and hands back each message it has received.

ipcMain.handle('tether:store:load', (_event, pairId) => store.load(pairId));

ipcMain.handle('tether:store:append', (_event, pairId, record) =>
  store.append(pairId, record)
);

ipcMain.handle('tether:store:revise', (_event, pairId, revision) =>
  store.revise(pairId, revision)
);

ipcMain.handle('tether:store:clear', (_event, pairId) => store.clear(pairId));

// --- server invites --------------------------------------------------------
// Encoding lives in main so the codec can use node's zlib and crypto rather
// than bundling equivalents into the renderer. There is no Cloud Function
// behind this: a code is self-contained and resolved entirely on the client.

// Google sign-in runs in the user's real browser, so it lives in main: it needs
// to open an external URL and listen on a loopback port.
ipcMain.handle('tether:google-signin', () => {
  const config = loadFirebaseConfig();
  return signInWithGoogle({
    clientId: config?.googleOAuth?.clientId,
    clientSecret: config?.googleOAuth?.clientSecret,
  });
});

ipcMain.handle('tether:invite:encode', (_event, config) => encodeInvite(config));

ipcMain.handle('tether:invite:decode', (_event, code) => decodeInvite(code));

// --- launch at login -------------------------------------------------------

ipcMain.handle('tether:login-item:get', () => getLaunchAtLogin());

ipcMain.handle('tether:login-item:set', (_event, enabled) => {
  setLaunchAtLogin(Boolean(enabled));
  tray?.refresh();
  return getLaunchAtLogin();
});

ipcMain.on('tether:log', (_event, line) => {
  console.log(`[renderer] ${line}`);
});

// --- lifecycle -------------------------------------------------------------

// A second launch (including the login item firing while the app is already
// running) must not start a rival process holding its own listener.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);

  app.whenReady().then(async () => {
    if (process.platform === 'darwin') app.setName('Tether');
    store = new MessageStore(app.getPath('userData'));

    // Google refuses OAuth from user agents it recognises as embedded browsers,
    // and Electron announces itself in the default UA. Dropping those tokens
    // leaves an ordinary Chrome UA, which is what the sign-in popup needs to be
    // allowed to proceed.
    app.userAgentFallback = session.defaultSession
      .getUserAgent()
      .replace(/ Electron\/[\d.]+/, '')
      .replace(new RegExp(` ${app.getName()}\\/[\\d.]+`), '');

    try {
      const started = await startRendererServer(path.join(__dirname, '..'), {
        emulators: emulatorConfig(),
      });
      rendererUrl = started.url;
      if (!started.stable) {
        // The signed-in session lives in origin-keyed storage, so a different
        // port means starting from a signed-out app.
        console.warn(
          `[tether] port ${PREFERRED_PORT} was busy; using ${started.port}. ` +
            'This run will not remember a signed-in session.'
        );
      }
    } catch (err) {
      console.error(`[tether] could not start the renderer server: ${err.message}`);
      app.quit();
      return;
    }

    const startHidden = startedHidden();
    createWindow({ startHidden });
    if (startHidden && process.platform === 'darwin') app.dock?.hide();

    tray = createTray({
      onShow: showWindow,
      onQuit: () => {
        quitting = true;
        app.quit();
      },
      getLaunchAtLogin,
      setLaunchAtLogin,
    });

    app.on('activate', showWindow);
  });

  app.on('before-quit', () => {
    quitting = true;
  });

  // Deliberately empty: the process outliving its windows is the whole point of
  // a tray-resident app. Quitting happens only through the tray's Quit item.
  app.on('window-all-closed', () => {});
}
