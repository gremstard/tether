# Firestore security rules

Deployed from `firestore.rules`. The whole model rests on one trick: a DM thread
lives at `dms/{pairId}`, where `pairId` is the two participants' UIDs sorted and
joined with `_`. The path itself names exactly who belongs there, so membership
is read straight off the path — no lookup document, no extra read per message.
Firebase Auth UIDs are alphanumeric, so `_` never appears inside one and the
split is unambiguous.

What the rules enforce:

- **Read** — only the two UIDs in the path.
- **Create** — `senderUid` must equal the caller (you cannot forge messages from
  someone else), `sentAt` must be the server's timestamp (you cannot backdate),
  content must be a non-empty string under 4000 chars, and `pendingFor` may only
  contain participants and must *not* contain the sender. The sender already has
  the message; it never waits on itself.
- **Update** — the only legal edit is removing yourself from `pendingFor`, i.e.
  acking delivery. No other field may change, and you cannot add anyone to the
  list.
- **Delete** — allowed only once `pendingFor` is empty. Nobody can delete a
  message out from under a recipient who hasn't received it yet.
- Everything outside `users/` and `dms/` is closed.

To re-deploy after editing:

```bash
firebase deploy --only firestore:rules
```
