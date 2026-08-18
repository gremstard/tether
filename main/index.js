'use strict';

const { app, BrowserWindow, Notification, ipcMain, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const { MessageStore } = require('./store.js');
const { encodeInvite, decodeInvite } = require('./invite.js');

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'firebase.config.json');

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
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new Error(`config/firebase.config.json is not valid JSON: ${err.message}`);
  }
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

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 680,
    title: 'Tether',
    backgroundColor: '#14161a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Surface renderer-side errors in the terminal; without this a thrown error
  // in the bundle just silently leaves you on a blank screen.
  mainWindow.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) console.error(`[renderer:error] ${message}`);
  });
  mainWindow.webContents.on('did-finish-load', () => console.log('[tether] renderer loaded'));
  mainWindow.on('closed', () => { mainWindow = null; });

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

ipcMain.handle('tether:bootstrap', () => ({
  firebaseConfig: loadFirebaseConfig(),
  ...resolveIdentity(),
}));

/**
 * Native OS notification, fired from the main process — macOS routes this
 * through UNUserNotificationCenter, Windows through the toast API. No push
 * service involved (§3.4).
 */
ipcMain.on('tether:notify', (_event, { title, body }) => {
  if (!Notification.isSupported()) {
    console.warn('[tether] native notifications unsupported on this platform');
    return;
  }
  const notification = new Notification({ title, body });
  notification.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
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

ipcMain.handle('tether:store:clear', (_event, pairId) => store.clear(pairId));

// --- server invites --------------------------------------------------------
// Encoding lives in main so the codec can use node's zlib and crypto rather
// than bundling equivalents into the renderer. There is no Cloud Function
// behind this: a code is self-contained and resolved entirely on the client.

ipcMain.handle('tether:invite:encode', (_event, config) => encodeInvite(config));

ipcMain.handle('tether:invite:decode', (_event, code) => decodeInvite(code));

ipcMain.on('tether:log', (_event, line) => {
  console.log(`[renderer] ${line}`);
});

// --- lifecycle -------------------------------------------------------------

app.whenReady().then(() => {
  if (process.platform === 'darwin') app.setName('Tether');
  store = new MessageStore(app.getPath('userData'));
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // Phase 2 turns this into a tray-resident background process; for now quit.
  if (process.platform !== 'darwin') app.quit();
});
