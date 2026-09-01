import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { BehaviorSubject, catchError, filter, switchMap, take, throwError } from 'rxjs';
import { AuthService } from '../services/auth.service';

/** Shared across concurrent 401s so only one refresh is ever in flight. */
let refreshing = false;
const refreshed$ = new BehaviorSubject<string | null>(null);

/** Endpoints that must never carry a bearer token or trigger a refresh loop. */
const PUBLIC_PATHS = ['/auth/login', '/auth/refresh'];

/**
 * Attaches the bearer token and transparently refreshes an expired one.
 *
 * ── The concurrency problem ────────────────────────────────────────────────
 * A dashboard fires six requests at once. The access token expires. Without
 * coordination all six would independently call `/auth/refresh`, and because
 * refresh rotates the token, five of them would present an already-rotated
 * token and fail — logging the user out mid-session.
 *
 * The `refreshing` flag plus the `refreshed$` subject means the first 401
 * performs the refresh while the others queue on the subject and replay once
 * the new token arrives.
 */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthService);
  const isPublic = PUBLIC_PATHS.some((path) => req.url.includes(path));
  const token = auth.accessToken;

  const authorized = token && !isPublic
    ? req.clone({ setHeaders: { Authorization: `Bearer ${token}` } })
    : req;

  return next(authorized).pipe(
    catchError((error: unknown) => {
      const is401 = error instanceof HttpErrorResponse && error.status === 401;
      if (!is401 || isPublic || !auth.refreshToken) return throwError(() => error);

      // A revoked token can never be refreshed — sign out rather than loop.
      const code = (error as HttpErrorResponse).error?.error?.code;
      if (code === 'TOKEN_REVOKED' || code === 'ACCOUNT_DISABLED') {
        auth.logout();
        return throwError(() => error);
      }

      if (refreshing) {
        // Queue behind the in-flight refresh, then replay with the new token.
        return refreshed$.pipe(
          filter((value): value is string => value !== null),
          take(1),
          switchMap((fresh) => next(req.clone({ setHeaders: { Authorization: `Bearer ${fresh}` } }))),
        );
      }

      refreshing = true;
      refreshed$.next(null);

      return auth.refresh().pipe(
        switchMap((res) => {
          refreshing = false;
          refreshed$.next(res.data.accessToken);
          return next(req.clone({ setHeaders: { Authorization: `Bearer ${res.data.accessToken}` } }));
        }),
        catchError((refreshError) => {
          refreshing = false;
          auth.logout();
          return throwError(() => refreshError);
        }),
      );
    }),
  );
};
