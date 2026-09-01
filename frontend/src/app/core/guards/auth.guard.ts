import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from '../services/auth.service';
import { Role } from '../models';

/**
 * Route guards.
 *
 * These are a *usability* control, not a security control: they stop a user
 * navigating to a page they cannot use. The actual enforcement is server-side
 * RBAC — a guard can be bypassed by anyone willing to edit the bundle, so
 * nothing here is trusted for authorisation.
 */

export const authGuard: CanActivateFn = (_route, state) => {
  const auth = inject(AuthService);
  const router = inject(Router);

  if (auth.isAuthenticated()) return true;

  // Preserve the intended destination so login can return the user to it.
  return router.createUrlTree(['/login'], { queryParams: { redirect: state.url } });
};

/** Restrict a route to specific roles. */
export const roleGuard = (...roles: Role[]): CanActivateFn => () => {
  const auth = inject(AuthService);
  const router = inject(Router);

  if (!auth.isAuthenticated()) return router.createUrlTree(['/login']);
  if (auth.hasRole(...roles)) return true;
  return router.createUrlTree(['/dashboard']);
};

/** Keep a signed-in user off the login page. */
export const guestGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  return auth.isAuthenticated() ? router.createUrlTree(['/dashboard']) : true;
};
