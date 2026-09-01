'use strict';

const jwt = require('jsonwebtoken');
const config = require('../config');
const logger = require('../config/logger');
const cryptoUtil = require('../utils/crypto');
// The repository modules export the singleton instance as `module.exports`,
// with statics hung off it — destructuring a named `userRepository` here would
// silently yield `undefined`.
const userRepository = require('../repositories/user.repository');
const merchantRepo = require('../repositories/merchant.repository');

const { LOCK_THRESHOLD } = userRepository;
const { ROLE, AUDIT_ACTION } = require('../constants');
const { UnauthorizedError, ForbiddenError, ConflictError, NotFoundError } = require('../errors');
const auditService = require('./audit.service');

/**
 * Authentication and token management.
 *
 * ── Token design ───────────────────────────────────────────────────────────
 * Short-lived access tokens (15m) plus long-lived refresh tokens (7d). The
 * access token is a bearer credential with no server-side state, so it cannot
 * be revoked directly — hence the short life. Revocation works through
 * `tokenVersion`: bumping it on the user invalidates every token ever issued to
 * them, without maintaining a blacklist that grows forever and has to be
 * consulted on every request.
 *
 * ── Enumeration resistance ─────────────────────────────────────────────────
 * A wrong password and an unknown email return the identical error, and the
 * unknown-email path still performs a hash comparison against a dummy value.
 * Skipping the hash would make "user not found" measurably faster and turn
 * login into a user-enumeration oracle.
 */

/** A real scrypt hash, compared against when the user does not exist. */
const DUMMY_HASH = 'scrypt$16384$' + '0'.repeat(32) + '$' + '0'.repeat(128);

class AuthService {
  constructor(deps = {}) {
    this.users = deps.userRepository ?? userRepository;
    this.merchants = deps.merchantRepository ?? merchantRepo;
    this.audit = deps.auditService ?? auditService;
    this.log = logger.child({ component: 'auth' });
  }

  /**
   * Exchange credentials for a token pair.
   * @throws {UnauthorizedError} for any credential failure, without distinguishing why.
   */
  async login({ email, password, actor = {} }) {
    const user = await this.users.findByEmailWithSecret(email);

    if (!user) {
      // Constant-work path — see the enumeration note above.
      await cryptoUtil.verifyPassword(password, DUMMY_HASH);
      this.audit.record({
        action: AUDIT_ACTION.LOGIN_FAILED,
        outcome: 'FAILURE',
        actor: { ...actor, email },
        reason: 'UNKNOWN_EMAIL',
      });
      throw new UnauthorizedError('Invalid email or password', 'INVALID_CREDENTIALS');
    }

    if (user.lockedUntil && new Date(user.lockedUntil) > new Date()) {
      this.audit.record({
        action: AUDIT_ACTION.LOGIN_FAILED,
        outcome: 'FAILURE',
        actor: { ...actor, email, userId: user._id },
        reason: 'ACCOUNT_LOCKED',
      });
      throw new UnauthorizedError(
        'Account is temporarily locked after repeated failed attempts',
        'ACCOUNT_LOCKED',
      );
    }

    if (!user.isActive) throw new ForbiddenError('Account is disabled', 'ACCOUNT_DISABLED');

    const valid = await cryptoUtil.verifyPassword(password, user.passwordHash);
    if (!valid) {
      const updated = await this.users.registerFailedLogin(user._id);
      this.audit.record({
        action: AUDIT_ACTION.LOGIN_FAILED,
        outcome: 'FAILURE',
        actor: { ...actor, email, userId: user._id },
        reason: 'BAD_PASSWORD',
        metadata: { attempts: updated?.failedLoginAttempts, lockThreshold: LOCK_THRESHOLD },
      });
      throw new UnauthorizedError('Invalid email or password', 'INVALID_CREDENTIALS');
    }

    await this.users.registerSuccessfulLogin(user._id);
    const merchant = user.merchant ? await this.merchants.findById(user.merchant) : null;

    this.audit.record({
      action: AUDIT_ACTION.LOGIN,
      outcome: 'SUCCESS',
      actor: { ...actor, email, userId: user._id, role: user.role },
      merchant: user.merchant,
    });

    return {
      ...this.issueTokens(user),
      user: this.toUserView(user, merchant),
    };
  }

