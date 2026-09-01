'use strict';

/**
 * Error taxonomy.
 *
 * Everything thrown deliberately by the application extends `AppError`, which
 * carries the three things the HTTP layer, the queue layer and the logs all
 * need: a stable machine-readable `code`, an HTTP `status`, and a `retryable`
 * flag. Workers use `retryable` to decide between a BullMQ retry and an
 * immediate move to the dead-letter queue; anything that is *not* an AppError
 * is treated as an unexpected bug and never leaks its message to the client.
 */

class AppError extends Error {
  /**
   * @param {string} message  Human-readable, safe to return to the caller.
   * @param {object} [opts]
   * @param {number} [opts.status=500]      HTTP status code.
   * @param {string} [opts.code]            Stable error code, e.g. `PAYMENT_NOT_FOUND`.
   * @param {boolean} [opts.retryable]      Whether retrying the same call may succeed.
   * @param {object} [opts.details]         Structured context (field errors, ids…).
   * @param {Error}  [opts.cause]           Underlying error, kept for logs only.
   */
  constructor(message, opts = {}) {
    super(message);
    this.name = this.constructor.name;
    this.status = opts.status ?? 500;
    this.code = opts.code ?? 'INTERNAL_ERROR';
    this.retryable = opts.retryable ?? false;
    this.details = opts.details;
    this.isOperational = true;
    if (opts.cause) this.cause = opts.cause;
    Error.captureStackTrace(this, this.constructor);
  }

  /** Client-safe JSON body. Never includes `cause` or the stack. */
  toJSON() {
    return {
      code: this.code,
      message: this.message,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

/** 400 — request body/params failed schema validation. */
class ValidationError extends AppError {
  constructor(message = 'Request validation failed', details) {
    super(message, { status: 400, code: 'VALIDATION_ERROR', details });
  }
}

/** 401 — no credentials, or credentials that no longer verify. */
class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required', code = 'UNAUTHORIZED') {
    super(message, { status: 401, code });
  }
}

/** 403 — authenticated, but the role or tenant does not permit this. */
class ForbiddenError extends AppError {
  constructor(message = 'Insufficient permissions', code = 'FORBIDDEN') {
    super(message, { status: 403, code });
  }
}

/** 404 — the addressed resource does not exist for this caller. */
class NotFoundError extends AppError {
  constructor(resource = 'Resource', code = 'NOT_FOUND') {
    super(`${resource} not found`, { status: 404, code });
  }
}

/** 409 — the request contradicts current state (duplicate key, stale write). */
class ConflictError extends AppError {
  constructor(message = 'Resource conflict', details) {
    super(message, { status: 409, code: 'CONFLICT', details });
  }
}

/**
 * 409 — an illegal edge in the payment state machine.
 * Carries both ends of the attempted transition so support can triage without
 * reading application logs.
 */
class InvalidStateTransitionError extends AppError {
  constructor(from, to, entity = 'Payment') {
    super(`Illegal ${entity.toLowerCase()} transition ${from} → ${to}`, {
      status: 409,
      code: 'INVALID_STATE_TRANSITION',
      details: { from, to, entity },
    });
  }
}

/**
 * 409 — a second request arrived with the same Idempotency-Key while the first
 * is still executing. The client should retry after a short delay; the eventual
 * answer will be the *first* request's stored response.
 */
class IdempotencyConflictError extends AppError {
  constructor(key) {
    super('A request with this Idempotency-Key is already in flight', {
      status: 409,
      code: 'IDEMPOTENT_REQUEST_IN_FLIGHT',
      retryable: true,
      details: { idempotencyKey: key },
    });
  }
}

/**
 * 422 — the key was reused with a *different* payload. Replaying a stored
 * response would be wrong, so we reject rather than guess.
 */
class IdempotencyKeyReuseError extends AppError {
  constructor(key) {
    super('Idempotency-Key was already used with a different request payload', {
      status: 422,
      code: 'IDEMPOTENCY_KEY_REUSE',
      details: { idempotencyKey: key },
    });
  }
}

/** 422 — request is well-formed but violates a domain rule. */
class BusinessRuleError extends AppError {
  constructor(message, code = 'BUSINESS_RULE_VIOLATION', details) {
    super(message, { status: 422, code, details });
  }
}

/** 423 — the distributed lock guarding this resource could not be acquired. */
class LockAcquisitionError extends AppError {
  constructor(resource) {
    super('Could not acquire lock for the requested resource', {
      status: 423,
      code: 'LOCK_UNAVAILABLE',
      retryable: true,
      details: { resource },
    });
  }
}

/** 429 — client exceeded its quota. */
class RateLimitError extends AppError {
  constructor(retryAfterSeconds) {
    super('Too many requests', {
      status: 429,
      code: 'RATE_LIMITED',
      retryable: true,
      details: { retryAfterSeconds },
    });
  }
}

/** 402 — the transaction was declined by the fraud engine. */
class FraudBlockedError extends AppError {
  constructor(riskScore, triggeredRules) {
    super('Transaction blocked by risk engine', {
      status: 402,
      code: 'FRAUD_BLOCKED',
      details: { riskScore, triggeredRules },
    });
  }
}

/** 502 — a downstream dependency failed in a way that may recover. */
class UpstreamServiceError extends AppError {
  constructor(service, cause) {
    super(`Upstream service '${service}' is unavailable`, {
      status: 502,
      code: 'UPSTREAM_UNAVAILABLE',
      retryable: true,
      details: { service },
      cause,
    });
  }
}

/** 503 — the circuit breaker is open, so we fail fast without calling out. */
class CircuitOpenError extends AppError {
  constructor(service, retryAfterMs) {
    super(`Circuit breaker open for '${service}'`, {
      status: 503,
      code: 'CIRCUIT_OPEN',
      retryable: true,
      details: { service, retryAfterMs },
    });
  }
}

module.exports = {
  AppError,
  ValidationError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  InvalidStateTransitionError,
  IdempotencyConflictError,
  IdempotencyKeyReuseError,
  BusinessRuleError,
  LockAcquisitionError,
  RateLimitError,
  FraudBlockedError,
  UpstreamServiceError,
  CircuitOpenError,
};
