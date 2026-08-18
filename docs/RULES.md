# Firestore security rules

Deployed from [`firestore.rules`](../firestore.rules). Tether is on the Spark
plan by design: no Cloud Functions, no admin-side validation, no trusted server
code anywhere. Every write is made directly by a client, so **the rules are the
only enforcement point in the system** and are written assuming the client is
hostile.

They are covered by an emulator test suite — 25 cases, each asserting a specific
attack is refused or a specific legitimate operation is allowed:

```bash
npm run test:rules
```

## Thread membership comes from the path

A DM thread lives at `dms/{pairId}`, where `pairId` is the two participants'
UIDs sorted and joined with `_`. The path names exactly who belongs there, so
membership is read straight off it — no lookup document, no extra read per
message. Firebase UIDs are alphanumeric, so `_` never appears inside one.

## Messages

- **Read** — only the two UIDs in the path.
- **Create** — `senderUid` must equal the caller (no forging messages from
  someone else), `sentAt` must be `request.time` (no backdating a message into
  sweep range), content must be a non-empty string under 4000 chars, and
  `pendingFor` may only contain participants and must not contain the sender.
- **Update** — the only legal edit is removing yourself from `pendingFor`, i.e.
  acking. Content is immutable, and you cannot add anyone to the list.
- **Delete** — permitted in exactly two cases:
  1. `pendingFor` is empty — everyone has it.
  2. The message is older than the 30-day sweep floor — nobody ever collected
     it. This is what replaces a native TTL policy.

  The age floor in case 2 is load-bearing: without it, deleting a still-pending
  message would be an unsend button. See [CLEANUP.md](CLEANUP.md).

## Usernames

`usernames/{username} -> { uid }` is a pure uniqueness and lookup index.

Uniqueness is **structural, not checked**: the username is the document id, and
`create` is only allowed where no document exists. Firestore evaluates a create
against a non-existent resource, so two clients racing for the same handle can
never both win — the loser's write is rejected by the engine, not by a
comparison we could lose a race on.

- **Read** — any signed-in user (resolving a handle is the point).
- **Create** — the new doc's `uid` must be the caller's own, it may contain no
  other fields, and the id must match `^[a-z0-9_]{3,20}$`.
- **Update / delete** — refused outright. A handle is immutable once claimed:
  update would let someone repoint an existing handle at another account, and
  delete would let them free a handle for an impersonator to re-claim.

## Profiles

`users/{uid}` is readable by any signed-in user and writable only by its owner.
`pfpBase64` is capped at 400,000 characters, keeping it clear of Firestore's
1 MiB per-document limit (avatars are base64 in the document, not in Cloud
Storage — see [IMAGES.md](IMAGES.md)).

### One deliberate gap

`users/{uid}.username` is a denormalized copy for display and is **not** verified
against the index. It cannot be: the profile and the username claim are written
in a single atomic batch, and rules `get()` cannot see a document created in the
same commit. That is not a guess — the emulator test `ATOMIC BATCH` fails with
`PERMISSION_DENIED` when the check is present.

Given the choice between atomicity and that check, atomicity wins, because the
check buys very little: `usernames/{username} -> uid` remains authoritative, and
it is the only direction the app ever relies on. Peers are always resolved
handle → uid through the index, never by trusting a profile's self-reported
handle. A user who writes a false `username` into their own profile changes
nothing about who a handle resolves to; they have only lied to themselves.

## Server projects

Each community is its own Firebase project with its own rules, so nothing here
governs them. A server's icon lives as `iconBase64` on its `serverInfo`
document under the same 400,000-character cap, and joining is done with a
self-contained invite code rather than a Cloud Function — see
[INVITES.md](INVITES.md).

## Deploying

```bash
firebase deploy --only firestore:rules
```
