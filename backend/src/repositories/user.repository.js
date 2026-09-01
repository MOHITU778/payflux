'use strict';

const BaseRepository = require('./base.repository');
const { User } = require('../models');

const LOCK_THRESHOLD = 5;
const LOCK_DURATION_MS = 15 * 60 * 1000;

class UserRepository extends BaseRepository {
  constructor() { super(User); }

  /** Includes the password hash, which is `select: false` by default. */
  findByEmailWithSecret(email) {
    return this.findOne({ email: String(email).toLowerCase() }, { select: '+passwordHash' });
  }

  findByEmail(email) {
    return this.findOne({ email: String(email).toLowerCase() });
  }

  /**
   * Record a failed sign-in and lock the account once the threshold is reached.
   * Written as a single aggregation-pipeline update so the increment and the
   * lock decision happen atomically — two concurrent guesses cannot both read
   * "4 attempts" and slip past the fifth.
   */
  registerFailedLogin(userId) {
    return this.updateById(userId, [
      {
        $set: {
          failedLoginAttempts: { $add: ['$failedLoginAttempts', 1] },
          lockedUntil: {
            $cond: [
              { $gte: [{ $add: ['$failedLoginAttempts', 1] }, LOCK_THRESHOLD] },
              { $add: ['$$NOW', LOCK_DURATION_MS] },
              '$lockedUntil',
            ],
          },
        },
      },
    ]);
  }

  registerSuccessfulLogin(userId) {
    return this.updateById(userId, {
      $set: { failedLoginAttempts: 0, lockedUntil: null, lastLoginAt: new Date() },
    });
  }

  /** Invalidate every issued token for this user (password change, forced logout). */
  bumpTokenVersion(userId) {
    return this.updateById(userId, { $inc: { tokenVersion: 1 } });
  }
}

module.exports = new UserRepository();
module.exports.UserRepository = UserRepository;
module.exports.LOCK_THRESHOLD = LOCK_THRESHOLD;
