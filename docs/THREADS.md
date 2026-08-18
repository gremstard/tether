# Conversations

## Intake is separate from display

Every known conversation gets a Firestore listener as soon as you sign in — not
when you click it. This is the difference between "you have messages waiting"
and "a message arrives whenever your computer is on". Receiving cannot depend on
having opened a thread by hand first, or running in the background is pointless.

So the two halves are split:

- **Intake** ([`renderer/threads.js`](../renderer/threads.js)) holds one listener
  per conversation. Each one persists to local history, acks, fires the
  notification, and cleans up delivered messages. It runs for every known peer,
  whether or not that thread is on screen.
- **Display** reads local history only. Switching conversations never touches
  Firestore — intake has already written everything to disk.

Unread counts come from intake seeing a message for a thread that isn't the one
being displayed. Backlog from the first snapshot after startup is excluded, or
signing in would show unread counts for messages you had already read.

## The conversation list

`users/{uid}/dms/{peerUid}` stores a pointer per conversation — `username` and
`addedAt`, never content. Its whole job is letting the client re-open every
thread on launch, so intake can be started for each. Only the owner can read or
write their own list.

Adding someone resolves their handle through `usernames/{username}` to a UID,
writes the pointer, starts intake, and shows the thread. On the next launch the
list is loaded and every listener comes back up before you touch anything.

## Verified end-to-end

[`test/intake.test.mjs`](../test/intake.test.mjs) runs the real intake code
against the emulator with the real security rules, as two signed-in users, and
asserts that with the thread **never opened**:

- the message is received,
- the notification fires,
- it is written to local history *before* the ack,
- the recipient's ack empties `pendingFor`,
- and the history survives a restart.

```bash
npm run test:intake
```
