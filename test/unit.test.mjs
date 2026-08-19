// Unit tests for the pieces that don't need the Firestore emulator.
// Run with: npm run test:unit
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const schema = require('../shared/schema.js');
const { MessageStore } = require('../main/store.js');
const { encodeInvite, decodeInvite } = require('../main/invite.js');

const results = [];
const is = (name, actual, expected) =>
  results.push([JSON.stringify(actual) === JSON.stringify(expected) ? 'PASS' : `FAIL (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`, name]);
const ok = (name, cond) => results.push([cond ? 'PASS' : 'FAIL', name]);

// ---------- schema ----------
const now = Date.now();
const DAY = 86400000;
is('pairId is order-independent', schema.pairId('bbb', 'aaa'), schema.pairId('aaa', 'bbb'));
is('sender is not pending on their own message',
   schema.newMessage({ senderUid: 'a', recipientUid: 'b', content: 'x' }).pendingFor, ['b']);
is('sweep skips fresh undelivered', schema.sweepable({ pendingFor: ['a'], sentAt: now - DAY }, { now }), false);
is('sweep takes old undelivered', schema.sweepable({ pendingFor: ['a'], sentAt: now - 40 * DAY }, { now }), true);
is('sweep skips delivered', schema.sweepable({ pendingFor: [], sentAt: now - 40 * DAY }, { now }), false);
is('sweep skips unstamped', schema.sweepable({ pendingFor: ['a'], sentAt: null }, { now }), false);
is('usernames are lowercased', schema.normalizeUsername('  RiZ '), 'riz');
is('valid username accepted', schema.isValidUsername('ok_name1'), true);
is('short username rejected', schema.isValidUsername('ab'), false);
is('username with space rejected', schema.isValidUsername('has space'), false);

// ---------- store ----------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tether-test-'));
const store = new MessageStore(dir);
const tid = 'aaa111_zzz999';

await Promise.all(Array.from({ length: 50 }, (_, i) =>
  store.append(tid, { id: `m${i}`, senderUid: 'aaa111', content: `m${i}`, sentAt: 1000 + i })));
is('concurrent appends lose nothing', (await store.load(tid)).length, 50);

await store.append(tid, { id: 'm0', senderUid: 'aaa111', content: 'm0', sentAt: 500 });
is('same id upserts rather than duplicating', (await store.load(tid)).length, 50);
is('kept sorted by sentAt', (await store.load(tid))[0].id, 'm0');
is('survives reopen', (await new MessageStore(dir).load(tid)).length, 50);

for (const bad of ['../../etc/passwd', 'a/b', '..', 'nounderscore']) {
  let threw = false;
  try { await store.load(bad); } catch { threw = true; }
  ok(`rejects unsafe thread id ${JSON.stringify(bad)}`, threw);
}

// Persist-before-ack: the server copy vanishing must not affect local history.
const rec = schema.toLocalRecord('d1', { senderUid: 'zzz999', content: 'hi', sentAt: { toMillis: () => 42 } });
await store.append('bbb222_ccc333', rec);
is('local copy survives server deletion', (await store.load('bbb222_ccc333'))[0].content, 'hi');
await store.clear('bbb222_ccc333');
is('user clear empties the thread', (await store.load('bbb222_ccc333')).length, 0);
fs.rmSync(dir, { recursive: true, force: true });

// ---------- renderer server whitelist ----------
// Security-relevant: this decides what a local HTTP origin will hand out.
const { resolveWithinRoot } = require('../main/server.js');
const ROOT = '/srv/app';

for (const allowed of ['/renderer/index.html', '/renderer/dist/bundle.js', '/assets/icon.png']) {
  ok(`serves ${allowed}`, resolveWithinRoot(ROOT, allowed) !== null);
}

