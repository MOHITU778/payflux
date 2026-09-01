'use strict';

const IORedis = require('ioredis');
const config = require('./index');
const logger = require('./logger');

/**
 * Redis topology.
 *
 * Four logical roles, deliberately kept on separate connections:
 *
 *   client  — general command traffic (cache, idempotency, rate limits, locks)
 *   bull    — BullMQ blocking commands (`BZPOPMIN`, `BRPOPLPUSH`). A blocking
 *             read monopolises its socket, so it must never share with `client`.
 *   sub     — pub/sub subscriber; once subscribed a connection may only issue
 *             subscribe-family commands.
 *   pub     — pub/sub publisher.
 *
 * `maxRetriesPerRequest: null` is mandatory for BullMQ connections: BullMQ
 * manages its own retry semantics and ioredis's default would abort blocking
 * reads mid-flight.
 */

const clients = new Map();

/** @returns {import('ioredis').RedisOptions} */
function baseOptions(role) {
  return {
    host: config.redis.host,
    port: config.redis.port,
    password: config.redis.password,
    db: config.redis.db,
    connectionName: `payflux:${role}`,
    // Importing a module must not open a socket. With lazyConnect the client is
    // constructed inert and dials on the first command (or on an explicit
    // `connect()` during boot), which keeps `require()` free of I/O side
    // effects — otherwise a unit test that merely imports a service inherits a
    // live connection and the process never exits.
    lazyConnect: true,
    enableReadyCheck: true,
    // Exponential backoff capped at 3s, so a Redis restart self-heals without
    // hammering the box.
    retryStrategy: (attempt) => Math.min(attempt * 200, 3000),
    reconnectOnError: (err) => {
      // A failover promotes a replica; reconnecting picks up the new primary.
      if (err.message.includes('READONLY')) return 2;
      return false;
    },
  };
}

/**
 * Get (or lazily create) the connection for a role.
 * @param {'client'|'bull'|'sub'|'pub'} role
 * @returns {import('ioredis').Redis}
 */
function getClient(role = 'client') {
  if (clients.has(role)) return clients.get(role);

  const options = baseOptions(role);
  if (role === 'bull') {
    options.maxRetriesPerRequest = null;
    options.enableReadyCheck = false;
  }

  const client = new IORedis(options);
  client.on('connect', () => logger.debug('redis connecting', { role }));
  client.on('ready', () => logger.info('redis ready', { role }));
  client.on('error', (err) => logger.error('redis error', { role, error: err.message }));
  client.on('close', () => logger.warn('redis connection closed', { role }));
  client.on('reconnecting', (delay) => logger.warn('redis reconnecting', { role, delay }));

  clients.set(role, client);
  return client;
}

/** Block until the general client answers PING — used by the boot sequence. */
async function connect() {
  const client = getClient('client');
  // 'wait' means lazyConnect built the client but nothing has dialled yet.
  if (client.status === 'wait') {
    await client.connect();
  } else if (client.status !== 'ready') {
    await new Promise((resolve, reject) => {
      const onReady = () => { cleanup(); resolve(); };
      const onError = (err) => { cleanup(); reject(err); };
      const cleanup = () => { client.off('ready', onReady); client.off('error', onError); };
      client.once('ready', onReady);
      client.once('error', onError);
    });
  }
  await client.ping();
  logger.info('redis connected', { host: config.redis.host, port: config.redis.port });
  return client;
}

/** Close every open connection. Called from the graceful-shutdown handler. */
async function disconnect() {
  await Promise.all(
    [...clients.entries()].map(async ([role, client]) => {
      try {
        await client.quit();
        logger.info('redis disconnected', { role });
      } catch {
        client.disconnect();
      }
    }),
  );
  clients.clear();
}

/** Liveness probe used by /health. */
async function ping() {
  const start = Date.now();
  await getClient('client').ping();
  return { ok: true, latencyMs: Date.now() - start };
}

module.exports = { getClient, connect, disconnect, ping };
