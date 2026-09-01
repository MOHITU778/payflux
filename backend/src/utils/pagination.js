'use strict';

/** Hard ceiling on page size — an unbounded `limit` is a denial-of-service vector. */
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;

/**
 * Normalise `page`/`limit` query parameters into safe skip/limit values.
 * @param {object} query
 * @returns {{ page: number, limit: number, skip: number }}
 */
function normalize(query = {}) {
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const requested = Number.parseInt(query.limit, 10) || DEFAULT_LIMIT;
  const limit = Math.min(MAX_LIMIT, Math.max(1, requested));
  return { page, limit, skip: (page - 1) * limit };
}

/**
 * Translate a `sort` query parameter (`-createdAt,amount`) into a Mongo sort
 * object, restricted to an allow-list so a caller cannot force a collection
 * scan by sorting on an unindexed field.
 */
function buildSort(sortParam, allowed, fallback = { createdAt: -1 }) {
  if (!sortParam) return fallback;
  const sort = {};
  for (const token of String(sortParam).split(',')) {
    const direction = token.startsWith('-') ? -1 : 1;
    const field = token.replace(/^[-+]/, '').trim();
    if (allowed.includes(field)) sort[field] = direction;
  }
  return Object.keys(sort).length ? sort : fallback;
}

module.exports = { normalize, buildSort, MAX_LIMIT, DEFAULT_LIMIT };
