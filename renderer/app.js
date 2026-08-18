import { initializeApp } from 'firebase/app';
import {
  getFirestore,
  collection,
  addDoc,
  updateDoc,
  onSnapshot,
  query,
  orderBy,
  serverTimestamp,
  arrayRemove,
  deleteDoc,
} from 'firebase/firestore';

import schema from '../shared/schema.js';
import { initAuth, emailSignIn, emailSignUp, googleSignIn, signOut } from './auth.js';
import {
  claimUsername,
  downscaleImage,
  getProfile,
  lookupUsername,
  saveAvatar,
} from './profile.js';
import { startSweeper, sweepThread, effectiveCutoffDays } from './sweep.js';
import { createIntakeManager, loadPeers, rememberPeer } from './threads.js';

const { pairId, messagesPath, newMessage, toLocalRecord, MESSAGE_TTL_DAYS } = schema;

const el = (id) => document.getElementById(id);
const ui = {
  setup: el('setup'),
  auth: el('auth'),
  chat: el('chat'),
  authForm: el('auth-form'),
  email: el('email'),
  password: el('password'),
  googleBtn: el('google-btn'),
  authError: el('auth-error'),
  messages: el('messages'),
  composer: el('composer'),
  input: el('input'),
  selfLabel: el('self-label'),
  peerInput: el('peer-input'),
  peerForm: el('peer-form'),
  signOutBtn: el('sign-out'),
  clearBtn: el('clear-btn'),
  username: el('username'),
  authSubmit: el('auth-submit'),
  authToggle: el('auth-toggle'),
  finish: el('finish'),
  finishForm: el('finish-form'),
  finishUsername: el('finish-username'),
  finishError: el('finish-error'),
  finishSignout: el('finish-signout'),
  myUsername: el('my-username'),
  settings: el('settings'),
  settingsBtn: el('settings-btn'),
  avatarInput: el('avatar-input'),
  avatarPreview: el('avatar-preview'),
  cutoffInput: el('cutoff-input'),
  sweepNow: el('sweep-now'),
  sweepStatus: el('sweep-status'),
  loginItem: el('login-item'),
  threadList: el('thread-list'),
  threadEmpty: el('thread-empty'),
  threadHeader: el('thread-header'),
  peerName: el('peer-name'),
  peerAvatar: el('peer-avatar'),
  dot: el('status-dot'),
  myUid: el('my-uid'),
};

function show(screen) {
  for (const name of ['setup', 'auth', 'finish', 'chat']) {
    ui[name].classList.toggle('hidden', name !== screen);
  }
}

const log = (line) => window.tether.log(line);


/**
 * Render one local history record, updating in place if it's already on screen
 * (a locally-written message is seen once provisionally, then again once the
 * server timestamp resolves).
 */
function renderRecord(record, selfUid, rendered) {
  const existing = rendered.get(record.id);
  const node = existing ?? document.createElement('div');

  node.className = record.senderUid === selfUid ? 'msg mine' : 'msg';
  node.replaceChildren();

  const body = document.createElement('span');
  body.textContent = record.content;
  node.appendChild(body);

  const meta = document.createElement('span');
  meta.className = 'meta';
  meta.textContent = record.sentAt
    ? new Date(record.sentAt).toLocaleTimeString()
    : 'sending…';
  node.appendChild(meta);

  if (!existing) {
    ui.messages.appendChild(node);
    rendered.set(record.id, node);
  }
  ui.messages.scrollTop = ui.messages.scrollHeight;
}

/**
 * Show a conversation. Reads local history only — intake has already written
 * anything that arrived, so displaying a thread never touches Firestore and
 * switching between threads costs nothing.
 */
async function showThread(threadId, selfUid, rendered) {
  ui.messages.replaceChildren();
  rendered.clear();
  for (const record of await window.tether.store.load(threadId)) {
    renderRecord(record, selfUid, rendered);
  }
}

