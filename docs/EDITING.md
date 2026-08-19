# Editing and deleting messages

Both are limited to messages you sent. The mechanism differs sharply between a
DM and a channel, because the two store messages for opposite reasons.

## Channels: edit the message

A channel message is community history living in the server's own project, so
there is a message there to change. The author may rewrite its text; the rules
allow no other field to move, so authorship and timestamp are fixed, and
`editedAt` must be set — a **silent** rewrite of something people already read
would be worse than not allowing edits at all. Deletion is the author's or the
founder's.

## DMs: send a revision

A delivered DM is already gone. The recipient copied it to local history, acked,
and cleanup removed the server copy — there is nothing left to mutate, and no
channel through which a change could travel.

So an edit or a deletion travels the same way the original did: as its own
document under `dms/{pairId}/revisions/{id}`, carrying the `targetId` of the
message it revises. It is delivered, applied to the recipient's local history,
acked, and cleaned up, exactly like a message. See
[`shared/schema.js`](../shared/schema.js) and
[`renderer/threads.js`](../renderer/threads.js).

Two consequences worth being clear about:

- **An edit needs the other person to be reachable eventually.** If they never
  come back, the revision expires with everything else, and their copy keeps
  whatever it already had.
- **A revision can arrive before the message it revises**, since messages and
  revisions are separate listeners with no ordering between them. The store
  holds an unmatched revision and applies it the moment its target lands, so
  nothing is lost to that race.

## Who may revise what

Rules cannot check that a reviser sent the original, because the original may
not exist any more. They enforce only that nobody can publish a revision under
someone else's name.

The real check happens at the recipient: they hold the original, so they refuse
any revision whose `senderUid` does not match the message it points at. That is
the one place the claim is verifiable, and it is tested directly — a forged edit
and a forged delete both leave the stored message untouched.

## Unsend

Deleting a DM you sent also removes the server copy if it is still there. If the
recipient has not collected it yet, they never will.

This reverses part of an earlier rule. Deletion used to require that a message
be delivered or older than the sweep floor, so that nobody could destroy a
message the other person had not picked up yet. That guarantee still holds for
**everyone but the author** — the recipient cannot delete a fresh message, and
the sweep still cannot reap one. What changed is that a sender may now withdraw
their own words, which is the point of the feature.
