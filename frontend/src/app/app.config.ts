import { ApplicationConfig, provideZoneChangeDetection } from '@angular/core';
import { provideRouter, withComponentInputBinding, withInMemoryScrolling } from '@angular/router';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { routes } from './app.routes';
import { authInterceptor } from './core/interceptors/auth.interceptor';
import { errorInterceptor } from './core/interceptors/error.interceptor';

/**
 * Application providers.
 *
 * Interceptor order is significant: `authInterceptor` runs first so it can
 * transparently refresh and replay a 401 before `errorInterceptor` ever sees
 * it — otherwise every expired token would flash an error toast at the user
 * moments before the request quietly succeeded on retry.
 */
export const appConfig: ApplicationConfig = {
  providers: [
    // Coalescing batches change detection triggered in the same tick, which
    // matters on a dashboard that updates many bound values per poll.
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(
      routes,
      withComponentInputBinding(),   // route params arrive as @Input()s
      withInMemoryScrolling({ scrollPositionRestoration: 'top' }),
    ),
    provideHttpClient(withInterceptors([authInterceptor, errorInterceptor])),
  ],
};
