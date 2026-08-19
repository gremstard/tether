# Testing

```bash
npm test
```

Seven suites. Six exercise modules directly; the seventh launches the real app,
and that one exists because of a specific, repeated failure.

## Why there is an end-to-end suite

Four user-facing breakages shipped while every module test passed:

| What broke | Why the tests missed it |
| --- | --- |
| App reported as "damaged" and would not open | Only appears once packaged and signed |
| Signup died with "insufficient permissions" | The username index was read before sign-in — an ordering only the real flow has |
| Google sign-in failed with `auth/internal-error` | CSP blocked a script; no test loaded the real page |
| Sessions, DMs and servers lost on every launch | The origin moved between launches; nothing restarted the app |

The pattern is the same each time: the bug lived in the wiring between pieces
that behave perfectly in isolation. So the end-to-end suite runs the **real**
main process — its IPC handlers, its local HTTP origin, its message store — and
drives the **real** renderer bundle against the Firebase emulators.

## The suites

| Script | Covers |
| --- | --- |
| `test:unit` | Schema, local store, invite codec, server path whitelist, CSP policy |
| `test:rules` | Directory security rules |
| `test:signup` | The signup ordering constraint and username claims |
| `test:intake` | DM delivery, acking and local persistence, under real rules |
| `test:server-rules` | A server project's rules |
| `test:servers` | The server client against those rules |
| `test:e2e` | The whole app: signup, messaging, restart |

Emulator suites need Java. The end-to-end suite needs a display (CI runs it
under `xvfb`).

## The two phases, and why

`test:e2e` launches the app **twice** against one profile directory:

- **signup** — create an account through the real form, resolve a username,
  open a conversation, send a message.
- **restore** — relaunch and check the session, conversation list and local
  history all came back.

The split is the point. An earlier version recreated the window inside a single
process, which kept the same origin and so passed happily even with the
ephemeral-port bug that was losing sessions. Only a genuine process restart
reproduces what a user does.

## Verifying the tests actually catch things

A regression suite that has never failed proves nothing. Each guard here was
checked by reintroducing the original bug and confirming a red run:

- Restoring the pre-signup username lookup → `signup signs the user in` fails.
- Returning the renderer to an ephemeral port → `stays signed in across a real
  restart` fails, along with `origin is identical to the previous launch`.

Worth repeating that exercise when adding a guard for a bug that reached users.

## What is still not covered

- **Google sign-in end to end.** It needs a real Google account and consent
  screen. The CSP hosts it depends on are asserted, and the OAuth code exchange
  is unit-tested against the RFC 7636 vector, but the round trip is manual.
- **Windows.** Installers are built in CI but never run; there is no Windows
  machine in the loop.
- **Two machines.** Delivery between two real installs, and the "message arrives
  while the other machine was off" case, remain manual.
