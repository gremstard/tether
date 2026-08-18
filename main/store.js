'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

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

  async load(pairId) {
    // Resolve the path outside the try: an invalid thread id is a bug, not a
    // missing file, and must not be reported as an empty conversation.
    const file = this.fileFor(pairId);
    try {
      const raw = await fsp.readFile(file, 'utf8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      // A corrupt thread file shouldn't take the app down, but it also
      // shouldn't be silently overwritten — surface it and start empty.
      console.error(`[store] could not read thread ${pairId}: ${err.message}`);
      return [];
    }
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
    const messages = await this.load(pairId);
    const at = messages.findIndex((m) => m.id === record.id);
    if (at === -1) messages.push(record);
    else messages[at] = { ...messages[at], ...record };

    messages.sort((a, b) => a.sentAt - b.sentAt);
    await this.write(pairId, messages);
    return messages;
  }

  /** Forget a thread. Only the user does this — server cleanup never gets here. */
  clear(pairId) {
    return this.enqueue(pairId, () => this.write(pairId, []));
  }

  /** Write via temp file + rename so a crash mid-write can't truncate history. */
  async write(pairId, messages) {
    const file = this.fileFor(pairId);
    const tmp = `${file}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(messages), 'utf8');
    await fsp.rename(tmp, file);
  }
}

module.exports = { MessageStore, PAIR_ID };
