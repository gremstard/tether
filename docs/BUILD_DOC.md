> **Note:** this is the original architecture brief, kept as written. Several
> decisions in it have since been superseded — the Blaze-dependent features
> (TTL policy, Cloud Storage, Cloud Functions) are all replaced, and friends are
> added by username rather than UID. See [DECISIONS.md](DECISIONS.md), which
> takes precedence wherever the two disagree.

# Tether — Build Document

## 1. What This Is

Tether is a chat app (DMs + Discord-style "servers") built on a **federated, self-hosted
architecture** instead of one company's central cloud. Nobody owns "the" Tether backend —
each community runs its own Firebase project, and a small shared "directory" project just
helps people and clients find each other. No account is tied to a corporation's chat
product; the app is just client code that talks to whichever Firebase project it's pointed at.

This doc is meant to be handed to an AI coding agent (Claude Code) as the single source of
truth for what to build, why, and in what order. It should be enough context to start work
without the human re-explaining the architecture each session.

**Target platforms (v1):** macOS and Windows desktop, via Electron (shared codebase).
**Hosting for the web/download landing page:** Firebase Hosting at `tether.web.app`.
**Backend:** Firebase (Auth + Firestore + Cloud Functions), one project per "server" +
one small shared project for the identity directory.

---

## 2. Why This Architecture (context for future decisions)

These constraints came out of extensive design discussion and should guide any deviations:

- **Offline delivery matters.** Pure peer-to-peer (raw sockets, WebRTC) fails the core use
  case: a friend should get a message even if their device was off when it was sent. This
  requires *something always-on* holding messages until the recipient reconnects — hence a
  backend, not pure P2P.
- **No unbounded data growth.** A single shared database for every user of the app forever
  was rejected — it grows forever and never shrinks (dead accounts, old servers, etc. never
  get cleaned up). Instead:
  - **DMs self-clean**: a message is deleted once the recipient acknowledges delivery, OR
    after a TTL (time-to-live) expires if it's never picked up. Steady-state size is "messages
    currently in flight," not "all messages ever sent."
  - **Servers scale by being separate projects.** Each Discord-style "server" (community) is
    its own Firebase project, owned/created by whoever founded it. One community's growth
    never affects another's quota, and the app's total footprint isn't "1 giant shared DB."
- **No port forwarding / NAT issues.** Clients only ever make *outbound* connections to
  Firebase — this works on any network, including ones with CGNAT or no port forwarding
  available (this was a real constraint for one of the two initial users).
- **No phone-style push infra needed for desktop.** Desktop doesn't have an OS-level
  always-on push channel the way iOS/Android do. Instead: a small background/tray-resident
  process holds a live Firestore realtime listener, and fires a **native local OS
  notification** (macOS `UNUserNotificationCenter`, Windows toast notifications) the instant
  new data arrives. No APNs/FCM, no push certificates, no Apple Developer Program needed for v1.
- **Identity is decoupled from where data lives.** A small **global directory project**
  stores only pointers (who are you, what servers/DMs are you part of, where does that data
  live) — never message content. This is the part that makes "your own Firebase project =
  your own server" work without turning into a hundred disconnected islands.

---

## 3. Architecture Overview

Three kinds of Firebase project, one shared identity layer:

```
┌─────────────────────────────┐
│   Global Directory Project   │   <- one project, small, ships with the app
│  users/{uid}: displayName,   │
│    pfpUrl, serverList[],     │
│    dmInboxRef                │
└──────────────┬───────────────┘
               │ points to
     ┌─────────┼─────────────────────┐
     ▼                               ▼
┌─────────────────┐         ┌──────────────────────┐
│  Server Project  │  ...    │   DM Storage          │
│  (one per        │         │  (scoped per-pair,    │
│   community,      │         │   lives in a shared    │
│   founder-owned)  │         │   default project or  │
│  channels/,       │         │   the directory        │
│  members/,        │         │   project itself)      │
│  messages/        │         │  messages self-delete │
└──────────────────┘         │  on ack or TTL         │
                              └──────────────────────┘
```

