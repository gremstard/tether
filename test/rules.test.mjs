import fs from 'node:fs';
import assert from 'node:assert';
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} from '@firebase/rules-unit-testing';
import {
  doc, setDoc, getDoc, deleteDoc, updateDoc, writeBatch, serverTimestamp, Timestamp, collection, addDoc,
} from 'firebase/firestore';

const ALICE = 'alice000', BOB = 'bob11111', MALLORY = 'mallory9';
const PAIR = [ALICE, BOB].sort().join('_');
const DAY = 24 * 60 * 60 * 1000;

const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push(['PASS', name]); }
  catch (err) { results.push(['FAIL', `${name} — ${err.message.split('\n')[0]}`]); }
};

const env = await initializeTestEnvironment({
  projectId: 'tether-rules-test',
  firestore: { rules: fs.readFileSync('firestore.rules', 'utf8'), host: '127.0.0.1', port: 8085 },
});
await env.clearFirestore();

const alice = env.authenticatedContext(ALICE).firestore();
const bob = env.authenticatedContext(BOB).firestore();
const mallory = env.authenticatedContext(MALLORY).firestore();
const anon = env.unauthenticatedContext().firestore();

// ---------- usernames: uniqueness + ownership ----------
await check('claim a free username', () =>
  assertSucceeds(setDoc(doc(alice, 'usernames/riz'), { uid: ALICE })));

await check('cannot claim a taken username', () =>
  assertFails(setDoc(doc(bob, 'usernames/riz'), { uid: BOB })));

await check('cannot claim a username pointing at someone else', () =>
  assertFails(setDoc(doc(bob, 'usernames/imposter'), { uid: ALICE })));

await check('cannot repoint an existing username', () =>
  assertFails(updateDoc(doc(mallory, 'usernames/riz'), { uid: MALLORY })));

await check('cannot delete a username to free it', () =>
  assertFails(deleteDoc(doc(alice, 'usernames/riz'))));

await check('rejects malformed username id', () =>
  assertFails(setDoc(doc(bob, 'usernames/AB'), { uid: BOB })));

await check('signed-in user can resolve a handle', () =>
  assertSucceeds(getDoc(doc(bob, 'usernames/riz'))));

await check('anonymous cannot read the index', () =>
  assertFails(getDoc(doc(anon, 'usernames/riz'))));

// ---------- the batch question ----------
await check('ATOMIC BATCH: username + profile in one commit', () => {
  const b = writeBatch(bob);
  b.set(doc(bob, 'usernames/bobby'), { uid: BOB });
  b.set(doc(bob, 'users/' + BOB), { username: 'bobby', displayName: 'Bob' });
  return assertSucceeds(b.commit());
});

// ---------- profiles ----------
await check('cannot write someone else’s profile', () =>
  assertFails(setDoc(doc(mallory, 'users/' + ALICE), { displayName: 'hacked' })));

await check('oversized base64 pfp rejected', () =>
  assertFails(setDoc(doc(alice, 'users/' + ALICE), { pfpBase64: 'x'.repeat(400001) })));

await check('reasonable base64 pfp accepted', () =>
  assertSucceeds(setDoc(doc(alice, 'users/' + ALICE), { pfpBase64: 'x'.repeat(50000) })));

// ---------- dm pointers ----------
await check('own dm list is writable', () =>
  assertSucceeds(setDoc(doc(alice, `users/${ALICE}/dms/${BOB}`), { username: 'bobby' })));

await check('own dm list is readable', () =>
  assertSucceeds(getDoc(doc(alice, `users/${ALICE}/dms/${BOB}`))));

await check('cannot read someone else’s dm list', () =>
  assertFails(getDoc(doc(mallory, `users/${ALICE}/dms/${BOB}`))));

await check('cannot write into someone else’s dm list', () =>
  assertFails(setDoc(doc(mallory, `users/${ALICE}/dms/${MALLORY}`), { username: 'x' })));

await check('own server list is writable', () =>
  assertSucceeds(setDoc(doc(alice, `users/${ALICE}/servers/some-proj`), { name: 'S' })));

await check('cannot read someone else’s server list', () =>
  assertFails(getDoc(doc(mallory, `users/${ALICE}/servers/some-proj`))));

// ---------- messages ----------
const msgs = (db) => collection(db, `dms/${PAIR}/messages`);
const good = { senderUid: ALICE, content: 'hi', sentAt: serverTimestamp(), pendingFor: [BOB],
               expireAt: Timestamp.fromMillis(Date.now() + 30 * DAY) };

await check('participant sends a valid message', () =>
  assertSucceeds(addDoc(msgs(alice), good)));

await check('outsider cannot write to the thread', () =>
  assertFails(addDoc(msgs(mallory), { ...good, senderUid: MALLORY, pendingFor: [BOB] })));

await check('outsider cannot read the thread', () =>
  assertFails(getDoc(doc(mallory, `dms/${PAIR}/messages/anything`))));

await check('cannot forge another user as sender', () =>
  assertFails(addDoc(msgs(bob), { ...good, senderUid: ALICE, pendingFor: [ALICE] })));

await check('cannot backdate sentAt', () =>
  assertFails(addDoc(msgs(alice), { ...good, sentAt: Timestamp.fromMillis(Date.now() - 90 * DAY) })));

await check('cannot list self as pending', () =>
  assertFails(addDoc(msgs(alice), { ...good, pendingFor: [ALICE, BOB] })));

await check('empty content rejected', () =>
  assertFails(addDoc(msgs(alice), { ...good, content: '' })));

// ack + delete paths, seeded with admin so we control sentAt exactly
let freshId, oldId, oldDeliveredId;
await env.withSecurityRulesDisabled(async (ctx) => {
  const db = ctx.firestore();
  const mk = async (sentAtMs, pendingFor) => {
    const ref = doc(collection(db, `dms/${PAIR}/messages`));
    await setDoc(ref, { senderUid: ALICE, content: 'x', sentAt: Timestamp.fromMillis(sentAtMs), pendingFor,
                        expireAt: Timestamp.fromMillis(sentAtMs + 30 * DAY) });
    return ref.id;
  };
  freshId = await mk(Date.now() - DAY, [BOB]);
  oldId = await mk(Date.now() - 45 * DAY, [BOB]);
  oldDeliveredId = await mk(Date.now() - 45 * DAY, []);
});

const ref = (db, id) => doc(db, `dms/${PAIR}/messages/${id}`);

await check('recipient acks by removing self', () =>
  assertSucceeds(updateDoc(ref(bob, freshId), { pendingFor: [] })));

await check('cannot edit message content', () =>
  assertFails(updateDoc(ref(bob, oldId), { content: 'tampered' })));

await check('cannot add someone to pendingFor', () =>
  assertFails(updateDoc(ref(bob, oldId), { pendingFor: [ALICE, BOB] })));

await check('SWEEP: old undelivered message can be deleted', () =>
  assertSucceeds(deleteDoc(ref(alice, oldId))));

await check('delivered message can be deleted', () =>
  assertSucceeds(deleteDoc(ref(alice, oldDeliveredId))));

await check('NO UNSEND: fresh undelivered message cannot be deleted', async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), `dms/${PAIR}/messages/fresh2`),
      { senderUid: ALICE, content: 'x', sentAt: Timestamp.fromMillis(Date.now() - DAY), pendingFor: [BOB],
        expireAt: Timestamp.fromMillis(Date.now()) });
  });
  await assertFails(deleteDoc(ref(alice, 'fresh2')));
});

await env.cleanup();

for (const [status, name] of results) console.log(`${status}  ${name}`);
const failed = results.filter(([s]) => s === 'FAIL').length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
