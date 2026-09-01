import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, throwError } from 'rxjs';
import { ToastService } from '../services/toast.service';

/**
 * Turns an API error envelope into a user-facing message.
 *
 * The server always returns `{ error: { code, message, details } }`, so the
 * message shown is the server's own wording rather than a generic "something
 * went wrong" — a merchant seeing "Refund of 70000 exceeds the refundable
 * balance of 60000" can act on it immediately.
 *
 * 401 is deliberately silent: the auth interceptor is already refreshing or
 * redirecting, and a toast would just be noise on a page the user is leaving.
 */
export const errorInterceptor: HttpInterceptorFn = (req, next) => {
  const toast = inject(ToastService);

  return next(req).pipe(
    catchError((error: unknown) => {
      if (!(error instanceof HttpErrorResponse)) return throwError(() => error);

      if (error.status === 401) return throwError(() => error);

      const body = error.error as
        | { error?: { code: string; message: string; details?: unknown }; meta?: { correlationId?: string } }
        | undefined;
      const apiError = body?.error;
      const correlationId = body?.meta?.correlationId;

      if (error.status === 0) {
        toast.error('Cannot reach the API', 'Check that the backend is running.');
      } else if (error.status === 429) {
        toast.warning('Rate limited', apiError?.message ?? 'Too many requests — please slow down.');
      } else if (error.status >= 500) {
        toast.error('Server error', apiError?.message ?? 'An unexpected error occurred.', correlationId);
      } else if (apiError) {
        // Field-level validation errors are listed so the user can fix them all
        // at once instead of one round trip per mistake.
        const details = Array.isArray(apiError.details)
          ? (apiError.details as { field: string; message: string }[])
            .map((d) => `${d.field}: ${d.message}`).join('; ')
          : undefined;
        toast.error(apiError.message, details, correlationId);
      } else {
        toast.error(`Request failed (${error.status})`);
      }

      return throwError(() => error);
    }),
  );
};
