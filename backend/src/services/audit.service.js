'use strict';

const logger = require('../config/logger');
const { auditRepository } = require('../repositories');
const requestContext = require('../utils/requestContext');
const pagination = require('../utils/pagination');

/** Values that must never be written to an audit record. */
const SENSITIVE = new Set(['password', 'passwordHash', 'secret', 'apiSecret', 'token', 'cvv', 'cardNumber']);

/**
 * Audit logging.
 *
 * Compliance needs a durable answer to "who did what, when, from where". This
 * service is deliberately **fire-and-forget**: a failure to write an audit
 * record is logged loudly but never propagated, because an audit outage must
 * not become a payment outage. The records that genuinely gate access (failed
 * logins, lockouts) are additionally enforced on the user document itself, so
 * security does not depend on this collection being writable.
 */
class AuditService {
  constructor({ repository } = {}) {
    this.repository = repository ?? auditRepository;
    this.log = logger.child({ component: 'audit' });
  }

  /** Strip secrets from a changes/metadata blob before persisting it. */
  sanitize(value, depth = 0) {
    if (depth > 5 || value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map((entry) => this.sanitize(entry, depth + 1));
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = SENSITIVE.has(key.toLowerCase()) ? '[REDACTED]' : this.sanitize(entry, depth + 1);
    }
    return out;
  }

  /**
   * Record an auditable action. Never awaited by callers on the request path.
   * @param {object} entry
   * @param {string} entry.action    One of `AUDIT_ACTION.*`
   * @param {'SUCCESS'|'FAILURE'} entry.outcome
   */
  record({ action, outcome, actor = {}, merchant, target, changes, metadata, reason }) {
    const { correlationId, requestId } = requestContext.getContext();

    return this.repository
      .create({
        action,
        outcome,
        actor: {
          userId: actor.userId ?? null,
          email: actor.email ?? null,
          role: actor.role ?? null,
          ipAddress: actor.ipAddress ?? null,
          userAgent: actor.userAgent ?? null,
        },
        merchant: merchant ?? null,
        target: target ?? null,
        changes: changes ? this.sanitize(changes) : null,
        metadata: metadata ? this.sanitize(metadata) : null,
        reason: reason ?? null,
        correlationId: correlationId ?? null,
        requestId: requestId ?? null,
      })
      .catch((err) => {
        this.log.error('failed to write audit record', { action, error: err.message });
        return null;
      });
  }

  async list({ merchantFilter = {}, query = {} }) {
    const { page, limit } = pagination.normalize(query);
    const filter = { ...merchantFilter };
    if (query.action) filter.action = query.action;
    if (query.outcome) filter.outcome = query.outcome;
    if (query.userId) filter['actor.userId'] = query.userId;
    if (query.correlationId) filter.correlationId = query.correlationId;
    if (query.from || query.to) {
      filter.createdAt = {};
      if (query.from) filter.createdAt.$gte = new Date(query.from);
      if (query.to) filter.createdAt.$lte = new Date(query.to);
    }
    return this.repository.list(filter, { page, limit });
  }

  /** Full history for one entity — the support view. */
  trailFor(targetType, targetId) {
    return this.repository.forTarget(targetType, targetId);
  }
}

module.exports = new AuditService();
module.exports.AuditService = AuditService;
