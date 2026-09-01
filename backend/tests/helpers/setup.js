'use strict';

/**
 * Jest global setup.
 *
 * Environment variables are set before any module loads, because `src/config`
 * validates them at require time and throws on anything missing — the config
 * layer failing fast is exactly what we want in production, so tests must
 * satisfy it rather than work around it.
 */

process.env.NODE_ENV = 'test';
process.env.MONGO_URI = process.env.TEST_MONGO_URI ?? 'mongodb://127.0.0.1:27017/payflux-test';
process.env.REDIS_HOST = process.env.TEST_REDIS_HOST ?? '127.0.0.1';
process.env.REDIS_PORT = process.env.TEST_REDIS_PORT ?? '6379';
// A dedicated Redis database for tests. Sharing db 0 with a running dev stack
// leaves queued jobs behind that reference documents from a test database which
// no longer exists — the dev worker then retries them pointlessly.
process.env.REDIS_DB = process.env.TEST_REDIS_DB ?? '1';
process.env.JWT_SECRET = 'test-access-secret-at-least-32-characters-long';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-at-least-32-characters-long';
process.env.LOG_LEVEL = 'error';
process.env.ENABLE_SCHEDULERS = 'false';
// Deterministic acquirer: no simulated outages in tests, so a failing
// assertion always means a real defect rather than a coin flip.
process.env.ACQUIRER_FAILURE_RATE = '0';
process.env.ACQUIRER_LATENCY_MS = '1';
process.env.PASSWORD_SCRYPT_COST = '16384';

jest.setTimeout(30000);
