'use strict';

const { ValidationError } = require('../errors');

/**
 * Joi validation middleware.
 *
 * Validation happens at the edge so that no service ever receives a malformed
 * DTO — services can then assume their inputs are well-formed and concentrate
 * on business rules.
 *
 * The validated value **replaces** the raw input, which is what makes this a
 * security control and not just a check: `stripUnknown` drops any field the
 * schema does not declare, so a caller cannot smuggle `{ status: 'SUCCESS' }`
 * or `{ feeMinor: 0 }` into a create-payment body and have it reach the model.
 *
 * @param {import('joi').Schema} schema
 * @param {'body'|'query'|'params'} property
 */
function validate(schema, property = 'body') {
  return (req, _res, next) => {
    const { value, error } = schema.validate(req[property], {
      abortEarly: false,   // report every problem at once, not one per round trip
      stripUnknown: true,
      convert: true,       // '100' → 100 for query params
    });

    if (error) {
      const details = error.details.map((detail) => ({
        field: detail.path.join('.'),
        message: detail.message.replace(/"/g, "'"),
        type: detail.type,
      }));
      return next(new ValidationError('Request validation failed', details));
    }

    // `req.query` is a getter in Express 5; assign through defineProperty so
    // this works on both major versions.
    if (property === 'query') {
      Object.defineProperty(req, 'query', { value, writable: true, configurable: true });
    } else {
      req[property] = value;
    }
    return next();
  };
}

module.exports = validate;
