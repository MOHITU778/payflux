'use strict';

const Joi = require('joi');
const { ROLE } = require('../constants');
const { email } = require('./common.validator');

/**
 * Password policy.
 *
 * Length is weighted far more heavily than character-class rules: a 12+
 * character passphrase resists offline cracking better than "P@ss1!" while
 * being easier to remember. NIST SP 800-63B makes the same recommendation and
 * explicitly discourages mandatory composition rules.
 */
const password = Joi.string()
  .min(12)
  .max(128)
  .pattern(/[a-z]/, 'lowercase')
  .pattern(/[A-Z]/, 'uppercase')
  .pattern(/[0-9]/, 'digit')
  .required()
  .messages({
    'string.min': 'Password must be at least 12 characters',
    'string.pattern.name': 'Password must contain at least one {#name} character',
  });

const login = Joi.object({
  email: email.required(),
  // Not the strict policy — an existing password set under older rules must
  // still be able to sign in.
  password: Joi.string().max(128).required(),
});

const register = Joi.object({
  email: email.required(),
  password,
  name: Joi.string().min(2).max(120).required(),
  role: Joi.string().valid(...Object.values(ROLE)).default(ROLE.MERCHANT),
  merchantId: Joi.string().pattern(/^mrch_[A-Za-z0-9]{16}$/),
});

const refresh = Joi.object({ refreshToken: Joi.string().required() });

const changePassword = Joi.object({
  currentPassword: Joi.string().max(128).required(),
  newPassword: password.invalid(Joi.ref('currentPassword')).messages({
    'any.invalid': 'New password must differ from the current one',
  }),
});

module.exports = { login, register, refresh, changePassword, password };
