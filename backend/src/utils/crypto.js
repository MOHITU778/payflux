'use strict';

const crypto = require('node:crypto');
const { promisify } = require('node:util');
const config = require('../config');

const scrypt = promisify(crypto.scrypt);

/**
 * Password hashing and signature primitives.
 *
 * scrypt is used rather than bcrypt so the image needs no native toolchain,
 * and it is memory-hard, which is what actually slows down GPU cracking. The
 * cost parameter is stored inside the hash string so parameters can be raised
 * later without invalidating existing passwords.
 *
 * Encoded form: `scrypt$<cost>$<saltHex>$<derivedKeyHex>`
 */

const KEY_LENGTH = 64;
const SALT_BYTES = 16;

async function hashPassword(plain, cost = config.security.scryptCost) {
  const salt = crypto.randomBytes(SALT_BYTES);
  // `maxmem` must exceed 128 * N * r; the default 32MB is too small for N≥32768.
  const derived = await scrypt(plain, salt, KEY_LENGTH, { N: cost, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
  return `scrypt$${cost}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

/**
 * Verify a password against a stored hash in constant time.
 * Returns false — never throws — on a malformed stored hash, so a corrupted
 * record cannot become an authentication bypass or a 500.
 */
async function verifyPassword(plain, stored) {
  try {
    const [scheme, cost, saltHex, keyHex] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(keyHex, 'hex');
    if (expected.length !== KEY_LENGTH) return false;
    const derived = await scrypt(plain, salt, KEY_LENGTH, {
      N: Number(cost), r: 8, p: 1, maxmem: 256 * 1024 * 1024,
    });
    return crypto.timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/**
 * HMAC-SHA256 over `${timestamp}.${payload}`.
 *
 * Binding the timestamp into the signed material is what makes replay
 * protection meaningful: an attacker cannot lift a valid signature and pair it
 * with a fresh timestamp.
 */
function signPayload(payload, secret, timestamp = Math.floor(Date.now() / 1000)) {
  // Objects are canonicalised with sorted keys so that signing and verifying
  // the same logical payload always agree. A *string* payload is signed
  // byte-for-byte — inbound verification must pass the raw request body, since
  // that is what the sender actually hashed.
  const body = typeof payload === 'string' ? payload : stableStringify(payload);
  const signature = crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return { timestamp, signature, header: `t=${timestamp},v1=${signature}` };
}

/** Parse a `t=…,v1=…` signature header into its parts. */
function parseSignatureHeader(header) {
  const parts = String(header || '').split(',').reduce((acc, part) => {
    const [key, value] = part.split('=');
    if (key && value) acc[key.trim()] = value.trim();
    return acc;
  }, {});
  return { timestamp: Number(parts.t), signature: parts.v1 };
}

/**
 * Verify a webhook signature.
 * @returns {{ valid: boolean, reason?: string }}
 */
function verifySignature(payload, header, secret, toleranceSeconds = config.webhook.timestampToleranceSeconds) {
  const { timestamp, signature } = parseSignatureHeader(header);
  if (!timestamp || !signature) return { valid: false, reason: 'MALFORMED_SIGNATURE_HEADER' };

  const age = Math.abs(Math.floor(Date.now() / 1000) - timestamp);
  if (age > toleranceSeconds) return { valid: false, reason: 'TIMESTAMP_OUT_OF_TOLERANCE' };

  const expected = signPayload(payload, secret, timestamp).signature;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  // Length must match before timingSafeEqual, which throws on unequal buffers.
  if (a.length !== b.length) return { valid: false, reason: 'SIGNATURE_MISMATCH' };
  return crypto.timingSafeEqual(a, b)
    ? { valid: true }
    : { valid: false, reason: 'SIGNATURE_MISMATCH' };
}

/** Stable SHA-256 fingerprint of a request body, used for idempotency-key reuse checks. */
function fingerprint(value) {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('hex');
}

/**
 * Deterministic JSON: object keys are sorted so `{a,b}` and `{b,a}` produce the
 * same fingerprint. Without this, two semantically identical retries would look
 * like key reuse and be rejected.
 */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';

  // Honour `toJSON()` exactly as `JSON.stringify` does. Date, ObjectId, Buffer
  // and Mongoose documents all define it, and skipping it corrupts the output:
  // a Date has no enumerable own keys so it serialises to `{}` (the timestamp
  // is silently lost), and an ObjectId serialises to a dump of its internal
  // byte buffer. Both end up in the signed webhook body a merchant receives.
  if (typeof value.toJSON === 'function') {
    const json = value.toJSON();
    // Guard against a toJSON that returns the object itself, which would recurse forever.
    if (json !== value) return stableStringify(json);
  }

  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

/**
 * The exact byte string that must be transmitted for a signature to verify.
 * The webhook dispatcher sends this, not `JSON.stringify(payload)`.
 */
const canonicalBody = (payload) =>
  (typeof payload === 'string' ? payload : stableStringify(payload));

module.exports = {
  canonicalBody,
  hashPassword,
  verifyPassword,
  signPayload,
  verifySignature,
  parseSignatureHeader,
  fingerprint,
  stableStringify,
};
