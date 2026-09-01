'use strict';

const crypto = require('node:crypto');
const cryptoUtil = require('../../src/utils/crypto');

describe('password hashing', () => {
  it('verifies a correct password', async () => {
    const hash = await cryptoUtil.hashPassword('correct horse battery staple');
    await expect(cryptoUtil.verifyPassword('correct horse battery staple', hash)).resolves.toBe(true);
  });

  it('rejects an incorrect password', async () => {
    const hash = await cryptoUtil.hashPassword('correct horse battery staple');
    await expect(cryptoUtil.verifyPassword('wrong password entirely', hash)).resolves.toBe(false);
  });

  it('produces a different hash each time — the salt is random', async () => {
    const [a, b] = await Promise.all([
      cryptoUtil.hashPassword('same password'),
      cryptoUtil.hashPassword('same password'),
    ]);
    expect(a).not.toBe(b);
    await expect(cryptoUtil.verifyPassword('same password', a)).resolves.toBe(true);
    await expect(cryptoUtil.verifyPassword('same password', b)).resolves.toBe(true);
  });

  it('embeds the cost parameter so it can be raised later without invalidating hashes', async () => {
    const hash = await cryptoUtil.hashPassword('x'.repeat(20));
    expect(hash.split('$')[0]).toBe('scrypt');
    expect(Number(hash.split('$')[1])).toBeGreaterThanOrEqual(16384);
  });

  it('returns false rather than throwing on a corrupted stored hash', async () => {
    // A malformed record must never become an auth bypass or a 500.
    for (const bad of ['', 'garbage', 'scrypt$notanumber$aa$bb', 'bcrypt$10$x$y', null, undefined]) {
      await expect(cryptoUtil.verifyPassword('anything', bad)).resolves.toBe(false);
    }
  });
});

describe('webhook signatures', () => {
  const SECRET = 'whsec_test_secret';

  it('verifies a signature it just produced', () => {
    const { header } = cryptoUtil.signPayload({ a: 1, b: 2 }, SECRET);
    expect(cryptoUtil.verifySignature({ a: 1, b: 2 }, header, SECRET)).toEqual({ valid: true });
  });

  it('is independent of object key order', () => {
    const { header } = cryptoUtil.signPayload({ b: 1, a: 2 }, SECRET);
    expect(cryptoUtil.verifySignature({ a: 2, b: 1 }, header, SECRET).valid).toBe(true);
  });

  it('verifies against the exact raw body a receiver would see', () => {
    const payload = { type: 'payment.succeeded', data: { amountMinor: 1000 } };
    const { header } = cryptoUtil.signPayload(payload, SECRET);
    const raw = cryptoUtil.canonicalBody(payload);
    expect(cryptoUtil.verifySignature(raw, header, SECRET).valid).toBe(true);
  });

  it('rejects a wrong secret', () => {
    const { header } = cryptoUtil.signPayload({ a: 1 }, SECRET);
    expect(cryptoUtil.verifySignature({ a: 1 }, header, 'wrong_secret'))
      .toEqual({ valid: false, reason: 'SIGNATURE_MISMATCH' });
  });

  it('rejects a tampered payload', () => {
    const { header } = cryptoUtil.signPayload({ amountMinor: 1000 }, SECRET);
    expect(cryptoUtil.verifySignature({ amountMinor: 999999 }, header, SECRET).valid).toBe(false);
  });

  it('rejects a replayed signature outside the tolerance window', () => {
    const stale = Math.floor(Date.now() / 1000) - 10_000;
    const { header } = cryptoUtil.signPayload({ a: 1 }, SECRET, stale);
    expect(cryptoUtil.verifySignature({ a: 1 }, header, SECRET))
      .toEqual({ valid: false, reason: 'TIMESTAMP_OUT_OF_TOLERANCE' });
  });

  it('rejects a signature whose timestamp was swapped — the timestamp is signed', () => {
    const now = Math.floor(Date.now() / 1000);
    // Sign 60s ago, then re-present that signature with a *different* (fresh)
    // timestamp. Both are inside the tolerance window, so only the fact that
    // the timestamp is part of the signed material can reject this.
    const { signature } = cryptoUtil.signPayload({ a: 1 }, SECRET, now - 60);
    const forged = `t=${now},v1=${signature}`;
    expect(cryptoUtil.verifySignature({ a: 1 }, forged, SECRET))
      .toEqual({ valid: false, reason: 'SIGNATURE_MISMATCH' });
  });

  it('rejects a malformed header instead of throwing', () => {
    for (const bad of ['', 'nonsense', 't=123', 'v1=abc', undefined]) {
      expect(cryptoUtil.verifySignature({ a: 1 }, bad, SECRET).valid).toBe(false);
    }
  });

  it('rejects a signature of the wrong length without throwing', () => {
    // timingSafeEqual throws on unequal buffer lengths — the guard must catch it.
    const forged = `t=${Math.floor(Date.now() / 1000)},v1=deadbeef`;
    expect(() => cryptoUtil.verifySignature({ a: 1 }, forged, SECRET)).not.toThrow();
    expect(cryptoUtil.verifySignature({ a: 1 }, forged, SECRET).valid).toBe(false);
  });

  it('matches an independently computed HMAC — no bespoke crypto', () => {
    const timestamp = 1700000000;
    const payload = { hello: 'world' };
    const { signature } = cryptoUtil.signPayload(payload, SECRET, timestamp);
    const expected = crypto.createHmac('sha256', SECRET)
      .update(`${timestamp}.${cryptoUtil.canonicalBody(payload)}`)
      .digest('hex');
    expect(signature).toBe(expected);
  });
});

