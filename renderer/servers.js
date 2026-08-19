import { initializeApp, getApp, deleteApp } from 'firebase/app';
import {
  getFirestore, collection, doc, getDoc, getDocs, setDoc, addDoc,
  onSnapshot, orderBy, query, serverTimestamp, deleteDoc, updateDoc,
} from 'firebase/firestore';
import { getAuth, signInWithPopup, GoogleAuthProvider, onAuthStateChanged } from 'firebase/auth';

import serverSchema from '../shared/server.js';

const {
  SERVER_INFO_PATH, channelsPath, channelMessagesPath, membersPath,
  normalizeChannelName, isValidChannelName, serverIdFor,
} = serverSchema;

/**
 * Servers — communities that live in their own Firebase project.
 *
 * This is where federation actually happens: the client holds a separate
 * Firebase app per server, initialized from that server's client config, and
 * talks to it directly. No traffic passes through the directory project.
 *
 * The consequence that shapes everything here: **Firebase Auth is per-project.**
 * Signing into the directory does not sign you into a server, and your UID in a
 * server is not your directory UID. Bridging them would need custom tokens,
 * which need Cloud Functions, which need Blaze. So joining a server means
 * authenticating to that project too, and your handle is re-asserted there and
 * held unique by that server's own rules. See docs/SERVERS.md.
 */

/** Firebase apps are named singletons; reuse by server id. */
function appFor(config) {
  const id = serverIdFor(config);
  try {
    return getApp(id);
  } catch {
    return initializeApp(config, id);
  }
}

export function connect(config) {
  const app = appFor(config);
  return { id: serverIdFor(config), app, db: getFirestore(app), auth: getAuth(app) };
}

export async function disconnect(serverId) {
  try {
    await deleteApp(getApp(serverId));
  } catch {
    // Not connected; nothing to tear down.
  }
}

/** Current user in a server project, waiting for auth state to settle. */
export function currentServerUser(auth) {
  return new Promise((resolve) => {
    const stop = onAuthStateChanged(auth, (user) => {
      stop();
      resolve(user);
    });
  });
}

/** Sign into a server project. Google only: no new password per community. */
export function signIntoServer(auth) {
  return signInWithPopup(auth, new GoogleAuthProvider());
}

export async function readServerInfo(db) {
  const snap = await getDoc(doc(db, SERVER_INFO_PATH));
  return snap.exists() ? snap.data() : null;
}

/**
 * Found a server in a project you own. Writes the identity document, your
 * founding membership, and a first channel.
 */
export async function createServer(db, uid, { name, description, username, iconBase64 }) {
  const existing = await readServerInfo(db);
  if (existing) {
    throw new Error(`that project already hosts "${existing.name}"`);
  }

  await setDoc(doc(db, SERVER_INFO_PATH), {
    founderUid: uid,
    name,
    description: description ?? '',
    ...(iconBase64 ? { iconBase64 } : {}),
    createdAt: Date.now(),
  });

  await setDoc(doc(db, membersPath(), uid), {
    role: 'founder',
    username,
    joinedAt: Date.now(),
  });

  await claimServerHandle(db, uid, username);
  await createChannel(db, 'general');
  return readServerInfo(db);
}

/** Claim a handle inside a server. Best-effort: a clash must not block joining. */
async function claimServerHandle(db, uid, username) {
  try {
    await setDoc(doc(db, 'usernames', username), { uid });
    return username;
  } catch {
    return null;
  }
}

export async function joinServer(db, uid, username) {
  const info = await readServerInfo(db);
  if (!info) throw new Error('that invite points at a project with no Tether server in it');

  await setDoc(
    doc(db, membersPath(), uid),
    { role: 'member', username, joinedAt: Date.now() },
    { merge: true }
  );
  const claimed = await claimServerHandle(db, uid, username);
  return { info, handleTaken: claimed === null };
}

export async function listChannels(db) {
  const snap = await getDocs(collection(db, channelsPath()));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export async function createChannel(db, rawName) {
  const name = normalizeChannelName(rawName);
  if (!isValidChannelName(name)) {
    throw new Error('channel names are 1–24 characters: letters, numbers, dashes');
  }
  await setDoc(doc(db, channelsPath(), name), { name, createdAt: Date.now() });
  return name;
}

/**
 * Listen to a channel. Unlike DMs there is no local mirror and no ack: channel
 * history is permanent and lives in the server project, so it is read straight
 * from Firestore.
 */
export function watchChannel(db, channelId, { onMessages, onError }) {
  return onSnapshot(
    query(collection(db, channelMessagesPath(channelId)), orderBy('sentAt', 'asc')),
    (snap) => onMessages(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    onError
  );
}

export function postToChannel(db, channelId, { senderUid, username, content }) {
  return addDoc(collection(db, channelMessagesPath(channelId)), {
    senderUid,
    username,
    content,
    sentAt: serverTimestamp(),
  });
}

/**
 * Remember a joined server in the directory, including the client config needed
 * to reconnect. The config is public by design; the server's content never
 * touches the directory project.
 */
export async function rememberServer(directoryDb, selfUid, config, info, serverUid) {
  await setDoc(
    doc(directoryDb, `users/${selfUid}/servers`, serverIdFor(config)),
    {
      config,
      name: info?.name ?? serverIdFor(config),
      serverUid: serverUid ?? null,
      joinedAt: Date.now(),
    },
    { merge: true }
  );
}

export async function loadServers(directoryDb, selfUid) {
  const snap = await getDocs(collection(directoryDb, `users/${selfUid}/servers`));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export async function forgetServer(directoryDb, selfUid, serverId) {
  await deleteDoc(doc(directoryDb, `users/${selfUid}/servers`, serverId));
}

/** Edit a channel message. Only the author may, and the edit is disclosed. */
export function editChannelMessage(db, channelId, messageId, content) {
  return updateDoc(doc(db, channelMessagesPath(channelId), messageId), {
    content,
    editedAt: serverTimestamp(),
  });
}

export function deleteChannelMessage(db, channelId, messageId) {
  return deleteDoc(doc(db, channelMessagesPath(channelId), messageId));
}
