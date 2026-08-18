// Drives the real intake/store logic against the emulator, as two users.
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import {
  collection, addDoc, serverTimestamp, Timestamp, getDocs,
} from 'firebase/firestore';
import { createRequire } from 'node:module';
import os from 'node:os'; import fs from 'node:fs'; import path from 'node:path';

const require = createRequire(import.meta.url);
const schema = require('../shared/schema.js');
const { MessageStore } = require('../main/store.js');

const ALICE = 'alice000', BOB = 'bob11111';
const out = [];
const ok = (n, c) => out.push([c ? 'PASS' : 'FAIL', n]);

// Runs against the real security rules, as real signed-in users.
const env = await initializeTestEnvironment({
  projectId: 'tether-e2e',
  firestore: { rules: fs.readFileSync('firestore.rules', 'utf8'), host: '127.0.0.1', port: 8085 },
});
await env.clearFirestore();
const db = env.authenticatedContext(ALICE).firestore();
const bobDb = env.authenticatedContext(BOB).firestore();

// Emulate the renderer's store bridge with the real main-process store.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tether-e2e-'));
const store = new MessageStore(dir);
globalThis.window = { tether: { store: {
  load: (id) => store.load(id), append: (id, r) => store.append(id, r), clear: (id) => store.clear(id),
} } };

const { startIntake, rememberPeer, loadPeers } = await import('../renderer/threads.js');

// Alice remembers Bob, so the conversation survives a restart.
await rememberPeer(db, ALICE, BOB, 'bobby');
const peers = await loadPeers(db, ALICE);
ok('conversation pointer persists', peers.length === 1 && peers[0].uid === BOB && peers[0].username === 'bobby');

// Alice holds intake on the thread WITHOUT ever "opening" it.
const notified = [], seen = [];
const stop = startIntake(db, ALICE, { uid: BOB, username: 'bobby' }, {
  onMessage: (p, r, m) => seen.push({ ...r, priming: m.priming }),
  notify: (p, r) => notified.push(r.content),
  onError: (p, e) => out.push(['FAIL', 'intake error: ' + e.message]),
});
await new Promise((r) => setTimeout(r, 1500));

// Bob sends. Alice never clicked this thread.
const threadId = schema.pairId(ALICE, BOB);
await addDoc(collection(bobDb, schema.messagesPath(ALICE, BOB)), {
  senderUid: BOB, content: 'are you there?', sentAt: serverTimestamp(),
  pendingFor: [ALICE], expireAt: Timestamp.fromMillis(Date.now() + 86400000),
});
await new Promise((r) => setTimeout(r, 2500));

ok('message received without opening the thread', seen.some((m) => m.content === 'are you there?'));
ok('notification fired for unopened thread', notified.includes('are you there?'));
ok('persisted to local history before ack', (await store.load(threadId)).some((m) => m.content === 'are you there?'));

// Ack must have happened -> pendingFor empty -> sender can clean up.
const docs = await getDocs(collection(db, schema.messagesPath(ALICE, BOB)));
const acked = docs.docs.every((d) => (d.data().pendingFor ?? []).length === 0);
ok('recipient acked (pendingFor emptied)', acked);

stop();
await new Promise((r) => setTimeout(r, 300));

// Restart: history is on disk, independent of the server copy.
const reopened = await new MessageStore(dir).load(threadId);
ok('history survives restart', reopened.some((m) => m.content === 'are you there?'));

fs.rmSync(dir, { recursive: true, force: true });
await env.cleanup();
for (const [s, n] of out) console.log(`${s}  ${n}`);
const failed = out.filter(([s]) => s === 'FAIL').length;
console.log(`\n${out.length - failed}/${out.length} passed`);
process.exit(failed ? 1 : 0);
