# Servers (communities)

A server is a Discord-style community, and it lives in **its own Firebase
project** — one you create and own. Nobody else's community shares your quota,
and nobody can switch yours off. The Tether client connects to each server
project directly as a separate Firebase app; no traffic passes through the
directory project.

## Identity works differently inside a server

This is the part that surprises people, so it is worth stating plainly:

**Firebase Auth is per-project. Your UID in a server is not your directory UID.**

Signing into Tether does not sign you into a community, because a community is a
different Firebase project with its own user table. Bridging the two would need
custom tokens, which need Cloud Functions, which need Blaze — and Tether stays on
Spark. So joining a server signs you into that project as well (via Google), and
your handle is re-asserted there.

Consequences, honestly:

- Each server's rules hold handles unique **within that server**, using the same
  structural trick as the directory: the handle is the document id, and create
  only succeeds where nothing exists.
- Nothing can verify that `@riz` in one community is `@riz` in another, or the
  `@riz` from the directory. Cross-project identity is not something client-side
  rules can check. Inside a well-run community this is fine — the founder can see
  who joined — but do not treat a handle in a stranger's server as proof of who
  someone is.
- If your handle is already taken in a server you join, you still get in; you
  just do not hold that handle there.

## Founding a server

1. Create a new Firebase project at [console.firebase.google.com](https://console.firebase.google.com).
2. Enable **Firestore** and, under Authentication, the **Google** provider.
3. Deploy the server rules from this repo into that project:

   ```bash
   firebase deploy --only firestore:rules --project YOUR-SERVER-PROJECT
   ```

   pointing `firestore.rules` at [`templates/server.rules`](../templates/server.rules).
   Do **not** deploy the directory's `firestore.rules` there — it governs
   different collections entirely.
4. Copy that project's web config (Project settings → Your apps → SDK config).
5. In Tether: **+** in the server rail → paste the config, name the server →
   *Create server*.

The client writes `serverInfo/main`, your founding membership, and a `#general`
channel, then hands you an invite code.

Founder is claimed by whoever writes `serverInfo/main` first, and `create` only
evaluates when that document does not exist — so exactly one account can ever
become founder, and it cannot be handed off or overwritten later.

## Joining

Paste an invite code into **+** → *Join*. You will be asked to sign in to that
community's project, then you appear in its `members/` collection.

An invite code is a packed Firebase client config — see [INVITES.md](INVITES.md).
It is **not** a secret and **not** an access control mechanism: possession of a
code lets you attempt to join, and it is the server's `members/` rules that
decide what you can then read or write.

## Data model

All paths are inside the server's own project:

| Path | Contents |
| --- | --- |
| `serverInfo/main` | `founderUid`, name, description, `iconBase64` |
| `members/{uid}` | `role` (`founder` \| `member`), `username`, `joinedAt` |
| `usernames/{username}` | `{ uid }` — in-server handle uniqueness |
| `channels/{channelId}` | channel metadata |
| `channels/{channelId}/messages/{id}` | `senderUid`, `username`, `content`, `sentAt` |

Icons are base64 in `serverInfo`, capped at 400,000 characters — same reasoning
as avatars ([IMAGES.md](IMAGES.md)).

## Channel history is permanent

Deliberately unlike DMs. A DM is transport: delivered, copied locally, deleted.
A channel is community history — someone should be able to scroll up next year
and read what was said. So channel messages have:

- no `pendingFor` and no ack,
- no sweep and no expiry,
- no edits (`update` is refused outright, so what people read is what was said),
- deletion only by the message's author or the founder.

There is also no local mirror for channels: they are read straight from the
server project, because the data belongs to the community rather than to you.

## What the rules enforce

Covered by [`test/server-rules.test.mjs`](../test/server-rules.test.mjs) (29
cases) and [`test/servers.test.mjs`](../test/servers.test.mjs) (13 cases):

```bash
npm run test:server-rules && npm run test:servers
```

- Only members read channels, messages, or the member list.
- Anyone signed in may read `serverInfo/main` — an invitee must be able to see a
  server's name before deciding to join.
- You may only create your **own** membership, and cannot self-appoint as
  founder or promote yourself.
- Messages cannot be forged as another member, backdated, or edited.
- The founder can create channels, moderate messages, promote, and remove.
