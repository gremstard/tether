# Tether

Federated, self-hosted chat. DMs and Discord-style communities that run on
infrastructure you own — see [`docs/BUILD_DOC.md`](docs/BUILD_DOC.md) for the
architecture and the full phase plan.

## Status

Phases 0–3: real Firebase Auth with usernames, the real DM data model, rules
covered by an emulator test suite, local message history, native OS
notifications, tray residency with start-at-login, multiple conversations that
all receive in the background, and servers — Discord-style communities, each in
its own Firebase project.

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

To talk to someone, type their username and hit Open. They appear in the
conversation list on the left and stay there across restarts — every
conversation receives messages in the background, not just the one on screen.
It resolves to their UID
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
| `main/tray.js`      | Menu-bar / tray presence, start-at-login                   |
| `scripts/make-icons.js` | Generates the tray and app icons                      |
| `renderer/sweep.js` | Client-side cleanup of abandoned messages                  |
| `renderer/threads.js` | Per-conversation intake and the DM list                 |
| `renderer/servers.js` | Connecting to server projects, channels, membership    |
| `templates/server.rules` | Rules a founder deploys into their own project      |
| `renderer/profile.js` | Usernames, avatars, image downscaling                   |
| `shared/schema.js`  | `pairId` / message shape, used by both processes          |
| `public/`           | Landing page deployed to Firebase Hosting                 |
| `firestore.rules`   | DM security rules                                          |

## Testing

```bash
npm run test:rules
```

Runs five suites against the Firestore emulator (needs Java): unit tests,
directory rules, end-to-end DM intake, server rules, and the server client. Since
there is no trusted server code anywhere, the rules are the only enforcement
point — they are worth testing properly.

## Background behaviour

Closing the window keeps Tether resident in the menu bar so messages still
arrive; **Quit Tether** in the tray menu is what actually stops it. Start-at-login
is off until you turn it on, in Settings or the tray menu. See
[`docs/BACKGROUND.md`](docs/BACKGROUND.md).

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
- No group DMs.
- Servers require a founder to create a Firebase project by hand and deploy
  `templates/server.rules` into it — see [`docs/SERVERS.md`](docs/SERVERS.md).
  Automating that needs the Firebase Management API and is out of scope.
- A handle inside a server is unique to that server and is not tied to your
  directory handle; Firebase Auth is per-project and Spark has no way to bridge
  identities.
- Channel messages are read live from the server project — no offline mirror,
  unlike DMs.
- Local history grows until you clear it — there is no retention policy on your
  own copy, by design.
