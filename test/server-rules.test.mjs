// Rules for a SERVER project (templates/server.rules).
import fs from 'node:fs';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { doc, setDoc, getDoc, deleteDoc, updateDoc, collection, addDoc, serverTimestamp, Timestamp } from 'firebase/firestore';

const FOUNDER = 'founder1', MEMBER = 'member01', OUTSIDER = 'outsider';
const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push(['PASS', name]); }
  catch (err) { results.push(['FAIL', `${name} — ${err.message.split('\n')[0]}`]); }
};

const env = await initializeTestEnvironment({
  projectId: 'tether-server-test',
  firestore: { rules: fs.readFileSync('templates/server.rules', 'utf8'), host: '127.0.0.1', port: 8085 },
});
await env.clearFirestore();

const founder = env.authenticatedContext(FOUNDER).firestore();
const member = env.authenticatedContext(MEMBER).firestore();
const outsider = env.authenticatedContext(OUTSIDER).firestore();
const anon = env.unauthenticatedContext().firestore();

// ---------- bootstrap ----------
await check('founder claims an empty server', () =>
  assertSucceeds(setDoc(doc(founder, 'serverInfo/main'), { founderUid: FOUNDER, name: 'Test Server' })));

await check('cannot claim a server that already has a founder', () =>
  assertFails(setDoc(doc(outsider, 'serverInfo/main'), { founderUid: OUTSIDER, name: 'Hijacked' })));

await check('cannot name someone else as founder', async () => {
  await env.clearFirestore();
  await assertFails(setDoc(doc(outsider, 'serverInfo/main'), { founderUid: FOUNDER, name: 'x' }));
  await assertSucceeds(setDoc(doc(founder, 'serverInfo/main'), { founderUid: FOUNDER, name: 'Test Server' }));
});

await check('anyone signed in can preview before joining', () =>
  assertSucceeds(getDoc(doc(outsider, 'serverInfo/main'))));

await check('anonymous cannot preview', () =>
  assertFails(getDoc(doc(anon, 'serverInfo/main'))));

await check('founder registers own membership', () =>
  assertSucceeds(setDoc(doc(founder, `members/${FOUNDER}`), { role: 'founder', username: 'riz' })));

await check('oversized server icon rejected', () =>
  assertFails(updateDoc(doc(founder, 'serverInfo/main'), { iconBase64: 'x'.repeat(400001) })));

await check('founder cannot hand off founderUid by update', () =>
  assertFails(updateDoc(doc(founder, 'serverInfo/main'), { founderUid: OUTSIDER })));

// ---------- joining ----------
await check('invitee joins as a member', () =>
  assertSucceeds(setDoc(doc(member, `members/${MEMBER}`), { role: 'member', username: 'bobby' })));

await check('cannot self-appoint as founder', () =>
  assertFails(setDoc(doc(outsider, `members/${OUTSIDER}`), { role: 'founder', username: 'sneaky' })));

await check('cannot create a membership for someone else', () =>
  assertFails(setDoc(doc(outsider, `members/${MEMBER}`), { role: 'member', username: 'x' })));

await check('member cannot promote themselves', () =>
  assertFails(updateDoc(doc(member, `members/${MEMBER}`), { role: 'founder' })));

await check('member may edit own profile fields', () =>
  assertSucceeds(updateDoc(doc(member, `members/${MEMBER}`), { username: 'bobby2' })));

await check('founder may promote a member', () =>
  assertSucceeds(updateDoc(doc(founder, `members/${MEMBER}`), { role: 'founder' })));

await check('founder may remove a member', async () => {
  await assertSucceeds(deleteDoc(doc(founder, `members/${MEMBER}`)));
  await assertSucceeds(setDoc(doc(member, `members/${MEMBER}`), { role: 'member', username: 'bobby' }));
});

// ---------- in-server handles ----------
await check('member claims a free handle', () =>
  assertSucceeds(setDoc(doc(member, 'usernames/bobby'), { uid: MEMBER })));

await check('handle cannot be taken twice', () =>
  assertFails(setDoc(doc(outsider, 'usernames/bobby'), { uid: OUTSIDER })));

// ---------- channels ----------
await check('founder creates a channel', () =>
  assertSucceeds(setDoc(doc(founder, 'channels/general'), { name: 'general' })));

await check('member cannot create a channel', () =>
  assertFails(setDoc(doc(member, 'channels/sneaky'), { name: 'sneaky' })));

await check('member reads channels', () =>
  assertSucceeds(getDoc(doc(member, 'channels/general'))));

await check('outsider cannot read channels', () =>
  assertFails(getDoc(doc(outsider, 'channels/general'))));

// ---------- messages ----------
const msg = { senderUid: MEMBER, username: 'bobby', content: 'hello', sentAt: serverTimestamp() };

await check('member posts to a channel', () =>
  assertSucceeds(addDoc(collection(member, 'channels/general/messages'), msg)));

await check('outsider cannot post', () =>
  assertFails(addDoc(collection(outsider, 'channels/general/messages'), { ...msg, senderUid: OUTSIDER })));

await check('outsider cannot read messages', () =>
  assertFails(getDoc(doc(outsider, 'channels/general/messages/anything'))));

await check('cannot post as another member', () =>
  assertFails(addDoc(collection(member, 'channels/general/messages'), { ...msg, senderUid: FOUNDER })));

await check('cannot backdate a channel message', () =>
  assertFails(addDoc(collection(member, 'channels/general/messages'),
    { ...msg, sentAt: Timestamp.fromMillis(Date.now() - 86400000) })));

let mid;
await env.withSecurityRulesDisabled(async (ctx) => {
  const ref = doc(collection(ctx.firestore(), 'channels/general/messages'));
  await setDoc(ref, { senderUid: MEMBER, username: 'bobby', content: 'x', sentAt: Timestamp.now() });
  mid = ref.id;
});

await check('author may edit their own channel message', () =>
  assertSucceeds(updateDoc(doc(member, `channels/general/messages/${mid}`),
    { content: 'rewritten by its author', editedAt: serverTimestamp() })));

await check('an edit must be marked as edited', () =>
  assertFails(updateDoc(doc(member, `channels/general/messages/${mid}`), { content: 'silently rewritten' })));

await check('another member cannot edit your channel message', () =>
  assertFails(updateDoc(doc(founder, `channels/general/messages/${mid}`),
    { content: 'put words in your mouth', editedAt: serverTimestamp() })));

await check('an edit cannot rewrite authorship', () =>
  assertFails(updateDoc(doc(member, `channels/general/messages/${mid}`),
    { content: 'x', editedAt: serverTimestamp(), senderUid: FOUNDER })));

await check('another member cannot delete your message', () =>
  assertFails(deleteDoc(doc(outsider, `channels/general/messages/${mid}`))));

await check('founder can moderate a message', () =>
  assertSucceeds(deleteDoc(doc(founder, `channels/general/messages/${mid}`))));

await env.cleanup();
for (const [s, n] of results) console.log(`${s}  ${n}`);
const failed = results.filter(([s]) => s === 'FAIL').length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
