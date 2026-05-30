// CSRF helper (ported from demo-web) — pairs with demo-a2a's /auth/csrf.
// Double-submit: a non-HttpOnly cookie JS can read, echoed in X-CSRF-Token.
//
// SEC-012: the cache invalidates when the cookie is missing or has changed
// (server-side rotation flushes the cached value). `invalidateCsrfCache()` lets
// fetch wrappers force-refresh on 401 from the server. Helpers re-read the
// cookie on every call rather than trusting a stale module-global value.
const CSRF_COOKIE = 'agentic-csrf';
let cached: string | null = null;

function readCookie(name: string): string | null {
  for (const p of document.cookie.split(';')) {
    const [k, ...rest] = p.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return null;
}

/** Force the cached token to be re-fetched on the next call. Fetch wrappers should
 *  call this on a 401/403 response so a server-rotated token doesn't cause a 401 storm. */
export function invalidateCsrfCache(): void {
  cached = null;
}

export async function ensureCsrfToken(): Promise<string> {
  // SEC-012: if the cookie has changed (server-rotated) since we cached, drop
  // the cache and re-read. Module-cache is a hot-path optimization, not the
  // truth — the cookie is.
  const fromCookie = readCookie(CSRF_COOKIE);
  if (cached && fromCookie && decodeURIComponent(fromCookie) === cached) return cached;
  if (fromCookie) {
    cached = decodeURIComponent(fromCookie);
    return cached;
  }
  const res = await fetch('/a2a/auth/csrf', { method: 'GET', credentials: 'include' });
  if (!res.ok) throw new Error(`csrf token fetch failed: HTTP ${res.status}`);
  cached = ((await res.json()) as { token: string }).token;
  return cached;
}

export function csrfHeaders(): Record<string, string> {
  // SEC-012: always prefer the COOKIE value over the module cache — if rotation
  // happened mid-session, the cookie has the new value and the cache is stale.
  const fromCookie = readCookie(CSRF_COOKIE);
  const token = fromCookie ? decodeURIComponent(fromCookie) : cached;
  if (!token) throw new Error('csrfHeaders: call ensureCsrfToken() first.');
  return { 'X-CSRF-Token': token };
}
