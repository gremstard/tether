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

const { messagesPath, newMessage } = schema;

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

function renderMessage(data, selfUid) {
  const node = document.createElement('div');
  node.className = data.senderUid === selfUid ? 'msg mine' : 'msg';

  const body = document.createElement('span');
  body.textContent = data.content;
  node.appendChild(body);

  const meta = document.createElement('span');
  meta.className = 'meta';
  // sentAt is null for a beat on locally-written docs until the server stamps it.
  meta.textContent = data.sentAt?.toDate
    ? data.sentAt.toDate().toLocaleTimeString()
    : 'sending…';
  node.appendChild(meta);

  ui.messages.appendChild(node);
  ui.messages.scrollTop = ui.messages.scrollHeight;
  return node;
}

function openThread(db, selfUid, peerUid) {
  stopListening?.();
  ui.messages.replaceChildren();
  ui.dot.classList.remove('live');

  const messages = collection(db, messagesPath(selfUid, peerUid));

  // The first snapshot is backlog, not news — notifying on it would fire a
  // toast per old message every time the app starts.
  let priming = true;

  /** docId -> rendered node, so a deleted message can leave the view too. */
  const rendered = new Map();

  stopListening = onSnapshot(
    query(messages, orderBy('sentAt', 'asc')),
    (snapshot) => {
      ui.dot.classList.add('live');

      for (const change of snapshot.docChanges()) {
        const data = change.doc.data();

        if (change.type === 'removed') {
          rendered.get(change.doc.id)?.remove();
          rendered.delete(change.doc.id);
          continue;
        }

        // Delivered to everyone who was waiting — the message has done its job.
        // On the free tier this client-side sweep is what keeps threads from
        // growing forever; the TTL policy is the backstop for the case where
        // nobody is ever around to run it.
        if (data.pendingFor?.length === 0 && data.senderUid === selfUid) {
          deleteDoc(change.doc.ref).catch((err) => log(`cleanup failed: ${err.code}`));
        }

        if (change.type !== 'added') continue;
        rendered.set(change.doc.id, renderMessage(data, selfUid));

        if (data.senderUid === selfUid) continue;

        log(`${priming ? 'backlog' : 'new'} message from ${data.senderUid}`);
        if (!priming) window.tether.notify('Tether', data.content);

        // Ack delivery: drop ourselves from pendingFor. Once it empties, the
        // message is eligible for cleanup (§3.3).
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

  return messages;
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
  let messages = null;

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
  ui.peerForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const value = ui.peerInput.value.trim();
    if (!value || !selfUid) return;
    if (value === selfUid) {
      log('cannot open a thread with yourself');
      return;
    }
    peerUid = value;
    messages = openThread(db, selfUid, peerUid);
    ui.input.focus();
  });

  ui.composer.addEventListener('submit', async (event) => {
    event.preventDefault();
    const content = ui.input.value.trim();
    if (!content || !messages) return;

    ui.input.value = '';
    try {
      await addDoc(messages, {
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