### 3.1 Global Directory Project
- Purpose: identity + routing only. Never stores message content.
- Collections:
  - `users/{uid}` — `{ displayName, pfpUrl, createdAt }`
  - `users/{uid}/servers/{serverId}` — `{ serverConfigRef, joinedAt }` (pointer to which
    Firebase project + doc that server's data lives in)
  - `users/{uid}/dms/{otherUid}` — pointer to where that DM thread lives (v1: always the
    shared default DM project, so this can just be a boolean/marker; keep the schema open
    for v2 flexibility)
- This is the *only* project every Tether user necessarily shares. It stays small because
  it holds profile-sized data, not chat history.

### 3.2 Server Project (one per community)
- Created by whoever starts a community ("their own Firebase project, same app, connected").
- Collections:
  - `serverInfo` — name, icon/pfp, description
  - `channels/{channelId}` — name, type
  - `channels/{channelId}/messages/{messageId}` — content, senderUid, timestamp
  - `members/{uid}` — role, joinedAt
- Security rules restrict read/write to members listed in `members/`.
- Founder shares their project's public client config (API key + project ID — not secret,
  Firebase configs are meant to be public; security lives in Firestore rules) as an "invite,"
  e.g. a JSON blob or a short invite code the app resolves via a Cloud Function.

### 3.3 DM Storage (shared default project, v1)
- One shared Firebase project (can be the same as the Global Directory project, or a
  sibling — pick whichever is simpler to stand up first; sibling project recommended so the
  directory's security rules stay dead simple).
- Collections:
  - `dms/{pairId}/messages/{messageId}` — `{ senderUid, content, sentAt, pendingFor: [uid] }`
    - `pairId` = sorted, joined UIDs (e.g. `uidA_uidB`) so both participants deterministically
      land on the same document path.
    - `pendingFor` starts as `[recipientUid]` only — **the sender already has the message**,
      it doesn't need to wait on itself. Once the recipient acks, remove their UID; when the
      array is empty, delete the message (via Cloud Function or client-triggered cleanup).
    - A Firestore **TTL policy** on a `expireAt` field (e.g. `sentAt + 30 days`) is the safety
      net for messages nobody ever picks up (defunct/abandoned accounts).
- Security rules: only the two UIDs encoded in `pairId` may read/write that thread.

### 3.4 Background client behavior (both platforms)
- App runs as a tray (Windows) / menu-bar (macOS) resident background process, ideally set
  to launch on login (Windows "Startup Apps" / macOS Login Items).
- Holds a live Firestore `onSnapshot` listener on the user's relevant DM threads + joined
  servers' channels they care about.
- On new data: fire a native OS notification (`UNUserNotificationCenter` on macOS, toast
  notification API on Windows).
- "Online" effectively means "this background process is running" — matches the mental model
  of "message arrives whenever my computer's on," which was an explicit goal.

---

## 4. Phased Build Plan

Each phase should be independently demoable. Don't start a phase until the previous one
actually works end-to-end with a real message sent between two real machines.

### Phase 0 — Throwaway proof of concept
**Goal:** prove Firestore realtime + notifications work at all, before building any real
architecture.
- One Firebase project, Firestore in test mode (no real security rules yet).
- Minimal Electron app: hardcode two UIDs ("me" and "friend").
- Text input → writes a message doc to a hardcoded collection.
- `onSnapshot` listener → on new doc, fire a native OS notification + log to console.
- Success criteria: you type a message on one machine, it shows up (or at least logs) on
  the other within a couple seconds, even if that machine's app was just idling.

### Phase 1 — Real DM data model + Auth
- Add Firebase Auth (simplest: email/password or anonymous auth to start — can upgrade later).
- Implement the real `dms/{pairId}/messages/{messageId}` schema from §3.3, including
  `pendingFor` and ack-on-read deletion.
- Set up Firestore TTL policy on `expireAt`.
- Write real Firestore security rules restricting each thread to its two participants.
- Basic chat UI: message list + input box, one hardcoded friend.

### Phase 2 — Background presence + notifications, properly
- Package the Electron app to run in system tray / menu bar.
- Auto-launch on login (both OS's native mechanism).
- Native notification on new message, clicking it focuses/opens the app to that thread.
- Test the actual target scenario: send a message while the friend's PC is off, confirm it
  arrives (with notification) once they log back in.

### Phase 3 — Global Directory project + real identity
- Stand up the Global Directory project (§3.1).
- Sign-up flow: create account once, get a stable UID, set displayName + pfp.
- "Add friend" flow: enter their UID (or a friendlier shareable code that resolves to it via
  a Cloud Function) → creates the `dms/{pairId}` pointer for both users.
- Multiple DM threads in the UI (not just one hardcoded friend).

### Phase 4 — Servers (Discord-style communities)
- "Create server" flow: walks the founder through creating their own Firebase project
  (documented steps, or eventually automated via Firebase Management API if you want to get
  fancy later — manual is fine for v1) and registering it in their directory profile.
- Server data model from §3.2: channels, members, messages.
- Invite flow: generate a code/link that resolves (via the directory or a Cloud Function on
  the server project) to that project's client config, joins the invitee as a member.
- Multi-server UI: sidebar of servers (à la Discord), channel list per server.

### Phase 5 — Polish
- Profile pictures for users AND servers (Firebase Storage, or even just letting users paste
  an image URL for v1 to avoid Storage setup/cost).
- Usernames vs. display names (decide if usernames need to be unique/searchable — if so,
  needs a lookup index in the directory project).
- Read receipts / typing indicators (optional, not core to the design).
- Windows + macOS installer/packaging (electron-builder or electron-forge).
- Landing/download page deployed to `tether.web.app` via Firebase Hosting (see §6).

---

## 5. Tech Stack

- **Client:** Electron (shared code, both target platforms). React inside Electron's
  renderer process is a reasonable default for the UI layer, but not mandatory.
- **Backend:** Firebase — Auth, Firestore, Cloud Functions (for invite-code resolution,
  cleanup jobs), Firestore TTL policies (native feature, no cron needed).
- **Notifications:** platform-native APIs, called directly from the Electron main process —
  no third-party push service needed for v1.
- **Hosting:** Firebase Hosting for the marketing/download page at `tether.web.app`. This is
  unrelated to the chat backend itself — it's just a static site pointing people to
  downloads/GitHub releases.
- **Source control:** GitHub, single repo containing the Electron client. Consider a
  `functions/` directory for the shared default project's Cloud Functions, and a
  `docs/` or `templates/` directory with the security rules + setup steps a server founder
  needs to follow (this doc's §3.2 setup, formalized into copyable Firebase CLI commands).

---

## 6. Firebase + GitHub Setup Steps (for Phase 0/1)

1. `npm create firebase` or use the Firebase Console to create a new project (e.g.
   `tether-directory-dev` for now — can rename/recreate for production later).
2. Enable **Firestore** (production mode once real rules exist; test mode acceptable for
   Phase 0 only).
3. Enable **Authentication** → start with Email/Password or Anonymous provider.
4. `firebase init hosting` in the repo root, targeting `tether.web.app` as the Hosting site,
   for the landing page (separate concern from the app backend — can be done anytime,
   including before Phase 0, since it's just a static page).
5. Grab the web app config (Project Settings → General → Your apps → Firebase SDK config) —
   this is safe to commit to the repo; it is not a secret.
6. `firebase deploy --only hosting` to publish the landing page to `tether.web.app`.
7. GitHub repo: standard Electron app structure. Recommend `main/` (Electron main process,
   tray + notification logic), `renderer/` (UI), `shared/` (Firestore schema helpers used by
   both — e.g. `pairId` generation, message shape types).

---

## 7. Open Questions / Decide Later (don't block early phases on these)

- Unique searchable usernames vs. just UIDs/codes for adding friends.
- Whether server creation should eventually be automated (Firebase Management API) instead
  of a manual "go create a project, paste the config" step.
- Group DMs (3+ people, no server structure) — likely just extends `pairId` to a sorted
  multi-UID key; not designed in depth yet.
- Message editing/deletion by the sender (currently only auto-delete-on-ack/TTL is designed).
- Whether to eventually support mobile (would reintroduce the APNs/FCM push discussion from
  earlier design conversation — out of scope for v1).

---

## 8. Naming / Branding Notes

- App name: **Tether**
- Look for consistency with the "quietly always-on, self-hosted, connects two things
  directly" naming logic used to pick it — landing page copy, icon, etc. should lean into
  that rather than generic "chat app" branding.
