import {
  collection,
  query,
  where,
  getDocs,
  deleteDoc,
  Timestamp,
} from 'firebase/firestore';

import schema from '../shared/schema.js';

const { messagesPath, MESSAGE_TTL_DAYS, SWEEP_MIN_AGE_DAYS, DAY_MS } = schema;

/**
 * Client-side replacement for a Firestore TTL policy.
 *
 * Tether is on Spark, so there is no native TTL and no Cloud Function to run
 * cleanup server-side. Instead each client reaps its own threads: messages that
 * are older than the cutoff and that somebody never collected. Delivered
 * messages are already removed the moment the last recipient acks, so this only
 * ever touches abandoned ones.
 *
 * Both participants sweep the same thread, and that is fine — whoever gets there
 * first deletes, and the loser's delete of a now-missing document is a no-op.
 *
 * This currently runs in the renderer because that is where the Firestore
 * listener lives. In Phase 2 it moves into the tray process alongside the
 * listener, which is why the policy itself lives in shared/ and takes its
 * database handle as an argument.
 */

/** Refuse to sweep more aggressively than firestore.rules will permit. */
export function effectiveCutoffDays(requestedDays) {
  const requested = Number(requestedDays);
  if (!Number.isFinite(requested) || requested <= 0) return MESSAGE_TTL_DAYS;
  return Math.max(requested, SWEEP_MIN_AGE_DAYS);
}

/**
 * Delete abandoned messages in one thread. Returns how many were removed.
 */
export async function sweepThread(db, selfUid, peerUid, { cutoffDays } = {}) {
  const days = effectiveCutoffDays(cutoffDays);
  const cutoff = Timestamp.fromMillis(Date.now() - days * DAY_MS);

  // Filter by age in the query so an old thread doesn't get read in full, then
  // check pendingFor locally — Firestore cannot express "array is non-empty".
  const stale = await getDocs(
    query(collection(db, messagesPath(selfUid, peerUid)), where('sentAt', '<', cutoff))
  );

  const doomed = stale.docs.filter((doc) => (doc.data().pendingFor?.length ?? 0) > 0);

  const results = await Promise.allSettled(doomed.map((doc) => deleteDoc(doc.ref)));
  return results.filter((r) => r.status === 'fulfilled').length;
}

/**
 * Sweep every thread the user has open, on an interval.
 * Returns a stop function.
 */
export function startSweeper(db, selfUid, listThreads, { cutoffDays, intervalMs = 6 * 60 * 60 * 1000, onSwept } = {}) {
  let stopped = false;

  const run = async () => {
    if (stopped) return;
    for (const peerUid of listThreads()) {
      try {
        const removed = await sweepThread(db, selfUid, peerUid, { cutoffDays: cutoffDays() });
        if (removed > 0) onSwept?.(peerUid, removed);
      } catch (err) {
        onSwept?.(peerUid, 0, err);
      }
    }
  };

  run();
  const timer = setInterval(run, intervalMs);

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
