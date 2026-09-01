'use strict';

const requestContext = require('./requestContext');

/**
 * Uniform response envelope.
 *
 * Every endpoint answers with the same shape, so the Angular client has exactly
 * one unwrapping path and one error path. The correlation id is echoed back so
 * a user reporting a failure can quote a single string that finds the whole
 * request in the logs.
 */

function meta() {
  const { correlationId, requestId } = requestContext.getContext();
  return { timestamp: new Date().toISOString(), correlationId, requestId };
}

/** 2xx payload. */
function success(res, data, { status = 200, message, pagination } = {}) {
  return res.status(status).json({
    success: true,
    ...(message ? { message } : {}),
    data,
    ...(pagination ? { pagination } : {}),
    meta: meta(),
  });
}

/** 201 with a Location header when the resource is addressable. */
function created(res, data, location) {
  if (location) res.set('Location', location);
  return success(res, data, { status: 201 });
}

/** Paginated list payload. */
function paginated(res, { items, total, page, limit }) {
  return success(res, items, {
    pagination: {
      total,
      page,
      limit,
      pages: Math.max(1, Math.ceil(total / limit)),
      hasNext: page * limit < total,
      hasPrev: page > 1,
    },
  });
}

/** Error payload — the only place a non-2xx body is constructed. */
function failure(res, { status = 500, code = 'INTERNAL_ERROR', message, details }) {
  return res.status(status).json({
    success: false,
    error: { code, message, ...(details ? { details } : {}) },
    meta: meta(),
  });
}

module.exports = { success, created, paginated, failure };
