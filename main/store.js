'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { applyRevision } = require('../shared/schema.js');

/**
 * Durable local message history, one JSON file per thread.
 *
 * This is the client's own copy of a conversation, and it is authoritative for
 * what the user sees. Firestore is transport: a message lands there, every
 * recipient copies it here, and the server copy is then deleted. So this store
 * is what the UI renders from, and it outlives the server-side document.
 *
 * It lives in the main process because the Phase 2 tray listener runs here —
 * a background process receiving messages with no window open still has to be
 * able to write them down.
 */

/** Thread ids are two alphanumeric Firebase UIDs joined by "_". */
const PAIR_ID = /^[A-Za-z0-9]{1,128}_[A-Za-z0-9]{1,128}$/;

class MessageStore {
  constructor(baseDir) {
    this.dir = path.join(baseDir, 'threads');
    fs.mkdirSync(this.dir, { recursive: true });
    /** pairId -> tail of that thread's write chain. */
    this.queues = new Map();
  }

  /**
   * Serialize mutations per thread. Every write is a read-modify-write, so two
   * messages arriving in the same tick would otherwise both read the old file
   * and the second would clobber the first.
   */
  enqueue(pairId, work) {
    const previous = this.queues.get(pairId) ?? Promise.resolve();
    const next = previous.then(work, work);
    // Keep the chain alive on failure, but don't leave an unhandled rejection.
    this.queues.set(
      pairId,
      next.catch(() => {})
    );
    return next;
  }

  /**
   * Thread ids reach us from the renderer, where half the id is a UID the user
   * typed by hand. Validate rather than sanitize so nothing resembling a path
   * ever reaches the filesystem.
   */
  fileFor(pairId) {
    if (typeof pairId !== 'string' || !PAIR_ID.test(pairId)) {
      throw new Error(`refusing to open a thread file for invalid id: ${pairId}`);
    }
    return path.join(this.dir, `${pairId}.json`);
  }

  /**
   * Read a thread's file.
   *
   * Files written before revisions existed are a bare array of messages; they
   * are read as a thread with no held revisions rather than migrated eagerly,
   * so an upgrade never rewrites history it did not need to touch.
   */
  async read(pairId) {
    // Resolve the path outside the try: an invalid thread id is a bug, not a
    // missing file, and must not be reported as an empty conversation.
    const file = this.fileFor(pairId);
    try {
      const parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
      if (Array.isArray(parsed)) return { messages: parsed, held: {} };
      return { messages: parsed.messages ?? [], held: parsed.held ?? {} };
    } catch (err) {
      if (err.code === 'ENOENT') return { messages: [], held: {} };
      // A corrupt thread file shouldn't take the app down, but it also
      // shouldn't be silently overwritten — surface it and start empty.
      console.error(`[store] could not read thread ${pairId}: ${err.message}`);
      return { messages: [], held: {} };
    }
  }

  async load(pairId) {
    return (await this.read(pairId)).messages;
  }

  /**
   * Insert or update one message, keyed by its Firestore document id, keeping
   * the thread ordered by send time. Upsert rather than append because a
   * locally-written message is seen once with a provisional timestamp and again
   * once the server stamps it.
   */
  append(pairId, record) {
    return this.enqueue(pairId, () => this.appendNow(pairId, record));
  }

  async appendNow(pairId, record) {
    const { messages, held } = await this.read(pairId);
    const at = messages.findIndex((m) => m.id === record.id);
    if (at === -1) messages.push(record);
    else messages[at] = { ...messages[at], ...record };

    // A revision can arrive before the message it revises — they travel as
    // separate listeners with no ordering between them — so any revision held
    // for this id is applied the moment its target shows up.
    const waiting = held[record.id];
    if (waiting) {
      const index = messages.findIndex((m) => m.id === record.id);
      const revised = applyRevision(messages[index], waiting);
      if (revised === null) messages.splice(index, 1);
      else messages[index] = revised;
      delete held[record.id];
    }

    messages.sort((a, b) => a.sentAt - b.sentAt);
    await this.write(pairId, { messages, held });
    return messages;
  }

  /**
   * Apply a sender's edit or deletion to local history.
   *
   * Held for later if the target has not arrived yet, so a revision can never
   * be lost to a race with the message it refers to.
   */
  revise(pairId, revision) {
    return this.enqueue(pairId, () => this.reviseNow(pairId, revision));
  }

  async reviseNow(pairId, revision) {
    const { messages, held } = await this.read(pairId);
    const at = messages.findIndex((m) => m.id === revision.targetId);

    if (at === -1) {
      held[revision.targetId] = revision;
      await this.write(pairId, { messages, held });
      return { applied: false, messages };
    }

    const revised = applyRevision(messages[at], revision);
    // applyRevision returns the record unchanged when the reviser did not send
    // it, which is how a forged revision is refused.
    if (revised === messages[at]) return { applied: false, messages };

    if (revised === null) messages.splice(at, 1);
    else messages[at] = revised;

    await this.write(pairId, { messages, held });
    return { applied: true, messages };
  }

  /** Forget a thread. Only the user does this — server cleanup never gets here. */
  clear(pairId) {
    return this.enqueue(pairId, () => this.write(pairId, { messages: [], held: {} }));
  }

  /** Write via temp file + rename so a crash mid-write can't truncate history. */
  async write(pairId, thread) {
    const file = this.fileFor(pairId);
    const tmp = `${file}.tmp`;
    const payload = Array.isArray(thread) ? { messages: thread, held: {} } : thread;
    await fsp.writeFile(tmp, JSON.stringify(payload), 'utf8');
    await fsp.rename(tmp, file);
  }
}

module.exports = { MessageStore, PAIR_ID };
