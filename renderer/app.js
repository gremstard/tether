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
  dot: el('status-dot'),
  myUid: el('my-uid'),
};

function show(screen) {
  for (const name of ['setup', 'auth', 'finish', 'chat']) {
    ui[name].classList.toggle('hidden', name !== screen);
  }
}

const log = (line) => window.tether.log(line);

/** Teardown for the active thread listener, so switching peers doesn't stack them. */
let stopListening = null;

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
 * Open a thread: render what we already have on disk, then listen for anything
 * new.
 *
 * The ordering inside the listener is the important part. A received message is
 * written to local history *before* it is acked, because acking is what lets the
 * server delete it. Ack first and a crash in between loses the message for good.
 */
async function openThread(db, selfUid, peerUid) {
  stopListening?.();
  ui.messages.replaceChildren();
  ui.dot.classList.remove('live');

  const threadId = pairId(selfUid, peerUid);
  const messages = collection(db, messagesPath(selfUid, peerUid));

  /** docId -> rendered node. */
  const rendered = new Map();

  // Local history is what the user sees; Firestore only ever adds to it.
  for (const record of await window.tether.store.load(threadId)) {
    renderRecord(record, selfUid, rendered);
  }

  // The first snapshot is backlog, not news — notifying on it would fire a
  // toast per undelivered message every time the app starts.
  let priming = true;

  stopListening = onSnapshot(
    query(messages, orderBy('sentAt', 'asc')),
    async (snapshot) => {
      ui.dot.classList.add('live');

      for (const change of snapshot.docChanges()) {
        // Server-side removal is just cleanup finishing. Our copy stays.
        if (change.type === 'removed') continue;

        const data = change.doc.data();
        const record = toLocalRecord(change.doc.id, data);

        try {
          await window.tether.store.append(threadId, record);
        } catch (err) {
          // Never ack what we failed to save — the server would delete it.
          log(`could not save message locally, not acking: ${err.message}`);
          continue;
        }

        renderRecord(record, selfUid, rendered);

        if (data.senderUid === selfUid) {
          // Our own message, now safely in local history. Once the recipient
          // has acked, the server copy has done its job.
          if (data.pendingFor?.length === 0) {
            deleteDoc(change.doc.ref).catch((err) => log(`cleanup failed: ${err.code}`));
          }
          continue;
        }

        if (!priming) window.tether.notify('Tether', data.content);

        if (data.pendingFor?.includes(selfUid)) {
          updateDoc(change.doc.ref, { pendingFor: arrayRemove(selfUid) }).catch((err) =>
            log(`ack failed: ${err.code}`)
          );
        }
      }

      priming = false;
    },
    (err) => {
      ui.dot.classList.remove('live');
      log(`listener error: ${err.code} — ${err.message}`);
    }
  );

  return { messages, threadId, rendered };
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

  /** Peers with an open thread this session — what the sweeper walks. */
  const openPeers = new Set();

  const cutoffDays = () => effectiveCutoffDays(ui.cutoffInput.value);

  function startSweeping() {
    stopSweeper?.();
    stopSweeper = startSweeper(db, selfUid, () => [...openPeers], {
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
    startSweeping();
    log(`signed in as ${profile.username ?? user.uid}`);
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
      thread = null;
      openPeers.clear();
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
    for (const peer of openPeers) {
      try {
        total += await sweepThread(db, selfUid, peer, { cutoffDays: days });
      } catch (err) {
        log(`sweep failed for ${peer}: ${err.message}`);
      }
    }
    ui.sweepStatus.textContent = `Removed ${total} abandoned message(s).`;
  });

  // --- threads -------------------------------------------------------------

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

      peerUid = uid;
      openPeers.add(uid);
      thread = await openThread(db, selfUid, peerUid);
      ui.clearBtn.classList.remove('hidden');
      ui.input.focus();
    } catch (err) {
      log(`could not open thread: ${err.message}`);
      ui.sweepStatus.textContent = err.message;
    }
  });

  // Local history is the user's own copy, so only the user clears it.
  ui.clearBtn.addEventListener('click', async () => {
    if (!thread) return;
    await window.tether.store.clear(thread.threadId);
    thread.rendered.clear();
    ui.messages.replaceChildren();
    log('cleared local history for this thread');
  });

  ui.composer.addEventListener('submit', async (event) => {
    event.preventDefault();
    const content = ui.input.value.trim();
    if (!content || !thread) return;

    ui.input.value = '';
    try {
      await addDoc(thread.messages, {
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
