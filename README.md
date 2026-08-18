# Tether

Federated, self-hosted chat. DMs and Discord-style communities that run on
infrastructure you own — see [`docs/BUILD_DOC.md`](docs/BUILD_DOC.md) for the
architecture and the full phase plan.

## Status

Phase 0/1: real Firebase Auth, the real DM data model, real security rules, and
native OS notifications. Servers (communities), the global directory project,
and tray residency are not built yet.

## Running it

```bash
npm install
npm start
```

`npm start` bundles the renderer and launches Electron.

You'll be asked to sign in (email/password, or Google). Once in, the header shows
**your UID** — send that to whoever you want to talk to, paste theirs into the
peer box, and hit Open. Both sides land on the same thread because the thread id
is just the two UIDs sorted and joined.

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
| `shared/schema.js`  | `pairId` / message shape, used by both processes          |
| `public/`           | Landing page deployed to Firebase Hosting                 |
| `firestore.rules`   | DM security rules                                          |

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

- **TTL policy is not enabled.** Firestore TTL requires the Blaze plan; this
  project is on Spark. Delivered messages are still cleaned up (the sender
  deletes them once the recipient acks), but a message sent to someone who never
  comes back will sit there forever until billing is enabled and the policy from
  `docs/TTL.md` is applied. This only affects the undelivered server copy —
  delivered messages are already safe in local history.
- **Google sign-in is untested.** The popup flow is wired up and the main process
  allows the auth window, but `file://` renderer origins are an awkward fit for
  Firebase's popup flow. Email/password is the safe path for now.
- Not yet tray-resident; closing the window ends the listener (Phase 2).
