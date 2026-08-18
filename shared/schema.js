'use strict';

/**
 * Firestore schema helpers shared by the Electron main process and the renderer.
 * Kept CommonJS so main/ can require() it directly and esbuild can bundle it
 * into the renderer without a second module format.
 */

/**
 * Days a message survives if the recipient never acks it.
 *
 * There is no native Firestore TTL policy — that needs Blaze, and Tether stays
 * on Spark. Cleanup of never-delivered messages is done by the client sweep
 * (see `sweepable()`), so this is the sweep's default cutoff, not a server
 * policy.
 */
const MESSAGE_TTL_DAYS = 30;

/**
 * Floor on how old a message must be before a participant may delete it while
 * someone is still waiting on it. Mirrored in firestore.rules.
 *
 * Without a floor, "delete undelivered messages" would let either side unsend a
 * message the other simply hasn't collected yet. With it, the sweep can only
 * reap genuinely abandoned messages. Lowering the sweep cutoff below this floor
 * requires editing firestore.rules to match and redeploying — the rules are the
 * authority, and the client cannot talk its way past them.
 */
const SWEEP_MIN_AGE_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Deterministic thread id for a pair of users. Sorting means both participants
 * compute the same path without coordinating.
 */
function pairId(uidA, uidB) {
  if (!uidA || !uidB) throw new Error('pairId requires two uids');
  if (uidA === uidB) throw new Error('pairId requires two distinct uids');
  return [uidA, uidB].sort().join('_');
}

/** Firestore collection path for a DM thread's messages. */
function messagesPath(uidA, uidB) {
  return `dms/${pairId(uidA, uidB)}/messages`;
}

/**
 * Build a message document. `pendingFor` starts as the recipient only — the
 * sender already has the message, so it never waits on itself.
 */
function newMessage({ senderUid, recipientUid, content, now = new Date() }) {
  return {
    senderUid,
    content,
    sentAt: now,
    pendingFor: [recipientUid],
    expireAt: new Date(now.getTime() + MESSAGE_TTL_DAYS * 24 * 60 * 60 * 1000),
  };
}

/**
 * Is this message eligible for the client-side sweep?
 *
 * Two disjoint cases end a message's life on the server:
 *   - everyone has acked it (`pendingFor` empty) — the normal path, handled as
 *     soon as delivery completes;
 *   - it is older than the cutoff and someone never came back for it — the
 *     abandoned path, which is what this sweep exists for.
 */
function sweepable(message, { now = Date.now(), cutoffDays = MESSAGE_TTL_DAYS } = {}) {
  const sentAt = message.sentAt?.toMillis ? message.sentAt.toMillis() : message.sentAt;
  if (!sentAt) return false; // not yet stamped by the server
  return (
    Array.isArray(message.pendingFor) &&
    message.pendingFor.length > 0 &&
    sentAt < now - cutoffDays * DAY_MS
  );
}

/** Usernames are the public handle; the doc id is the username itself. */
const USERNAME = /^[a-z0-9_]{3,20}$/;

/**
 * Normalize then validate a username. Lowercased so `Riz` and `riz` cannot be
 * claimed as two different handles, and restricted to characters that are safe
 * as a Firestore document id (no slashes, no dots).
 */
function normalizeUsername(raw) {
  return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}

function isValidUsername(raw) {
  return USERNAME.test(normalizeUsername(raw));
}

/**
 * Shape a Firestore message into the record kept in local history.
 *
 * Deliberately plain data: it crosses an IPC boundary and gets JSON-serialized
 * to disk, so no Firestore Timestamp objects survive the trip. `sentAt` becomes
 * epoch millis, and is provisional until the server stamps the document — a
 * locally-written message reports null for a beat.
 */
function toLocalRecord(id, data, fallbackSentAt = Date.now()) {
  return {
    id,
    senderUid: data.senderUid,
    content: data.content,
    sentAt: data.sentAt?.toMillis ? data.sentAt.toMillis() : fallbackSentAt,
  };
}

module.exports = {
  MESSAGE_TTL_DAYS,
  SWEEP_MIN_AGE_DAYS,
  DAY_MS,
  USERNAME,
  sweepable,
  normalizeUsername,
  isValidUsername,
  pairId,
  messagesPath,
  newMessage,
  toLocalRecord,
};
