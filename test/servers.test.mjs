// Exercises the real server client logic against templates/server.rules.
import fs from 'node:fs';
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const serverSchema = require('../shared/server.js');

const FOUNDER = 'founder1', JOINER = 'joiner01', OUTSIDER = 'outsider';
const out = [];
const ok = (n, c) => out.push([c ? 'PASS' : 'FAIL', n]);
const fails = async (n, fn) => {
  try { await fn(); out.push(['FAIL', `${n} — was allowed`]); }
  catch { out.push(['PASS', n]); }
};

const env = await initializeTestEnvironment({
  projectId: 'tether-servers-test',
  firestore: { rules: fs.readFileSync('templates/server.rules', 'utf8'), host: '127.0.0.1', port: 8085 },
});
await env.clearFirestore();

const founderDb = env.authenticatedContext(FOUNDER).firestore();
const joinerDb = env.authenticatedContext(JOINER).firestore();
const outsiderDb = env.authenticatedContext(OUTSIDER).firestore();

const {
  createServer, joinServer, listChannels, createChannel,
  postToChannel, watchChannel, readServerInfo,
} = await import('../renderer/servers.js');

// --- founding ---
const info = await createServer(founderDb, FOUNDER, { name: 'Test Server', username: 'riz' });
ok('createServer writes server identity', info?.name === 'Test Server' && info.founderUid === FOUNDER);
ok('founding creates a #general channel',
   (await listChannels(founderDb)).some((c) => c.id === 'general'));

await fails('cannot found a server in an occupied project',
  () => createServer(outsiderDb, OUTSIDER, { name: 'Hijack', username: 'x' }));

// --- joining ---
const joined = await joinServer(joinerDb, JOINER, 'bobby');
ok('joinServer records membership', joined.info?.name === 'Test Server');
ok('first claim of a handle succeeds', joined.handleTaken === false);

// A second person wanting the same handle still gets in, just without it.
const clash = await joinServer(outsiderDb, OUTSIDER, 'bobby');
ok('handle clash does not block joining', clash.handleTaken === true);

// --- channel access ---
ok('member can list channels', (await listChannels(joinerDb)).length >= 1);
await fails('non-member cannot create a channel', () => createChannel(joinerDb, 'sneaky'));
ok('founder can create a channel', (await createChannel(founderDb, 'Dev Ops')) === 'dev-ops');

// --- posting and reading ---
await postToChannel(joinerDb, 'general', { senderUid: JOINER, username: 'bobby', content: 'hello all' });
const seen = await new Promise((resolve) => {
  const stop = watchChannel(founderDb, 'general', {
    onMessages: (msgs) => { if (msgs.length) { stop(); resolve(msgs); } },
    onError: () => { stop(); resolve([]); },
  });
  setTimeout(() => { stop(); resolve([]); }, 5000);
});
ok('message posted by a member is visible to others',
   seen.some((m) => m.content === 'hello all' && m.username === 'bobby'));

await fails('cannot post as somebody else',
  () => postToChannel(joinerDb, 'general', { senderUid: FOUNDER, username: 'riz', content: 'forged' }));

// A truly unrelated account (never joined) must see nothing.
await env.clearFirestore();
await createServer(founderDb, FOUNDER, { name: 'Private', username: 'riz' });
await fails('stranger cannot read channels', () => listChannels(outsiderDb));
ok('stranger can still preview server identity',
   (await readServerInfo(outsiderDb))?.name === 'Private');

await env.cleanup();
for (const [s, n] of out) console.log(`${s}  ${n}`);
const failed = out.filter(([s]) => s === 'FAIL').length;
console.log(`\n${out.length - failed}/${out.length} passed`);
process.exit(failed ? 1 : 0);