  /**
   * Mint an access/refresh pair.
   *
   * The access token carries the merchant binding so authorised requests need
   * no extra lookup, but it deliberately carries no permission *list* — roles
   * are resolved server-side, so a permission change takes effect on the next
   * request rather than when the token happens to expire.
   */
  issueTokens(user) {
    const payload = {
      sub: String(user._id),
      email: user.email,
      role: user.role,
      merchantId: user.merchant ? String(user.merchant) : null,
      tokenVersion: user.tokenVersion ?? 0,
    };

    const accessToken = jwt.sign(payload, config.jwt.accessSecret, {
      expiresIn: config.jwt.accessTtl,
      issuer: config.jwt.issuer,
      audience: config.jwt.audience,
    });

    const refreshToken = jwt.sign(
      { sub: payload.sub, tokenVersion: payload.tokenVersion, type: 'refresh' },
      config.jwt.refreshSecret,
      { expiresIn: config.jwt.refreshTtl, issuer: config.jwt.issuer, audience: config.jwt.audience },
    );

    return { accessToken, refreshToken, tokenType: 'Bearer', expiresIn: config.jwt.accessTtl };
  }

  /**
   * Verify an access token.
   * Signature validity is not enough — the token's `tokenVersion` must still
   * match the user's, which is how revocation works.
   */
  async verifyAccessToken(token) {
    let claims;
    try {
      claims = jwt.verify(token, config.jwt.accessSecret, {
        issuer: config.jwt.issuer,
        audience: config.jwt.audience,
      });
    } catch (err) {
      const code = err.name === 'TokenExpiredError' ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN';
      throw new UnauthorizedError(
        code === 'TOKEN_EXPIRED' ? 'Access token has expired' : 'Invalid access token',
        code,
      );
    }

    const user = await this.users.findById(claims.sub);
    if (!user || !user.isActive) throw new UnauthorizedError('Account is no longer active', 'ACCOUNT_DISABLED');
    if ((user.tokenVersion ?? 0) !== claims.tokenVersion) {
      throw new UnauthorizedError('Token has been revoked', 'TOKEN_REVOKED');
    }

    return { user, claims };
  }

  /** Rotate a refresh token into a new pair. */
  async refresh(refreshToken) {
    let claims;
    try {
      claims = jwt.verify(refreshToken, config.jwt.refreshSecret, {
        issuer: config.jwt.issuer,
        audience: config.jwt.audience,
      });
    } catch {
      throw new UnauthorizedError('Invalid refresh token', 'INVALID_REFRESH_TOKEN');
    }
    if (claims.type !== 'refresh') {
      // An access token must never be usable as a refresh token.
      throw new UnauthorizedError('Token is not a refresh token', 'INVALID_REFRESH_TOKEN');
    }

    const user = await this.users.findById(claims.sub);
    if (!user || !user.isActive) throw new UnauthorizedError('Account is no longer active');
    if ((user.tokenVersion ?? 0) !== claims.tokenVersion) {
      throw new UnauthorizedError('Token has been revoked', 'TOKEN_REVOKED');
    }

    const merchant = user.merchant ? await this.merchants.findById(user.merchant) : null;
    return { ...this.issueTokens(user), user: this.toUserView(user, merchant) };
  }

  /** Invalidate every token for a user. */
  async logout(userId) {
    await this.users.bumpTokenVersion(userId);
    return { revoked: true };
  }

  async register({ email, password, name, role = ROLE.MERCHANT, merchantObjectId = null }) {
    if (await this.users.exists({ email: String(email).toLowerCase() })) {
      throw new ConflictError('A user with this email already exists');
    }
    const passwordHash = await cryptoUtil.hashPassword(password);
    const user = await this.users.create({
      email, passwordHash, name, role, merchant: merchantObjectId,
    });
    this.log.info('user registered', { userId: user._id, role });
    return this.toUserView(user);
  }

  async changePassword({ userId, currentPassword, newPassword }) {
    const user = await this.users.findOne({ _id: userId }, { select: '+passwordHash' });
    if (!user) throw new NotFoundError('User');
    if (!(await cryptoUtil.verifyPassword(currentPassword, user.passwordHash))) {
      throw new UnauthorizedError('Current password is incorrect', 'INVALID_CREDENTIALS');
    }
    const passwordHash = await cryptoUtil.hashPassword(newPassword);
    // Bump the version in the same update: a password change must log out every
    // existing session, which is the whole point of changing it.
    await this.users.updateById(userId, {
      $set: { passwordHash },
      $inc: { tokenVersion: 1 },
    });
    return { changed: true };
  }

  async me(userId) {
    const user = await this.users.findById(userId);
    if (!user) throw new NotFoundError('User');
    const merchant = user.merchant ? await this.merchants.findById(user.merchant) : null;
    return this.toUserView(user, merchant);
  }

  toUserView(user, merchant) {
    return {
      id: String(user._id),
      email: user.email,
      name: user.name,
      role: user.role,
      lastLoginAt: user.lastLoginAt,
      merchant: merchant
        ? { merchantId: merchant.merchantId, name: merchant.name, status: merchant.status,
          defaultCurrency: merchant.defaultCurrency }
        : null,
    };
  }
}

module.exports = new AuthService();
module.exports.AuthService = AuthService;
