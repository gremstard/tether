'use strict';

/**
 * Firestore schema helpers shared by the Electron main process and the renderer.
 * Kept CommonJS so main/ can require() it directly and esbuild can bundle it
 * into the renderer without a second module format.
 */

/** Days a message survives if the recipient never acks it (§3.3 TTL safety net). */
const MESSAGE_TTL_DAYS = 30;

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
  pairId,
  messagesPath,
  newMessage,
  toLocalRecord,
};
