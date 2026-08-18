# Decision amendments

[`BUILD_DOC.md`](BUILD_DOC.md) is kept as the original architecture brief. These
decisions supersede parts of it. Where the two disagree, this file wins.

## 1. Spark permanently — no Blaze, ever

The build doc treats several Blaze features as available. They are not, and this
is not a temporary state pending a billing upgrade. Nothing in the codebase
should prompt for billing setup or describe Spark as a stopgap.

| Build doc said | Now |
| --- | --- |
| Firestore TTL policy on `expireAt` (§3.3, §5) | Client-side sweep — [CLEANUP.md](CLEANUP.md) |
| Firebase Storage for avatars/icons (§4 Phase 5) | Base64 in the document — [IMAGES.md](IMAGES.md) |
| Cloud Function to resolve invite codes (§3.2, §4 Phase 4, §5) | Self-contained client-side codes — [INVITES.md](INVITES.md) |
| Cloud Functions for cleanup jobs (§3.3, §5) | Covered by ack-delete plus the sweep |

`expireAt` is still written on every message. It costs nothing, documents intent,
and means a TTL policy would work immediately if this decision were ever
reversed — but nothing depends on it today.

## 2. Friends are added by username, not UID

The build doc left this open (§7: "Unique searchable usernames vs. just
UIDs/codes"). Decided: usernames.

`usernames/{username} -> { uid }` is a uniqueness and lookup index. Adding
someone resolves their handle to a UID through it and then proceeds to
`dms/{pairId}` exactly as before — the DM model is unchanged, only how you name
the other person. Rules detail in [RULES.md](RULES.md).

## 3. Signup requires a username

- **Email/password** — three fields, and the handle is claimed together with the
  profile in one atomic batch.
- **Google** — the OAuth popup produces an auth user with no profile, so a
  "finish setting up" step collects the handle before the app opens. Same
  uniqueness rules.

Sign-in and sign-up are now separate actions. Previously the app signed in and
created the account if it did not exist, which under a username requirement
would strand a mistyped password as a new account with no handle.

## 4. Identity is per-project inside servers

Not a choice so much as a constraint the build doc did not anticipate. §3.2
describes `members/{uid}` restricting access, but a server is a separate Firebase
project and **Firebase Auth is per-project**, so that uid is not the user's
directory uid. Unifying them needs custom tokens, which need Cloud Functions,
which need Blaze.

So members authenticate to each server project separately, and handles are held
unique per server rather than globally. Details and the trust consequences are in
[SERVERS.md](SERVERS.md).

## Consequences for what was already built

- **Delete-on-ack is unchanged**, and remains the primary cleanup path. The
  sweep is strictly additional, covering only the case delete-on-ack cannot:
  messages nobody ever collected.
- **The delete rule had to change.** It previously permitted deletion *only*
  when `pendingFor` was empty — deliberately, so nobody could delete a message
  out from under a recipient who had not received it. A sweep that deletes
  still-pending messages is the exact case that rule forbade, so deletion is now
  also allowed past a 30-day floor. The floor preserves the original guarantee
  for any message recent enough to still plausibly be collected.
- **Local persistence is unaffected, and makes the sweep safe.** Because each
  client copies messages to disk before acking, sweeping the server copy cannot
  destroy a delivered conversation. The sweep only ever discards messages that
  were never delivered to anyone.
