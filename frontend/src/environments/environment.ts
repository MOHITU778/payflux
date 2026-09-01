/**
 * Development environment.
 *
 * The API base is a relative path so the dev server's proxy (proxy.conf.json)
 * and the production nginx reverse proxy both work without a rebuild — and,
 * more importantly, the browser only ever talks to one origin, so CORS and
 * third-party-cookie rules never come into play.
 */
export const environment = {
  production: false,
  apiBase: '/api/v1',
  /** Dashboard auto-refresh cadence. */
  pollIntervalMs: 15_000,
};
