'use strict';

const authService = require('../services/auth.service');
const asyncHandler = require('../utils/asyncHandler');
const { success, created } = require('../utils/apiResponse');

module.exports = {
  /** POST /api/v1/auth/login */
  login: asyncHandler(async (req, res) => {
    const result = await authService.login({
      email: req.body.email,
      password: req.body.password,
      actor: { ipAddress: req.ip, userAgent: req.get('user-agent') },
    });
    return success(res, result, { message: 'Signed in' });
  }),

  /** POST /api/v1/auth/refresh — rotates the token pair. */
  refresh: asyncHandler(async (req, res) => {
    const result = await authService.refresh(req.body.refreshToken);
    return success(res, result);
  }),

  /** POST /api/v1/auth/logout — revokes every token for the caller. */
  logout: asyncHandler(async (req, res) => {
    const result = await authService.logout(req.user.id);
    return success(res, result, { message: 'All sessions revoked' });
  }),

  /** GET /api/v1/auth/me */
  me: asyncHandler(async (req, res) => {
    const user = await authService.me(req.user.id);
    return success(res, user);
  }),

  /** POST /api/v1/auth/register — admin-only user provisioning. */
  register: asyncHandler(async (req, res) => {
    const user = await authService.register({
      email: req.body.email,
      password: req.body.password,
      name: req.body.name,
      role: req.body.role,
      merchantObjectId: req.merchant?._id ?? null,
    });
    return created(res, user);
  }),

  /** POST /api/v1/auth/change-password — also invalidates existing sessions. */
  changePassword: asyncHandler(async (req, res) => {
    const result = await authService.changePassword({
      userId: req.user.id,
      currentPassword: req.body.currentPassword,
      newPassword: req.body.newPassword,
    });
    return success(res, result, { message: 'Password changed; please sign in again' });
  }),
};
