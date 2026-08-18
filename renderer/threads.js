import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  setDoc,
  updateDoc,
  arrayRemove,
} from 'firebase/firestore';

import schema from '../shared/schema.js';

const { messagesPath, pairId, toLocalRecord } = schema;

/**
 * Message intake, and the list of conversations it runs over.
 *
 * Intake is deliberately separate from display. Every known thread gets a
 * listener as soon as the app signs in — not just the one on screen — because
 * "a message arrives whenever my computer is on" cannot be true if receiving
 * depends on having clicked that conversation first. Each listener persists to
 * local history, acks, notifies, and cleans up, regardless of what is displayed.
 *
 * The displayed thread reads from local history, which intake has already
 * written to. Rendering never talks to Firestore.
 */

/** Where the user's conversation pointers live (build doc §3.1). */
const dmListPath = (selfUid) => `users/${selfUid}/dms`;

/** Remember a conversation so it survives a restart. */
export async function rememberPeer(db, selfUid, peerUid, username) {
  await setDoc(
    doc(db, dmListPath(selfUid), peerUid),
    { username: username ?? null, addedAt: Date.now() },
    { merge: true }
  );
}

export async function loadPeers(db, selfUid) {
  const snap = await getDocs(collection(db, dmListPath(selfUid)));
  return snap.docs.map((d) => ({ uid: d.id, ...d.data() }));
}

/**
 * Hold a listener on one thread. Returns an unsubscribe function.
 *
 * Ordering is load-bearing and unchanged from Phase 1: persist to local history
 * first, ack second. Acking is what lets the server delete the message, so a
 * crash between the two would lose it.
 */
export function startIntake(db, selfUid, peer, { onMessage, onError, notify }) {
  const messages = collection(db, messagesPath(selfUid, peer.uid));
  const threadId = pairId(selfUid, peer.uid);

  // The first snapshot is backlog, not news.
  let priming = true;

  return onSnapshot(
    query(messages, orderBy('sentAt', 'asc')),
    async (snapshot) => {
      for (const change of snapshot.docChanges()) {
        // A server-side removal is cleanup finishing; our copy stays.
        if (change.type === 'removed') continue;

        const data = change.doc.data();
        const record = toLocalRecord(change.doc.id, data);

        try {
          await window.tether.store.append(threadId, record);
        } catch (err) {
          // Never ack what we failed to save.
          onError?.(peer, new Error(`not acked, could not save locally: ${err.message}`));
          continue;
        }

        onMessage?.(peer, record, { priming });

        if (data.senderUid === selfUid) {
          if (data.pendingFor?.length === 0) {
            deleteDoc(change.doc.ref).catch((err) => onError?.(peer, err));
          }
          continue;
        }

        if (!priming) notify?.(peer, record);

        if (data.pendingFor?.includes(selfUid)) {
          updateDoc(change.doc.ref, { pendingFor: arrayRemove(selfUid) }).catch((err) =>
            onError?.(peer, err)
          );
        }
      }

      priming = false;
    },
    (err) => onError?.(peer, err)
  );
}

/**
 * Keep one listener per known conversation. Adding a peer starts its listener
 * immediately; nothing is torn down until sign-out.
 */
export function createIntakeManager(db, selfUid, handlers) {
  const listeners = new Map();

  return {
    add(peer) {
      if (listeners.has(peer.uid)) return;
      listeners.set(peer.uid, startIntake(db, selfUid, peer, handlers));
    },
    has: (uid) => listeners.has(uid),
    peers: () => [...listeners.keys()],
    stopAll() {
      for (const stop of listeners.values()) stop();
      listeners.clear();
    },
  };
}