for (const refused of [
  '/main/index.js',                 // app code
  '/config/firebase.config.json',   // local config
  '/../../etc/passwd',              // traversal
  '/renderer/../main/store.js',     // traversal through an allowed prefix
  '/renderer/%2e%2e/main/store.js', // encoded traversal
  '/package.json',
  '/test/unit.test.mjs',
]) {
  ok(`refuses ${refused}`, resolveWithinRoot(ROOT, refused) === null);
}

ok('query strings are ignored when resolving',
   resolveWithinRoot(ROOT, '/assets/icon.png?v=2')?.endsWith('icon.png') === true);

// ---------- PKCE ----------
const { challengeFor, createPkce } = require('../main/google-auth.js');

// RFC 7636 Appendix B.
is('S256 challenge matches the RFC 7636 vector',
   challengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'),
   'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');

const pkce = createPkce();
ok('verifier is within the RFC length bounds',
   pkce.verifier.length >= 43 && pkce.verifier.length <= 128);
ok('verifier and challenge are url-safe',
   /^[A-Za-z0-9\-._~]+$/.test(pkce.verifier) && /^[A-Za-z0-9\-._~]+$/.test(pkce.challenge));
ok('each flow gets a fresh verifier', createPkce().verifier !== pkce.verifier);

// ---------- content security policy ----------
// Firebase's sign-in popup loads Google's gapi script and relays through an
// iframe on the auth domain. A CSP that omits those hosts does not fail
// visibly — it surfaces as a bare "auth/internal-error", which is what broke
// Google sign-in once already. Guard the specific hosts it needs.
const html = fs.readFileSync(new URL('../renderer/index.html', import.meta.url), 'utf8');
const csp = (html.match(/content="([^"]*default-src[^"]*)"/s)?.[1] ?? '').replace(/\s+/g, ' ');
const directive = (name) => csp.match(new RegExp(`${name} ([^;]*)`))?.[1] ?? '';

ok('CSP was found in index.html', csp.length > 0);
ok('script-src allows gapi (else Google sign-in fails)',
   directive('script-src').includes('https://apis.google.com'));
ok('frame-src allows the auth relay iframe',
   directive('frame-src').includes('firebaseapp.com'));
ok('connect-src allows same-origin requests',
   directive('connect-src').includes("'self'"));
ok('connect-src allows the identity APIs',
   directive('connect-src').includes('googleapis.com'));
ok('default-src is still locked to self', directive('default-src').trim() === "'self'");

// ---------- invites ----------
// Shaped like a real config, but not one — the codec only cares about structure.
const cfg = {
  apiKey: 'AIzaSyB1cD3fG7hJ9kL2mN4pQ6rS8tU0vW1xY2z',
  authDomain: 'example-proj.firebaseapp.com',
  projectId: 'example-proj',
  storageBucket: 'example-proj.firebasestorage.app',
  messagingSenderId: '123456789012',
  appId: '1:123456789012:web:abc123def456abc789de',
};
const code = await encodeInvite(cfg);
is('invite round-trips every field', await decodeInvite(code), cfg);
ok('packed code is shorter than raw JSON', code.length < JSON.stringify(cfg).length);
ok('case and spacing tolerated', (await decodeInvite(` ${code.toLowerCase()} `)).projectId === cfg.projectId);
ok('codes differ per encoding', (await encodeInvite(cfg)) !== code);

const odd = { apiKey: 'custom-key', projectId: 'weird_proj', appId: '2:zz:web:qq', messagingSenderId: '7' };
is('fallback path round-trips odd configs', (await decodeInvite(await encodeInvite(odd))).appId, odd.appId);

for (const bad of ['nonsense', 'TTHR1-AAAAAA', code.slice(0, -4) + 'AAAA']) {
  let threw = false;
  try { await decodeInvite(bad); } catch { threw = true; }
  ok(`rejects bad code ${JSON.stringify(bad.slice(0, 14))}`, threw);
}

for (const [status, name] of results) console.log(`${status.startsWith('PASS') ? 'PASS' : status}  ${name}`);
const failed = results.filter(([s]) => !s.startsWith('PASS')).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