describe('request fingerprinting', () => {
  it('is stable across key ordering, so a reordered retry is not treated as key reuse', () => {
    expect(cryptoUtil.fingerprint({ a: 1, b: { c: 2, d: 3 } }))
      .toBe(cryptoUtil.fingerprint({ b: { d: 3, c: 2 }, a: 1 }));
  });

  it('changes when any value changes', () => {
    expect(cryptoUtil.fingerprint({ amountMinor: 1000 }))
      .not.toBe(cryptoUtil.fingerprint({ amountMinor: 1001 }));
  });

  it('serialises Dates as ISO strings, not empty objects', () => {
    // Regression: a Date has no enumerable own keys, so a naive canonicaliser
    // emits `{}` and silently drops the timestamp from the signed webhook body.
    const at = new Date('2026-01-01T00:00:00.000Z');
    expect(cryptoUtil.stableStringify({ at })).toBe('{"at":"2026-01-01T00:00:00.000Z"}');
    expect(cryptoUtil.stableStringify({ at })).not.toContain('{}');
  });

  it('serialises Dates nested inside objects and arrays', () => {
    const epoch = new Date(0);
    expect(cryptoUtil.stableStringify({ a: { c: [1, epoch], d: epoch }, b: 1 }))
      .toBe('{"a":{"c":[1,"1970-01-01T00:00:00.000Z"],"d":"1970-01-01T00:00:00.000Z"},"b":1}');
  });

  it('serialises an ObjectId as its hex string, not its internal buffer', () => {
    const { Types } = require('mongoose');
    const id = new Types.ObjectId('507f1f77bcf86cd799439011');
    expect(cryptoUtil.stableStringify({ id })).toBe('{"id":"507f1f77bcf86cd799439011"}');
  });

  it('does not hang on a toJSON that returns the object itself', () => {
    const looping = {};
    looping.toJSON = () => looping;
    expect(() => cryptoUtil.stableStringify(looping)).not.toThrow();
  });

  it('produces a signature that survives a Date round trip', () => {
    // The end-to-end property: a payload containing a Date must verify.
    const payload = { id: 'evt_1', createdAt: new Date('2026-01-01T00:00:00.000Z') };
    const { header } = cryptoUtil.signPayload(payload, 'whsec_test');
    const raw = cryptoUtil.canonicalBody(payload);
    expect(raw).toContain('2026-01-01T00:00:00.000Z');
    expect(cryptoUtil.verifySignature(raw, header, 'whsec_test').valid).toBe(true);
  });

  it('handles nested arrays and nulls', () => {
    expect(cryptoUtil.fingerprint({ a: [1, 2, { b: null }] }))
      .toBe(cryptoUtil.fingerprint({ a: [1, 2, { b: null }] }));
    expect(cryptoUtil.fingerprint({ a: [1, 2] })).not.toBe(cryptoUtil.fingerprint({ a: [2, 1] }));
  });
});
