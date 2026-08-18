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
import { initAuth, emailSignIn, googleSignIn, signOut } from './auth.js';

const { pairId, messagesPath, newMessage, toLocalRecord } = schema;

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
  dot: el('status-dot'),
  myUid: el('my-uid'),
};

function show(screen) {
  for (const name of ['setup', 'auth', 'chat']) {
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

  const auth = initAuth(app, {
    onSignedIn: (user) => {
      selfUid = user.uid;
      ui.selfLabel.textContent = user.email || user.displayName || user.uid;
      ui.myUid.textContent = user.uid;
      show('chat');
      log(`signed in as ${user.uid}`);
    },
    onSignedOut: () => {
      selfUid = null;
      stopListening?.();
      stopListening = null;
      thread = null;
      ui.messages.replaceChildren();
      ui.clearBtn.classList.add('hidden');
      show('auth');
    },
  });

  ui.authForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    ui.authError.textContent = '';
    try {
      await emailSignIn(auth, ui.email.value.trim(), ui.password.value, {
        createIfMissing: true,
      });
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

  ui.signOutBtn.addEventListener('click', () => signOut(auth));

  // Phase 3 replaces this with a real friend list out of the directory project.
  ui.peerForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const value = ui.peerInput.value.trim();
    if (!value || !selfUid) return;
    if (value === selfUid) {
      log('cannot open a thread with yourself');
      return;
    }
    peerUid = value;
    try {
      thread = await openThread(db, selfUid, peerUid);
      ui.clearBtn.classList.remove('hidden');
      ui.input.focus();
    } catch (err) {
      log(`could not open thread: ${err.message}`);
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
