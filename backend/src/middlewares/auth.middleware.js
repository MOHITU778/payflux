'use strict';

const authService = require('../services/auth.service');
const merchantRepository = require('../repositories/merchant.repository');
const requestContext = require('../utils/requestContext');
const asyncHandler = require('../utils/asyncHandler');
const { ROLE } = require('../constants');
const { UnauthorizedError, ForbiddenError } = require('../errors');

/**
 * Authentication and role-based access control.
 *
 * ── Tenant isolation ───────────────────────────────────────────────────────
 * The most important thing here is `scopeToMerchant`. Authorisation is not
 * enough on its own — a MERCHANT user with a valid token could otherwise ask
 * for another merchant's payment by id. Instead of trusting each controller to
 * remember a `merchant` filter, this middleware computes the tenant filter once
 * and attaches it to the request; repositories are always called with it. A
 * missed check then fails closed (no filter ⇒ no access), rather than open.
 */

/** Extract a bearer token from the Authorization header. */
function bearerToken(req) {
  const header = req.get('authorization') ?? '';
  const [scheme, token] = header.split(' ');
  if (!token || scheme.toLowerCase() !== 'bearer') return null;
  return token;
}

/** Require a valid access token. Populates `req.user` and `req.merchant`. */
const authenticate = asyncHandler(async (req, _res, next) => {
  const token = bearerToken(req);
  if (!token) throw new UnauthorizedError('Missing bearer token', 'MISSING_TOKEN');

  const { user } = await authService.verifyAccessToken(token);

  req.user = {
    id: String(user._id),
    email: user.email,
    role: user.role,
    merchantObjectId: user.merchant ?? null,
  };

  if (user.merchant) {
    req.merchant = await merchantRepository.findById(user.merchant);
    if (!req.merchant) throw new ForbiddenError('Linked merchant no longer exists', 'MERCHANT_MISSING');
    if (req.merchant.status === 'SUSPENDED' || req.merchant.status === 'TERMINATED') {
      throw new ForbiddenError(`Merchant account is ${req.merchant.status}`, 'MERCHANT_INACTIVE');
    }
  }

  // Enrich the trace context so every downstream log line carries the actor.
  requestContext.set('userId', req.user.id);
  if (req.merchant) requestContext.set('merchantId', req.merchant.merchantId);

  return next();
});

/**
 * Restrict a route to specific roles.
 * @param {...string} allowed  Values from `ROLE`.
 * @example router.post('/settlements/run', authenticate, authorize(ROLE.ADMIN), handler)
 */
function authorize(...allowed) {
  const permitted = new Set(allowed.flat());
  return (req, _res, next) => {
    if (!req.user) return next(new UnauthorizedError('Authentication required'));
    if (!permitted.has(req.user.role)) {
      return next(new ForbiddenError(
        `Role ${req.user.role} may not perform this action`,
        'INSUFFICIENT_ROLE',
      ));
    }
    return next();
  };
}

/**
 * Compute the tenant filter for the authenticated principal.
 *
 *   MERCHANT → `{ merchant: <their id> }`   — hard-scoped to their own data
 *   ADMIN    → `{}` or `{ merchant: <id> }` when `?merchantId=` is supplied
 *   SUPPORT  → read-only, same visibility as ADMIN
 *
 * Every list/read repository call takes this filter, so cross-tenant access is
 * structurally impossible rather than a rule each controller must remember.
 */
const scopeToMerchant = asyncHandler(async (req, _res, next) => {
  if (!req.user) throw new UnauthorizedError('Authentication required');

  if (req.user.role === ROLE.MERCHANT) {
    if (!req.user.merchantObjectId) {
      throw new ForbiddenError('User is not linked to a merchant', 'NO_MERCHANT_LINK');
    }
    req.merchantFilter = { merchant: req.user.merchantObjectId };
    return next();
  }

  // Platform staff may narrow to one merchant explicitly.
  const requested = req.query.merchantId ?? req.body?.merchantId;
  if (requested) {
    const merchant = await merchantRepository.findByMerchantId(requested);
    if (!merchant) throw new ForbiddenError('Unknown merchant', 'UNKNOWN_MERCHANT');
    req.merchant = merchant;
    req.merchantFilter = { merchant: merchant._id };
    return next();
  }

  req.merchantFilter = {}; // platform-wide view
  return next();
});

/**
 * Require an operation to be performed in the context of exactly one merchant.
 * Creating a payment platform-wide is meaningless, so admin routes that mutate
 * merchant data must name the merchant.
 */
function requireMerchantContext(req, _res, next) {
  if (!req.merchant) {
    return next(new ForbiddenError(
      'This operation requires a merchant context (supply merchantId)',
      'MERCHANT_CONTEXT_REQUIRED',
    ));
  }
  return next();
}

/** SUPPORT is deliberately read-only across the platform. */
function denyReadOnlyRoles(req, _res, next) {
  if (req.user?.role === ROLE.SUPPORT) {
    return next(new ForbiddenError('Support accounts have read-only access', 'READ_ONLY_ROLE'));
  }
  return next();
}

/**
 * Optional authentication — used by routes that behave differently for a
 * signed-in caller but do not require one. Never throws.
 */
const optionalAuth = asyncHandler(async (req, _res, next) => {
  const token = bearerToken(req);
  if (!token) return next();
  try {
    const { user } = await authService.verifyAccessToken(token);
    req.user = { id: String(user._id), email: user.email, role: user.role };
  } catch {
    // An invalid token on an optional route is simply anonymous.
  }
  return next();
});

module.exports = {
  authenticate,
  authorize,
  scopeToMerchant,
  requireMerchantContext,
  denyReadOnlyRoles,
  optionalAuth,
  ROLE,
};
