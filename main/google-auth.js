'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const { shell } = require('electron');

/**
 * Google sign-in for a desktop app (RFC 8252, "OAuth 2.0 for Native Apps").
 *
 * Google refuses OAuth inside embedded browser windows — an in-app popup gets
 * "This browser or app may not be secure", and no user-agent string talks its
 * way past it. The sanctioned flow is the opposite of a popup: hand the user off
 * to their *real* browser, where they can see the address bar and their existing
 * Google session, and catch the result on a loopback port that only this machine
 * can reach.
 *
 * PKCE is what makes that safe without a confidential secret: the authorization
 * code is useless to anyone who intercepts it without the verifier, which never
 * leaves this process.
 */

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const SCOPES = ['openid', 'email', 'profile'];

/** Give up if the user never finishes in the browser. */
const TIMEOUT_MS = 5 * 60 * 1000;

const base64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

/** The S256 transform: base64url(sha256(verifier)), per RFC 7636. */
function challengeFor(verifier) {
  return base64url(crypto.createHash('sha256').update(verifier).digest());
}

/** PKCE pair: a high-entropy verifier and its S256 challenge. */
function createPkce() {
  const verifier = base64url(crypto.randomBytes(32));
  return { verifier, challenge: challengeFor(verifier) };
}

function page(title, message) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>
  body { font: 16px/1.6 -apple-system, "Segoe UI", system-ui, sans-serif;
         background: #14161a; color: #e6e8ec; display: grid; place-items: center;
         height: 100vh; margin: 0; text-align: center; }
  .card { max-width: 26rem; padding: 2rem; }
  h1 { font-size: 1.25rem; margin: 0 0 .5rem; }
  p { color: #8b93a1; margin: 0; }
</style></head>
<body><div class="card"><h1>${title}</h1><p>${message}</p></div></body></html>`;
}

/**
 * Run the whole flow. Resolves with the tokens Firebase needs to sign in.
 */
function signInWithGoogle({ clientId, clientSecret }) {
  if (!clientId) {
    throw new Error(
      'Google sign-in is not configured: no OAuth client id. See docs/GOOGLE_SIGNIN.md'
    );
  }

  const { verifier, challenge } = createPkce();
  // Guards against a different site walking the user into our callback.
  const state = base64url(crypto.randomBytes(16));

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      fn(value);
    };

    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${server.address().port}`);
      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }

      const respond = (status, title, message) => {
        res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(page(title, message));
      };

      const error = url.searchParams.get('error');
      if (error) {
        respond(200, 'Sign-in cancelled', 'You can close this tab and return to Tether.');
        finish(reject, new Error(`Google sign-in was cancelled (${error})`));
        return;
      }

      // A mismatched state means this callback did not come from the request we
      // started, so the code it carries must not be redeemed.
      if (url.searchParams.get('state') !== state) {
        respond(400, 'Something went wrong', 'That sign-in did not match the one Tether started.');
        finish(reject, new Error('Google sign-in failed a security check (state mismatch)'));
        return;
      }

      const code = url.searchParams.get('code');
      if (!code) {
        respond(400, 'Something went wrong', 'No authorization code came back from Google.');
        finish(reject, new Error('Google returned no authorization code'));
        return;
      }

      try {
        const body = new URLSearchParams({
          code,
          client_id: clientId,
          redirect_uri: `http://127.0.0.1:${server.address().port}/callback`,
          grant_type: 'authorization_code',
          code_verifier: verifier,
        });
        // Desktop clients are issued a secret, but RFC 8252 is explicit that it
        // is not confidential; PKCE is what actually protects the exchange.
        if (clientSecret) body.set('client_secret', clientSecret);

        const response = await fetch(TOKEN_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body,
        });
        const tokens = await response.json();

        if (!response.ok || !tokens.id_token) {
          const detail = tokens.error_description || tokens.error || `HTTP ${response.status}`;
          respond(200, 'Sign-in failed', 'You can close this tab and return to Tether.');
          finish(reject, new Error(`Google token exchange failed: ${detail}`));
          return;
        }

        respond(200, 'You are signed in', 'You can close this tab and return to Tether.');
        finish(resolve, { idToken: tokens.id_token, accessToken: tokens.access_token ?? null });
      } catch (err) {
        respond(200, 'Sign-in failed', 'You can close this tab and return to Tether.');
        finish(reject, err);
      }
    });

    const timer = setTimeout(
      () => finish(reject, new Error('Google sign-in timed out')),
      TIMEOUT_MS
    );

    server.on('error', (err) => finish(reject, err));

    // Port 0: desktop OAuth clients may use any loopback port, so nothing has to
    // be pinned or registered in the Google console.
    server.listen(0, '127.0.0.1', () => {
      const redirectUri = `http://127.0.0.1:${server.address().port}/callback`;
      const authUrl = new URL(AUTH_ENDPOINT);
      authUrl.search = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: SCOPES.join(' '),
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state,
        prompt: 'select_account',
      }).toString();

      shell.openExternal(authUrl.toString());
    });
  });
}

module.exports = {
  signInWithGoogle,
  createPkce,
  challengeFor,
  base64url,
  AUTH_ENDPOINT,
  TOKEN_ENDPOINT,
};
