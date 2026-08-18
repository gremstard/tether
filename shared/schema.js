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

module.exports = { MESSAGE_TTL_DAYS, pairId, messagesPath, newMessage };
