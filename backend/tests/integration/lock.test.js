'use strict';

const infra = require('../helpers/infra');

/**
 * Distributed lock tests against a real Redis.
 *
 * The safety properties here are all properties of Redis's atomicity
 * (`SET NX PX`) and of Lua script execution. Mocking Redis would test the mock.
 */

let redis;
let LockService;
let lockService;
let available = false;

beforeAll(async () => {
  available = await infra.infraAvailable();
  if (!available) return;
  redis = require('../../src/config/redis');
  ({ LockService } = require('../../src/services/lock.service'));
  await redis.connect();
  lockService = new LockService({ client: redis.getClient('client') });
});

afterAll(async () => {
  if (!available) return;
  await redis.disconnect().catch(() => {});
});

const guard = () => available;
const resource = () => `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describe('mutual exclusion', () => {
  it('grants the lock to exactly one caller', async () => {
    if (!guard()) return;
    const key = resource();
    const first = await lockService.tryAcquire(key, 2000);
    const second = await lockService.tryAcquire(key, 2000);

    expect(first).not.toBeNull();
    expect(second).toBeNull();
    await lockService.release(first);
  });

  it('grants it to exactly one of many concurrent callers', async () => {
    if (!guard()) return;
    const key = resource();
    const attempts = await Promise.all(
      Array.from({ length: 25 }, () => lockService.tryAcquire(key, 2000)),
    );
    const winners = attempts.filter(Boolean);
    expect(winners).toHaveLength(1);
    await lockService.release(winners[0]);
  });

  it('serialises a critical section under contention', async () => {
    if (!guard()) return;
    const key = resource();
    let concurrent = 0;
    let maxConcurrent = 0;
    let completed = 0;

    await Promise.all(Array.from({ length: 8 }, () =>
      lockService.withLock(key, async () => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 15));
        concurrent -= 1;
        completed += 1;
      }, { retryCount: 30, retryDelayMs: 20 })));

    // The whole point: never two at once, and nobody is starved.
    expect(maxConcurrent).toBe(1);
    expect(completed).toBe(8);
  });
});

describe('lease expiry', () => {
  it('releases automatically when the holder dies', async () => {
    if (!guard()) return;
    const key = resource();
    // Acquired and deliberately never released, as if the process crashed.
    const orphaned = await lockService.tryAcquire(key, 150);
    expect(orphaned).not.toBeNull();
    expect(await lockService.tryAcquire(key, 150)).toBeNull();

    await new Promise((r) => setTimeout(r, 250));
    const recovered = await lockService.tryAcquire(key, 1000);
    expect(recovered).not.toBeNull();
    await lockService.release(recovered);
  });

  it('extends a lease while the holder still owns it', async () => {
    if (!guard()) return;
    const key = resource();
    const lock = await lockService.tryAcquire(key, 200);
    expect(await lockService.extend(lock, 2000)).toBe(true);

    await new Promise((r) => setTimeout(r, 300));
    // Still held, because the lease was renewed before it lapsed.
    expect(await lockService.tryAcquire(key, 500)).toBeNull();
    await lockService.release(lock);
  });

  it('refuses to extend a lease that has already lapsed', async () => {
    if (!guard()) return;
    const key = resource();
    const lock = await lockService.tryAcquire(key, 100);
    await new Promise((r) => setTimeout(r, 200));
    expect(await lockService.extend(lock, 1000)).toBe(false);
  });
});

describe('safe release', () => {
  it('never lets one holder delete another holder\'s lock', async () => {
    if (!guard()) return;
    const key = resource();
    // A holds the lock briefly and lets it expire without releasing.
    const a = await lockService.tryAcquire(key, 120);
    await new Promise((r) => setTimeout(r, 200));

    // B now legitimately owns the same resource.
    const b = await lockService.tryAcquire(key, 3000);
    expect(b).not.toBeNull();

    // A belatedly tries to release. Without the compare-and-delete script this
    // would delete B's lock and silently break mutual exclusion — the single
    // most common bug in hand-rolled Redis locks.
    expect(await lockService.release(a)).toBe(false);

    // B still holds it.
    expect(await lockService.tryAcquire(key, 500)).toBeNull();
    expect(await lockService.release(b)).toBe(true);
  });

  it('releases the lock on every exit path, including a thrown error', async () => {
    if (!guard()) return;
    const key = resource();
    await expect(lockService.withLock(key, async () => {
      throw new Error('critical section blew up');
    })).rejects.toThrow('critical section blew up');

    // Not leaked: the next caller gets it immediately.
    const after = await lockService.tryAcquire(key, 1000);
    expect(after).not.toBeNull();
    await lockService.release(after);
  });
});

describe('acquisition failure', () => {
  it('throws a retryable LockAcquisitionError once retries are exhausted', async () => {
    if (!guard()) return;
    const key = resource();
    const held = await lockService.tryAcquire(key, 5000);

    await expect(
      lockService.acquire(key, { retryCount: 2, retryDelayMs: 10 }),
    ).rejects.toMatchObject({ code: 'LOCK_UNAVAILABLE', status: 423, retryable: true });

    await lockService.release(held);
  });

  it('succeeds once the incumbent releases', async () => {
    if (!guard()) return;
    const key = resource();
    const held = await lockService.tryAcquire(key, 5000);
    setTimeout(() => lockService.release(held), 60);

    const acquired = await lockService.acquire(key, { retryCount: 20, retryDelayMs: 20 });
    expect(acquired).not.toBeNull();
    await lockService.release(acquired);
  });
});