async function main() {
  const { firebaseConfig } = await window.tether.bootstrap();

  if (!firebaseConfig) {
    show('setup');
    log('no firebase config found — showing setup screen');
    return;
  }

  const app = initializeApp(firebaseConfig);
  const db = getFirestore(app);

  let selfUid = null;
  let peerUid = null;
  let thread = null;
  let signingUp = true;
  let stopSweeper = null;
  let intake = null;

  /** peerUid -> { uid, username } for every known conversation. */
  const peers = new Map();
  /** peerUid -> unread count since it was last displayed. */
  const unread = new Map();
  /** docId -> node for the thread currently on screen. */
  const rendered = new Map();

  const cutoffDays = () => effectiveCutoffDays(ui.cutoffInput.value);

  function startSweeping() {
    stopSweeper?.();
    stopSweeper = startSweeper(db, selfUid, () => [...peers.keys()], {
      cutoffDays,
      onSwept: (peer, removed, err) => {
        if (err) log(`sweep failed for ${peer}: ${err.message}`);
        else log(`swept ${removed} abandoned message(s) from thread with ${peer}`);
      },
    });
  }

  async function enterApp(user, profile) {
    selfUid = user.uid;
    ui.selfLabel.textContent = profile.username ? `@${profile.username}` : user.email ?? user.uid;
    ui.myUsername.textContent = profile.username ? `@${profile.username}` : '—';
    if (profile.pfpBase64) ui.avatarPreview.src = profile.pfpBase64;
    ui.cutoffInput.value = MESSAGE_TTL_DAYS;
    show('chat');

    // Every known conversation gets a listener now, not when it is clicked —
    // otherwise a message only notifies if you happened to open that thread
    // first, which defeats running in the background at all.
    intake = createIntakeManager(db, selfUid, {
      onMessage: (peer, record, { priming }) => {
        if (peer.uid === peerUid) {
          renderRecord(record, selfUid, rendered);
          return;
        }
        // Not on screen: count it, unless it is startup backlog we have
        // already read.
        if (!priming && record.senderUid !== selfUid) {
          unread.set(peer.uid, (unread.get(peer.uid) ?? 0) + 1);
          renderSidebar();
        }
      },
      notify: (peer, record) => {
        window.tether.notify(labelFor(peer.uid), record.content, peer.uid);
      },
      onError: (peer, err) => log(`thread ${labelFor(peer.uid)}: ${err.message}`),
    });

    try {
      for (const peer of await loadPeers(db, selfUid)) {
        peers.set(peer.uid, peer);
        intake.add(peer);
      }
    } catch (err) {
      log(`could not load conversations: ${err.message}`);
    }

    renderSidebar();
    startSweeping();
    log(`signed in as ${profile.username ?? user.uid}, ${peers.size} conversation(s)`);
  }

  const auth = initAuth(app, {
    onSignedIn: async (user) => {
      try {
        const profile = await getProfile(db, user.uid);
        // A Google sign-in creates an auth user with no profile behind it, so
        // the username step happens after the popup rather than before it.
        if (!profile?.username) {
          selfUid = user.uid;
          show('finish');
          ui.finishUsername.focus();
          return;
        }
        await enterApp(user, profile);
      } catch (err) {
        log(`could not load profile: ${err.message}`);
        ui.authError.textContent = err.message;
        show('auth');
      }
    },
    onSignedOut: () => {
      selfUid = null;
      stopListening?.();
      stopListening = null;
      stopSweeper?.();
      stopSweeper = null;
      intake?.stopAll();
      intake = null;
      thread = null;
      peers.clear();
      unread.clear();
      rendered.clear();
      ui.threadList.replaceChildren();
      ui.threadHeader.classList.add('hidden');
      ui.messages.replaceChildren();
      ui.clearBtn.classList.add('hidden');
      ui.settings.classList.add('hidden');
      show('auth');
    },
  });

  // --- sign in / sign up ---------------------------------------------------

  function setAuthMode(isSignUp) {
    signingUp = isSignUp;
    ui.username.classList.toggle('hidden', !isSignUp);
    ui.username.required = isSignUp;
    ui.authSubmit.textContent = isSignUp ? 'Create account' : 'Sign in';
    ui.authToggle.textContent = isSignUp
      ? 'Already have an account? Sign in'
      : 'Need an account? Sign up';
    ui.authError.textContent = '';
  }
  setAuthMode(true);
  ui.authToggle.addEventListener('click', () => setAuthMode(!signingUp));

  ui.authForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    ui.authError.textContent = '';
    const email = ui.email.value.trim();

    try {
      if (!signingUp) {
        await emailSignIn(auth, email, ui.password.value);
        return;
      }

      // Check the handle before creating the account, so an obviously taken
      // username doesn't leave an orphaned auth user behind.
      const wanted = ui.username.value;
      if (await lookupUsername(db, wanted)) {
        ui.authError.textContent = `"${wanted.trim().toLowerCase()}" is already taken`;
        return;
      }

      const credential = await emailSignUp(auth, email, ui.password.value);
      await claimUsername(db, credential.user.uid, wanted, { email });
      await enterApp(credential.user, { username: wanted.trim().toLowerCase() });
    } catch (err) {
      ui.authError.textContent = err.message;
    }
  });

  ui.googleBtn.addEventListener('click', async () => {
    ui.authError.textContent = '';
    try {
      await googleSignIn(auth);
    } catch (err) {
      ui.authError.textContent = err.message;
    }
  });

  // --- finish setup (Google) -----------------------------------------------

  ui.finishForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    ui.finishError.textContent = '';
    try {
      const username = await claimUsername(db, selfUid, ui.finishUsername.value, {
        email: auth.currentUser?.email ?? null,
        displayName: auth.currentUser?.displayName ?? null,
      });
      await enterApp(auth.currentUser, { username });
    } catch (err) {
      ui.finishError.textContent = err.message;
    }
  });

  ui.finishSignout.addEventListener('click', () => signOut(auth));
  ui.signOutBtn.addEventListener('click', () => signOut(auth));

  // --- settings ------------------------------------------------------------

  ui.settingsBtn.addEventListener('click', () =>
    ui.settings.classList.toggle('hidden')
  );

  ui.avatarInput.addEventListener('change', async () => {
    const file = ui.avatarInput.files?.[0];
    if (!file || !selfUid) return;
    try {
      const encoded = await downscaleImage(file);
      await saveAvatar(db, selfUid, encoded);
      ui.avatarPreview.src = encoded;
      log(`avatar saved (${Math.round(encoded.length / 1024)}kb encoded)`);
    } catch (err) {
      log(`avatar failed: ${err.message}`);
      ui.sweepStatus.textContent = err.message;
    }
  });

  window.tether.loginItem.get().then((enabled) => {
    ui.loginItem.checked = enabled;
  });

  ui.loginItem.addEventListener('change', async () => {
    const applied = await window.tether.loginItem.set(ui.loginItem.checked);
    ui.loginItem.checked = applied;
    log(`start at login: ${applied}`);
  });

  ui.sweepNow.addEventListener('click', async () => {
    if (!selfUid) return;
    const days = cutoffDays();
    if (Number(ui.cutoffInput.value) < days) {
      ui.cutoffInput.value = days;
      ui.sweepStatus.textContent =
        `The security rules only allow deleting undelivered messages after ${days} days, ` +
        `so the cutoff was raised to match.`;
      return;
    }
    let total = 0;
    for (const peer of peers.keys()) {
      try {
        total += await sweepThread(db, selfUid, peer, { cutoffDays: days });
      } catch (err) {
        log(`sweep failed for ${peer}: ${err.message}`);
      }
    }
    ui.sweepStatus.textContent = `Removed ${total} abandoned message(s).`;
  });

  // --- threads -------------------------------------------------------------

  const labelFor = (uid) => {
    const peer = peers.get(uid);
    return peer?.username ? `@${peer.username}` : uid;
  };

  function renderSidebar() {
    ui.threadList.replaceChildren();
    ui.threadEmpty.classList.toggle('hidden', peers.size > 0);

    for (const peer of peers.values()) {
      const item = document.createElement('li');
      item.className = peer.uid === peerUid ? 'active' : '';

      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = labelFor(peer.uid);
      item.appendChild(name);

      const count = unread.get(peer.uid) ?? 0;
      if (count > 0) {
        const badge = document.createElement('span');
        badge.className = 'unread';
        badge.textContent = count > 99 ? '99+' : String(count);
        item.appendChild(badge);
      }

      item.addEventListener('click', () => select(peer.uid));
      ui.threadList.appendChild(item);
    }
  }

  /** Display a conversation, marking it read. */
  async function select(uid) {
    peerUid = uid;
    unread.set(uid, 0);
    thread = { threadId: pairId(selfUid, uid), peerUid: uid };

    ui.threadHeader.classList.remove('hidden');
    ui.peerName.textContent = labelFor(uid);
    ui.clearBtn.classList.remove('hidden');

    const profile = await getProfile(db, uid).catch(() => null);
    ui.peerAvatar.src = profile?.pfpBase64 ?? '';

    await showThread(thread.threadId, selfUid, rendered);
    renderSidebar();
    ui.input.focus();
  }

  /** Add a conversation: remember it, start its listener, show it. */
  async function addPeer(uid, username, { show = true } = {}) {
    if (!peers.has(uid)) {
      peers.set(uid, { uid, username });
      await rememberPeer(db, selfUid, uid, username);
    }
    intake?.add(peers.get(uid));
    renderSidebar();
    if (show) await select(uid);
  }

  ui.peerForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const handle = ui.peerInput.value.trim();
    if (!handle || !selfUid) return;

    try {
      const uid = await lookupUsername(db, handle);
      if (!uid) {
        log(`no user named "${handle}"`);
        ui.sweepStatus.textContent = `No user named "${handle}".`;
        return;
      }
      if (uid === selfUid) {
        log('cannot open a thread with yourself');
        return;
      }
      await addPeer(uid, handle.trim().toLowerCase());
      ui.peerInput.value = '';
    } catch (err) {
      log(`could not open thread: ${err.message}`);
      ui.sweepStatus.textContent = err.message;
    }
  });

  // Clicking a notification opens the conversation it came from.
  window.tether.onOpenThread(async (uid) => {
    if (!selfUid || thread?.peerUid === uid) return;
    try {
      await select(uid);
    } catch (err) {
      log(`could not open thread from notification: ${err.message}`);
    }
  });

  // Local history is the user's own copy, so only the user clears it.
  ui.clearBtn.addEventListener('click', async () => {
    if (!thread) return;
    await window.tether.store.clear(thread.threadId);
    rendered.clear();
    ui.messages.replaceChildren();
    log('cleared local history for this thread');
  });

  ui.composer.addEventListener('submit', async (event) => {
    event.preventDefault();
    const content = ui.input.value.trim();
    if (!content || !thread) return;

    ui.input.value = '';
    try {
      await addDoc(collection(db, messagesPath(selfUid, peerUid)), {
        ...newMessage({ senderUid: selfUid, recipientUid: peerUid, content }),
        sentAt: serverTimestamp(),
      });
    } catch (err) {
      log(`send failed: ${err.code} — ${err.message}`);
      ui.input.value = content;
    }
  });
}

main().catch((err) => log(`fatal: ${err.message}`));
