# Google sign-in

Google sign-in opens your **real browser** rather than a window inside Tether.
That is not a preference — Google refuses OAuth inside embedded browser windows
and answers with *"This browser or app may not be secure"*. The supported path
for desktop apps is [RFC 8252](https://datatracker.ietf.org/doc/html/rfc8252),
which is what Slack, Discord and VS Code do too.

## What happens when you click it

1. Tether opens a loopback listener on `127.0.0.1`, on a random port.
2. Your browser opens Google's consent page.
3. You sign in there, with your normal session and a visible address bar.
4. Google redirects to `http://127.0.0.1:<port>/callback` with a one-time code.
5. Tether exchanges that code for an ID token and signs into Firebase with it.

The code is protected by **PKCE**: the verifier never leaves the app, so an
intercepted code cannot be redeemed by anyone else. A `state` value is checked on
the way back, so a callback Tether did not initiate is refused.

## One-time setup

Google sign-in needs an OAuth client id. Without one the button reports that it
is not configured, and email/password still works.

1. Open the [Google Cloud Console credentials page](https://console.cloud.google.com/apis/credentials)
   and select the **tether-84195** project (the same project as the Firebase app).
2. **Create credentials → OAuth client ID**.
3. Application type: **Desktop app**. Name it anything (e.g. "Tether desktop").
4. Create it, then copy the **client ID** (and the client secret, if shown).

   *Desktop* matters: that client type permits a loopback redirect on any port,
   so nothing has to be registered or pinned. A *Web* client would reject the
   redirect unless every possible port were listed in advance.
5. Add it to `config/firebase.config.default.json` (or your local
   `config/firebase.config.json`):

   ```json
   {
     "apiKey": "…",
     "projectId": "tether-84195",
     "googleOAuth": {
       "clientId": "1234567890-abc123.apps.googleusercontent.com",
       "clientSecret": "GOCSPX-…"
     }
   }
   ```

On the client secret: for an installed app it is **not** a secret, and RFC 8252
says so explicitly — it ships inside every copy of the app and anyone can read
it. PKCE is what actually protects the exchange. Do not treat this value as
sensitive, and do not reuse a web client's secret here.

## If the consent screen has not been configured

A brand-new project may ask you to configure the OAuth consent screen first.
Choose **External**, give it an app name and your email, and save. While the app
is in "testing" mode, only accounts listed as test users can sign in — add
whoever needs access, or publish the app.

## Troubleshooting

| What you see | What it means |
| --- | --- |
| "This browser or app may not be secure" | The old in-app popup flow. Update to the version that opens your real browser. |
| `auth/internal-error` | Usually a CSP or origin problem rather than OAuth — see [PACKAGING.md](PACKAGING.md). |
| "Google sign-in is not configured" | No `googleOAuth.clientId` in the config. |
| `redirect_uri_mismatch` | The client was created as **Web** rather than **Desktop**. |
| "Access blocked: app not verified" | Consent screen is in testing mode and your account is not a test user. |
| Nothing happens | The browser opened behind the app window. Check other windows. |

## Tests

[`test/google-auth.test.cjs`](../test/google-auth.test.cjs) drives the flow
without Google: it intercepts the browser hand-off and then replays callbacks the
way a browser — or an attacker — would, asserting that a forged `state` is
refused, a cancelled sign-in reports cleanly, and the loopback listener serves
nothing but `/callback`.

```bash
npm run test:google
```
