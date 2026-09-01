'use strict';

const mongoose = require('mongoose');
const config = require('./index');
const logger = require('./logger');

/**
 * MongoDB connection lifecycle.
 *
 * `strictQuery` avoids silently dropping unknown filter fields — a filter typo
 * should return nothing loudly, not everything quietly. Connection events are
 * logged so a replica-set failover is visible in the timeline of an incident.
 */

mongoose.set('strictQuery', true);
if (!config.isProduction) {
  // Slow-query visibility during development.
  mongoose.set('debug', (collection, method, query) =>
    logger.debug('mongo query', { collection, method, query: JSON.stringify(query).slice(0, 500) }));
}

let connected = false;

async function connect(uri = config.mongo.uri) {
  if (connected) return mongoose.connection;

  mongoose.connection.on('connected', () => logger.info('mongo connected'));
  mongoose.connection.on('disconnected', () => logger.warn('mongo disconnected'));
  mongoose.connection.on('reconnected', () => logger.info('mongo reconnected'));
  mongoose.connection.on('error', (err) => logger.error('mongo error', { error: err.message }));

  await mongoose.connect(uri, config.mongo.options);
  connected = true;
  return mongoose.connection;
}

async function disconnect() {
  if (!connected) return;
  await mongoose.connection.close(false);
  connected = false;
  logger.info('mongo connection closed');
}

/**
 * True when the deployment supports multi-document transactions (replica set
 * or mongos). Standalone dev containers do not, so the ledger falls back to a
 * compensating-write path instead of crashing.
 */
function supportsTransactions() {
  const { topology } = mongoose.connection.client || {};
  const description = topology?.description;
  if (!description) return false;
  return ['ReplicaSetWithPrimary', 'Sharded'].includes(description.type);
}

/** Readiness probe used by /health. */
async function ping() {
  const start = Date.now();
  await mongoose.connection.db.admin().ping();
  return { ok: true, latencyMs: Date.now() - start, state: mongoose.connection.readyState };
}

module.exports = { connect, disconnect, ping, supportsTransactions, mongoose };
