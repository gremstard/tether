# Tether

Federated, self-hosted chat. DMs and Discord-style communities that run on
infrastructure you own — see [`docs/BUILD_DOC.md`](docs/BUILD_DOC.md) for the
architecture and the full phase plan.

## Status

Phase 0/1 plus usernames: real Firebase Auth, the real DM data model, rules
covered by an emulator test suite, local message history, and native OS
notifications. Servers (communities) and tray residency are not built yet.

Tether runs on the Firebase **Spark** plan permanently — no Cloud Functions, no
Cloud Storage, no TTL policies. See [`docs/DECISIONS.md`](docs/DECISIONS.md) for
what that replaces and why.

## Running it

```bash
npm install
npm start
```

`npm start` bundles the renderer and launches Electron.

Sign up with a username, email and password, or use Google — Google sign-in adds
a short step to claim a username, since the OAuth popup alone doesn't give you
one. Handles are unique, immutable, and 3–20 characters of `a-z`, `0-9`, `_`.

To talk to someone, type their username and hit Open. It resolves to their UID
through the `usernames/` index, and both sides land on the same thread because
the thread id is just the two UIDs sorted and joined.

To test properly you need two accounts. Two machines is the real test; two
accounts on one machine works for a smoke test.

## Local history

Firestore is transport, not storage. A message lands there, each recipient copies
it into local history, acks it, and the server copy is deleted once nobody is
waiting on it. The UI renders from local history — **not** from Firestore — so
your conversation stays put after the server cleans up, and only disappears when
you press *Clear history*.

The ordering is load-bearing: a received message is written to disk **before**
it is acked, since acking is what authorizes deletion. If the write fails, the
ack is skipped and the message stays on the server for the next attempt.

History lives in the Electron user-data directory (`threads/{pairId}.json`), owned
by the main process — the Phase 2 tray listener runs there and must be able to
record messages with no window open. See [`main/store.js`](main/store.js).

## Layout

| Path                | What's in it                                              |
| ------------------- | --------------------------------------------------------- |
| `main/`             | Electron main process — window, native notifications, IPC |
| `renderer/`         | UI, Firestore listeners, auth                             |
| `main/store.js`     | Local message history, one JSON file per thread            |
| `main/invite.js`    | Self-contained server invite codes                        |
| `renderer/sweep.js` | Client-side cleanup of abandoned messages                  |
| `renderer/profile.js` | Usernames, avatars, image downscaling                   |
| `shared/schema.js`  | `pairId` / message shape, used by both processes          |
| `public/`           | Landing page deployed to Firebase Hosting                 |
| `firestore.rules`   | DM security rules                                          |

## Testing

```bash
npm run test:rules
```

Runs 25 security-rule cases against the Firestore emulator (needs Java). Since
there is no trusted server code anywhere, the rules are the only enforcement
point — they are worth testing properly.

## Configuration

`config/firebase.config.json` holds the Firebase web app config. It is
gitignored — not because it's secret (Firebase client configs are meant to be
public; security lives in the Firestore rules) but so a dev project doesn't get
pinned into git history. Copy `config/firebase.config.example.json` to create it.

## Deploying

```bash
firebase deploy --only firestore:rules
```

```bash
firebase deploy --only hosting:chat-tether
```

Live at https://chat-tether.web.app.

## Known gaps

- **Google sign-in is untested.** The popup flow is wired up and the main process
  allows the auth window, but `file://` renderer origins are an awkward fit for
  Firebase's popup flow. Email/password is the safe path for now.
- Not yet tray-resident; closing the window ends both the listener and the sweep
  (Phase 2 moves both into the tray process).
- The sweep only covers threads opened this session, since there is no friends
  list yet to enumerate them from.
- Local history grows until you clear it — there is no retention policy on your
  own copy, by design.
