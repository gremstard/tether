# Message cleanup without a TTL policy

Tether runs on the Spark (free) plan permanently. Firestore's native TTL feature
is a Blaze feature, so there is no server-side expiry and no Cloud Function
sweeping anything. Cleanup is entirely client-driven, in two distinct paths.

## 1. Delivered messages — deleted on ack

The normal path, unchanged since Phase 1. The recipient copies a message into
local history, removes itself from `pendingFor`, and once that array is empty the
sender deletes the server copy. Typical latency is seconds, and nothing
accumulates.

## 2. Abandoned messages — the sweep

The path that replaces a TTL policy. A message sent to someone who never comes
back stays `pendingFor` them forever, so each client periodically deletes
messages in its own threads that are

- older than the cutoff (default 30 days), **and**
- still `pendingFor` somebody.

Both participants sweep the same thread; whoever gets there first wins, and the
loser's delete of an already-missing document is a harmless no-op. See
[`renderer/sweep.js`](../renderer/sweep.js), with the predicate itself in
[`shared/schema.js`](../shared/schema.js) so it is identical wherever it runs.

There is also a manual **Clear now** button in Settings that runs exactly the
same logic on demand, against the same cutoff.

## The floor, and why the cutoff is not freely configurable downward

`firestore.rules` permits deleting a still-pending message only once it is older
than `SWEEP_MIN_AGE_DAYS` (30 days). Without that floor, "delete undelivered
messages" would be an unsend button: either participant could delete a message
the other simply had not collected yet, which is exactly what the delete-on-ack
design exists to prevent.

So the cutoff is configurable **upward** freely. Setting it below 30 days will
not work — the rules reject those deletes — and the client clamps it and says so
rather than silently failing. To sweep more aggressively than 30 days you must
lower `SWEEP_MIN_AGE_DAYS` in `shared/schema.js`, change the matching
`sweepFloor()` in `firestore.rules`, and redeploy:

```bash
firebase deploy --only firestore:rules
```

## Where this runs

Currently in the renderer, because that is where the Firestore listener lives.
In Phase 2 both move into the tray process together — the policy is already
process-agnostic and takes its database handle as an argument, so relocating it
is a wiring change, not a rewrite.

## What the sweep never touches

Local history. The sweep deletes the *server's* copy of messages nobody
collected. Your own copy of a conversation is on disk and is removed only when
you press *Clear history*.
