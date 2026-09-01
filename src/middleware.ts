/**
 * Session middleware.
 *
 * The matcher EXCLUDES the webhook and worker prefixes, and that exclusion is load-bearing
 * rather than cosmetic. Next door, a middleware that redirected sessionless requests to a
 * page turned unknown URLs into soft-200s — and a Meta webhook POST is the most sessionless
 * request there is. Routed through this, a genuine delivery would be redirected to a
 * dashboard and silently ACKed.
 *
 * Nothing here may read the request body either: consuming the stream makes the downstream
 * HMAC unverifiable, and the failure looks like a wrong secret rather than a consumed body.
 *
 * The exclusion is asserted by src/middleware.test.ts, not trusted to this comment.
 */
export const EXCLUDED_PREFIXES = ['/api/webhooks/', '/api/workers/'] as const;

export function isExcludedFromMiddleware(pathname: string): boolean {
  return EXCLUDED_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

export function middleware(): Response | undefined {
  return undefined;
}

export const config = {
  matcher: ['/((?!api/webhooks|api/workers|_next/static|_next/image|favicon.ico).*)'],
};
