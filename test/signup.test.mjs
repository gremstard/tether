// The signup ordering constraint: the username index cannot be read before the
// account exists, because reading it requires an authenticated user.
import fs from 'node:fs';
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const out = [];
const ok = (n, c) => out.push([c ? 'PASS' : 'FAIL', n]);

const env = await initializeTestEnvironment({
  projectId: 'tether-signup-test',
  firestore: { rules: fs.readFileSync('firestore.rules', 'utf8'), host: '127.0.0.1', port: 8085 },
});
await env.clearFirestore();

const { lookupUsername, claimUsername, getProfile } = await import('../renderer/profile.js');

// The bug: a pre-flight availability check, before any account exists.
const anon = env.unauthenticatedContext().firestore();
let preflightError = null;
try {
  await lookupUsername(anon, 'riz');
} catch (err) {
  preflightError = err;
}
// Assert on the code, not the message: the emulator leaves the message empty
// while production says "Missing or insufficient permissions" — which is
// exactly what a user hit when signup pre-checked the handle before signing in.
ok('signed-out lookup is refused (this was the signup bug)',
   preflightError?.code === 'permission-denied');

// The fix: authenticate first, then claim.
const alice = env.authenticatedContext('alice000').firestore();
const claimed = await claimUsername(alice, 'alice000', 'riz', { email: 'riz@example.com' });
ok('signed-in claim succeeds', claimed === 'riz');
ok('profile carries the handle', (await getProfile(alice, 'alice000'))?.username === 'riz');
ok('index resolves the handle', (await lookupUsername(alice, 'riz')) === 'alice000');

// A second person wanting the same handle is refused cleanly, with a message
// the UI can show — not a raw permission error.
const bob = env.authenticatedContext('bob11111').firestore();
let clash = null;
try {
  await claimUsername(bob, 'bob11111', 'riz', {});
} catch (err) {
  clash = err;
}
ok('duplicate claim is refused', clash !== null);
ok('clash reads as "already taken", not a permissions error',
   /already taken/i.test(clash?.message ?? ''));

// And they can still claim a different one — the failed batch left nothing behind.
ok('a different handle still works',
   (await claimUsername(bob, 'bob11111', 'bobby', {})) === 'bobby');
ok('failed claim wrote no profile for the loser',
   (await getProfile(bob, 'bob11111'))?.username === 'bobby');

// Case-insensitivity: nobody can hold Riz and riz separately.
const carol = env.authenticatedContext('carol001').firestore();
let caseClash = null;
try { await claimUsername(carol, 'carol001', 'RIZ', {}); } catch (err) { caseClash = err; }
ok('handles are case-insensitive', caseClash !== null);

await env.cleanup();
for (const [s, n] of out) console.log(`${s}  ${n}`);
const failed = out.filter(([s]) => s === 'FAIL').length;
console.log(`\n${out.length - failed}/${out.length} passed`);
process.exit(failed ? 1 : 0);
