'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const crypto = require('node:crypto');

/**
 * Ambient per-request context.
 *
 * An `AsyncLocalStorage` store lets any module deep in the call graph — a
 * repository, a queue producer, the ledger — attach the correlation id to its
 * logs without every function signature growing a `ctx` parameter. The store
 * survives `await` boundaries, so an id set in Express middleware is still
 * readable inside a Mongo callback three services down.
 */
const storage = new AsyncLocalStorage();

/**
 * Run `fn` with a fresh context. Anything the callback awaits inherits it.
 * @param {object} seed  Initial context values (correlationId, requestId, …).
 * @param {Function} fn  Callback executed inside the context.
 */
function run(seed, fn) {
  const store = new Map(Object.entries(seed));
  return storage.run(store, fn);
}

/** @returns {object} A plain snapshot of the active context (empty when none). */
function getContext() {
  const store = storage.getStore();
  return store ? Object.fromEntries(store) : {};
}

/** Read a single context value, or undefined outside a context. */
function get(key) {
  const store = storage.getStore();
  return store ? store.get(key) : undefined;
}

/** Attach a value to the active context; a no-op outside one. */
function set(key, value) {
  const store = storage.getStore();
  if (store) store.set(key, value);
}

/**
 * Generate a correlation id. Prefixed and time-sortable so that grepping logs
 * across services stays readable.
 */
function newCorrelationId() {
  return `cor_${Date.now().toString(36)}${crypto.randomBytes(6).toString('hex')}`;
}

function newRequestId() {
  return `req_${crypto.randomBytes(8).toString('hex')}`;
}

module.exports = { run, get, set, getContext, newCorrelationId, newRequestId, storage };
