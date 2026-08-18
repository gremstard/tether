# Server invite codes

Joining a community means pointing your client at the founder's Firebase
project. With no Cloud Functions (Spark) there is nothing server-side to resolve
an invite code against, so a code is fully self-contained: it *is* the client
config, packed into a shareable string, and the invitee's client unpacks it
locally.

See [`main/invite.js`](../main/invite.js).

```
TTHR1-U7UKJH-62LKY4-FSKI23-...
```

## What is actually in a code

The six client-config fields — but only three of them travel:

- `authDomain` is always `{projectId}.firebaseapp.com`
- `storageBucket` is always `{projectId}.firebasestorage.app`
- `messagingSenderId` is already embedded inside `appId`

so those are recomputed on the far side. The fixed `AIzaSy` prefix on the API key
is stripped, the app id is split into its numeric sender id and hex suffix and
stored as bytes, and the result is encrypted and base32-encoded in readable
dash-separated blocks.

**Generic compression was tried first and made things worse.** A Firebase config
is mostly high-entropy keys; deflating the JSON produced a 312-character code
against 292 characters of raw JSON. Packing the structure instead produces 161.
Deflate is still used on the fallback path, for configs that do not match the
expected field shapes and so have to carry their field names.

## On "encrypted"

Stated plainly, because it would be easy to mistake this for security: **the key
ships inside the app.** Anyone with a copy of Tether can decode any invite code.
This is obfuscation, not confidentiality.

That is acceptable — a Firebase client config is public by design, and security
lives in that project's Firestore rules — but it means:

- An invite code is **not** an access-control mechanism. Anyone who obtains one
  can attempt to join. Membership is enforced by the server project's `members/`
  collection and its rules, never by possession of a code.
- Nothing secret may ever be put in a code.

What the encryption does buy is authentication of *integrity*: a mistyped or
tampered code fails its GCM tag and is rejected with a clear error rather than
silently producing a broken config.
