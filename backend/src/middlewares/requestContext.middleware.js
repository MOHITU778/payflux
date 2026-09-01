'use strict';

const requestContext = require('../utils/requestContext');

/**
 * Establish the per-request trace context.
 *
 * Must be mounted first: everything downstream — logs, audit records, queue
 * jobs — reads the correlation id from this store. An inbound
 * `x-correlation-id` is honoured so a trace started by an upstream service (or
 * the Angular client) continues through us instead of being restarted.
 */
module.exports = function requestContextMiddleware(req, res, next) {
  const correlationId = req.get('x-correlation-id') || requestContext.newCorrelationId();
  const requestId = requestContext.newRequestId();

  req.correlationId = correlationId;
  req.requestId = requestId;
  req.startedAt = process.hrtime.bigint();

  // Echo both back so a client can quote them in a support ticket.
  res.set('x-correlation-id', correlationId);
  res.set('x-request-id', requestId);

  // Everything the handler awaits inherits this store.
  requestContext.run({ correlationId, requestId }, () => next());
};
