import { doc, getDoc, setDoc, writeBatch } from 'firebase/firestore';

import schema from '../shared/schema.js';

const { normalizeUsername, isValidUsername } = schema;

/**
 * Usernames, profiles, and avatars.
 *
 * Avatars are base64 in the user's own Firestore document rather than Cloud
 * Storage — Storage is a Blaze feature and Tether stays on Spark. Firestore
 * caps a document at 1MiB, so images are downscaled and re-encoded as JPEG
 * before they ever reach the network.
 */

export const AVATAR_SIZE = 256;

/** Keep well under both the rules cap (400k) and Firestore's 1MiB document limit. */
const MAX_ENCODED_BYTES = 400000;

/**
 * Downscale an image file to a square data URL. Crops to centre rather than
 * squashing, so avatars are not distorted.
 */
export function downscaleImage(file, { size = AVATAR_SIZE, quality = 0.82 } = {}) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();

    img.onload = () => {
      URL.revokeObjectURL(url);

      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');

      const side = Math.min(img.width, img.height);
      ctx.drawImage(
        img,
        (img.width - side) / 2,
        (img.height - side) / 2,
        side,
        side,
        0,
        0,
        size,
        size
      );

      let encoded = canvas.toDataURL('image/jpeg', quality);
      // Very noisy images can still encode large; step quality down rather than
      // failing the upload outright.
      for (let q = quality - 0.15; encoded.length > MAX_ENCODED_BYTES && q >= 0.4; q -= 0.15) {
        encoded = canvas.toDataURL('image/jpeg', q);
      }

      if (encoded.length > MAX_ENCODED_BYTES) {
        reject(new Error('image is too complex to compress under the size limit'));
        return;
      }
      resolve(encoded);
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('could not read that image'));
    };

    img.src = url;
  });
}

/** Resolve a handle to a UID. Returns null when nobody holds it. */
export async function lookupUsername(db, rawUsername) {
  const username = normalizeUsername(rawUsername);
  if (!isValidUsername(username)) {
    throw new Error('usernames are 3–20 characters: letters, numbers, underscore');
  }
  const snap = await getDoc(doc(db, 'usernames', username));
  return snap.exists() ? snap.data().uid : null;
}

export async function getProfile(db, uid) {
  const snap = await getDoc(doc(db, 'users', uid));
  return snap.exists() ? snap.data() : null;
}

/**
 * Claim a username and create the profile in a single atomic commit, so a
 * claimed handle can never be left without the profile that owns it.
 *
 * Uniqueness is enforced by the rules: creating usernames/{username} is only
 * allowed when no document exists there, so a losing racer's whole batch fails.
 */
export async function claimUsername(db, uid, rawUsername, profile = {}) {
  const username = normalizeUsername(rawUsername);
  if (!isValidUsername(username)) {
    throw new Error('usernames are 3–20 characters: letters, numbers, underscore');
  }

  const batch = writeBatch(db);
  batch.set(doc(db, 'usernames', username), { uid });
  batch.set(doc(db, 'users', uid), { ...profile, username, createdAt: Date.now() }, { merge: true });

  try {
    await batch.commit();
  } catch (err) {
    if (err.code === 'permission-denied') {
      throw new Error(`"${username}" is already taken`);
    }
    throw err;
  }
  return username;
}

export async function saveAvatar(db, uid, pfpBase64) {
  await setDoc(doc(db, 'users', uid), { pfpBase64 }, { merge: true });
}
