// Exercises the loopback OAuth flow without Google: intercepts the browser
// hand-off, then drives the callback the way a browser (or an attacker) would.
// Run under electron, because the module opens an external URL.
'use strict';

const { app, shell } = require('electron');
const googleAuth = require('../main/google-auth.js');

const out = [];
const ok = (n, c) => out.push([c ? 'PASS' : 'FAIL', n]);

/** Start a flow, capturing the URL it would have opened in the browser. */
function startFlow() {
  let resolveUrl;
  const opened = new Promise((r) => { resolveUrl = r; });
  const original = shell.openExternal;
  shell.openExternal = async (url) => { resolveUrl(new URL(url)); };
  const promise = googleAuth
    .signInWithGoogle({ clientId: 'test-client.apps.googleusercontent.com' })
    .finally(() => { shell.openExternal = original; });
  promise.catch(() => {}); // each case asserts on the rejection itself
  return { promise, opened };
}

const hit = (redirectUri, params) =>
  fetch(`${redirectUri}?${new URLSearchParams(params)}`).then((r) => r.status);

app.whenReady().then(async () => {
  // --- the authorization request ---
  {
    const { promise, opened } = startFlow();
    const url = await opened;
    const q = url.searchParams;

    ok('opens Google, not an in-app window', url.origin + url.pathname === googleAuth.AUTH_ENDPOINT);
    ok('uses the authorization code flow', q.get('response_type') === 'code');
    ok('uses PKCE with S256', q.get('code_challenge_method') === 'S256' && !!q.get('code_challenge'));
    ok('never sends the verifier to the browser', !url.search.includes('code_verifier'));
    ok('redirects to loopback only', /^http:\/\/127\.0\.0\.1:\d+\/callback$/.test(q.get('redirect_uri')));
    ok('requests the scopes Firebase needs', q.get('scope') === 'openid email profile');
    ok('carries a state value', (q.get('state') || '').length >= 16);

    const status = await hit(q.get('redirect_uri'), { code: 'stolen', state: 'wrong-state' });
    ok('forged state is rejected with 400', status === 400);
    let err;
    try { await promise; } catch (e) { err = e; }
    ok('state mismatch rejects the sign-in', /security check|state mismatch/i.test((err && err.message) || ''));
  }

  // --- user declines in the browser ---
  {
    const { promise, opened } = startFlow();
    const url = await opened;
    await hit(url.searchParams.get('redirect_uri'),
      { error: 'access_denied', state: url.searchParams.get('state') });
    let err;
    try { await promise; } catch (e) { err = e; }
    ok('declining in the browser reports cancellation', /cancelled/i.test((err && err.message) || ''));
  }

  // --- a valid-looking callback with no code ---
  {
    const { promise, opened } = startFlow();
    const url = await opened;
    const status = await hit(url.searchParams.get('redirect_uri'),
      { state: url.searchParams.get('state') });
    ok('missing code is rejected with 400', status === 400);
    let err;
    try { await promise; } catch (e) { err = e; }
    ok('missing code fails clearly', /no authorization code/i.test((err && err.message) || ''));
  }

  // --- unrelated paths on the loopback port ---
  {
    const { promise, opened } = startFlow();
    const url = await opened;
    const base = url.searchParams.get('redirect_uri').replace('/callback', '');
    const status = await fetch(base + '/').then((r) => r.status);
    ok('loopback server serves nothing but /callback', status === 404);
    await hit(url.searchParams.get('redirect_uri'),
      { error: 'access_denied', state: url.searchParams.get('state') });
    try { await promise; } catch (e) { /* expected */ }
  }

  // --- misconfiguration ---
  {
    let err;
    try { await googleAuth.signInWithGoogle({}); } catch (e) { err = e; }
    const msg = (err && err.message) || '';
    ok('missing client id fails with a pointer to the docs',
       /not configured/i.test(msg) && /GOOGLE_SIGNIN/i.test(msg));
  }

  for (const [s, n] of out) console.log(`${s}  ${n}`);
  const failed = out.filter(([s]) => s === 'FAIL').length;
  console.log(`\n${out.length - failed}/${out.length} passed`);
  app.exit(failed ? 1 : 0);
});
