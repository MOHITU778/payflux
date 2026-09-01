'use strict';

const { Schema, model } = require('mongoose');
const { ROLE } = require('../constants');

/**
 * Console users: platform staff (ADMIN, SUPPORT) and merchant operators.
 *
 * A MERCHANT user is scoped to exactly one merchant; every repository query on
 * merchant-owned data filters on that link, which is how tenant isolation is
 * enforced at the data layer rather than trusting each controller.
 */
const userSchema = new Schema(
  {
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      match: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Invalid email address'],
    },
    // `select: false` keeps the hash out of every query result by default, so
    // it cannot leak through a careless `res.json(user)`.
    passwordHash: { type: String, required: true, select: false },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    role: { type: String, enum: Object.values(ROLE), required: true, index: true },
    merchant: { type: Schema.Types.ObjectId, ref: 'Merchant', default: null, index: true },
    isActive: { type: Boolean, default: true },

    // Credential-stuffing defence: lock the account after repeated failures.
    failedLoginAttempts: { type: Number, default: 0 },
    lockedUntil: { type: Date, default: null },
    lastLoginAt: { type: Date, default: null },

    // Bumped on password change / forced logout; tokens carrying an older
    // value are rejected, giving us revocation without a token blacklist.
    tokenVersion: { type: Number, default: 0 },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform(_doc, ret) {
        delete ret.passwordHash;
        delete ret.__v;
        return ret;
      },
    },
  },
);

userSchema.index({ email: 1 }, { unique: true });
userSchema.index({ merchant: 1, role: 1 });

/** True while a failed-login lockout is still in effect. */
userSchema.virtual('isLocked').get(function isLocked() {
  return Boolean(this.lockedUntil && this.lockedUntil > new Date());
});

module.exports = model('User', userSchema);
