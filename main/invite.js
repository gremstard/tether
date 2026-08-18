'use strict';

const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { promisify } = require('node:util');

const deflate = promisify(zlib.deflateRaw);
const inflate = promisify(zlib.inflateRaw);

/**
 * Server invite codes.
 *
 * An invite is the founder's Firebase client config, compressed and wrapped
 * into one short shareable string. The invitee's client unwraps it locally and
 * connects straight to that project — no Cloud Function to resolve codes, no
 * server-side lookup collection. That keeps server creation on Spark.
 *
 * On compression: a Firebase config is mostly high-entropy keys, which generic
 * deflate cannot shrink — deflating this data outright produced a code *longer*
 * than the JSON it replaced. So the payload is packed structurally instead: the
 * field names are dropped, the derivable fields (authDomain, storageBucket, and
 * the sender id, which is already embedded in the app id) are recomputed on the
 * far side rather than transmitted, and the fixed "AIzaSy" api-key prefix is
 * stripped. Deflate is still applied on the fallback path, where the config does
 * not match the expected shapes and the field names have to travel.
 *
 * On the "encrypted" part, plainly: the key ships inside the app, so this is
 * obfuscation, not confidentiality. Anyone with Tether can unwrap any code. That
 * is fine — a Firebase client config is public by design and security lives in
 * the project's Firestore rules — but no part of the system should ever treat an
 * invite code as a secret, and it is not an access control mechanism. Its job is
 * to be compact, opaque enough not to invite tampering, and self-validating.
 */

const PREFIX = 'TTHR1';
const KEY = crypto.createHash('sha256').update('tether-invite-v1').digest();

/** Short tag/iv: this is obfuscation, not a security boundary (see above). */
const IV_BYTES = 8;
const TAG_BYTES = 8;

const FORMAT_PACKED = 0;
const FORMAT_JSON = 1;

/** Fields a client needs to talk to a Firebase project. */
const CONFIG_FIELDS = [
  'apiKey',
  'authDomain',
  'projectId',
  'storageBucket',
  'messagingSenderId',
  'appId',
];

const API_KEY_PREFIX = 'AIzaSy';
const PLATFORMS = ['web', 'android', 'ios'];

/** "1:843737797989:web:5e363e1c27..." -> its three variable parts. */
const APP_ID = /^1:(\d{1,15}):([a-z]+):([0-9a-f]+)$/;

function base32Encode(buf) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const out = [];
  for (const char of str) {
    const idx = alphabet.indexOf(char);
    if (idx === -1) throw new Error('invite code contains invalid characters');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** Group into dash-separated blocks so a human can read one out loud. */
function group(code, size = 6) {
  return (code.match(new RegExp(`.{1,${size}}`, 'g')) ?? []).join('-');
}

/** Pack the config into bytes, dropping everything derivable. */
function pack(config) {
  const appId = APP_ID.exec(config.appId ?? '');
  const apiKey = config.apiKey ?? '';
  const projectId = config.projectId ?? '';

  const platform = appId ? PLATFORMS.indexOf(appId[2]) : -1;
  const packable =
    appId &&
    platform !== -1 &&
    apiKey.startsWith(API_KEY_PREFIX) &&
    projectId.length < 256 &&
    appId[3].length % 2 === 0 &&
    // The sender id is only omissible because the app id already contains it.
    (!config.messagingSenderId || config.messagingSenderId === appId[1]);

  if (!packable) return null;

  const keyRest = Buffer.from(apiKey.slice(API_KEY_PREFIX.length), 'utf8');
  const project = Buffer.from(projectId, 'utf8');
  const suffix = Buffer.from(appId[3], 'hex');

  return Buffer.concat([
    Buffer.from([FORMAT_PACKED, keyRest.length, project.length, platform, suffix.length]),
    keyRest,
    project,
    // Sender id fits comfortably in 6 bytes (< 2^48).
    (() => {
      const b = Buffer.alloc(6);
      b.writeUIntBE(Number(appId[1]), 0, 6);
      return b;
    })(),
    suffix,
  ]);
}

function unpack(buf) {
  const [, keyLen, projectLen, platform, suffixLen] = buf;
  let at = 5;

  const apiKey = API_KEY_PREFIX + buf.subarray(at, (at += keyLen)).toString('utf8');
  const projectId = buf.subarray(at, (at += projectLen)).toString('utf8');
  const senderId = String(buf.readUIntBE(at, 6));
  at += 6;
  const suffix = buf.subarray(at, at + suffixLen).toString('hex');

  return {
    apiKey,
    // Derived rather than transmitted — Firebase always uses these forms.
    authDomain: `${projectId}.firebaseapp.com`,
    projectId,
    storageBucket: `${projectId}.firebasestorage.app`,
    messagingSenderId: senderId,
    appId: `1:${senderId}:${PLATFORMS[platform]}:${suffix}`,
  };
}

async function encodeInvite(config) {
  const missing = CONFIG_FIELDS.filter(
    (f) => !['storageBucket', 'authDomain', 'messagingSenderId'].includes(f) && !config?.[f]
  );
  if (missing.length) {
    throw new Error(`invite config is missing: ${missing.join(', ')}`);
  }

  let payload = pack(config);
  if (!payload) {
    // Fallback: keep the field names, and let deflate do what it can.
    const json = JSON.stringify(CONFIG_FIELDS.map((f) => config[f] ?? ''));
    payload = Buffer.concat([
      Buffer.from([FORMAT_JSON]),
      await deflate(Buffer.from(json, 'utf8'), { level: 9 }),
    ]);
  }

  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv, { authTagLength: TAG_BYTES });
  const body = Buffer.concat([cipher.update(payload), cipher.final()]);

  return `${PREFIX}-${group(base32Encode(Buffer.concat([iv, cipher.getAuthTag(), body])))}`;
}

async function decodeInvite(code) {
  const trimmed = String(code ?? '').trim().toUpperCase();
  if (!trimmed.startsWith(`${PREFIX}-`)) {
    throw new Error('that does not look like a Tether invite code');
  }

  const raw = base32Decode(trimmed.slice(PREFIX.length + 1).replace(/-/g, ''));
  if (raw.length < IV_BYTES + TAG_BYTES + 2) throw new Error('invite code is truncated');

  const iv = raw.subarray(0, IV_BYTES);
  const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const body = raw.subarray(IV_BYTES + TAG_BYTES);

  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv, { authTagLength: TAG_BYTES });
  decipher.setAuthTag(tag);

  let payload;
  try {
    payload = Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    // Auth failure — mistyped or tampered with.
    throw new Error('invite code is not valid');
  }

  if (payload[0] === FORMAT_PACKED) return unpack(payload);

  const values = JSON.parse((await inflate(payload.subarray(1))).toString('utf8'));
  return Object.fromEntries(
    CONFIG_FIELDS.map((field, i) => [field, values[i]]).filter(([, v]) => v !== '')
  );
}

module.exports = { encodeInvite, decodeInvite, CONFIG_FIELDS, PREFIX };
