'use strict';

/** Middleware registry — one import site for the HTTP layer. */
module.exports = {
  requestContext: require('./requestContext.middleware'),
  requestLogger: require('./requestLogger.middleware'),
  security: require('./security.middleware'),
  auth: require('./auth.middleware'),
  validate: require('./validate.middleware'),
  ...require('./idempotency.middleware'),
  rateLimit: require('./rateLimit.middleware'),
  ...require('./error.middleware'),
};
