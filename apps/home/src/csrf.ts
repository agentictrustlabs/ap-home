// CSRF helper (ported from demo-web) — pairs with demo-a2a's /auth/csrf.
// The signed, origin-bound token in `X-CSRF-Token` IS the defense (demo-a2a never compares it to the
// cookie); the non-HttpOnly cookie is just where the last minted token is parked.
//
// SEC-012: the cache invalidates when the cookie is missing or has changed
// (server-side rotation flushes the cached value). `invalidateCsrfCache()` lets
// fetch wrappers force-refresh on 401 from the server. Helpers re-read the
// cookie on every call rather than trusting a stale module-global value.
//
// ORIGIN CHECK: cookies ignore ports, so when several apps run on `localhost` (this Home on :5373,
// demo-web on :5173 — the local dev topology) they SHARE the `agentic-csrf` cookie. A token minted for
// another origin verifies as `csrf invalid` here, so a cookie token is only trusted when the origin
// stamped inside it is this page's origin; otherwise a fresh one is minted.
const CSRF_COOKIE = 'agentic-csrf';
let cached: string | null = null;

/**
 * EVERY cookie with this name, not the first.
 *
 * `agentic-csrf` is shared across `faithnet.me` and `www.faithnet.me` — cookies ignore the host prefix —
 * and a host-scoped cookie can sit alongside a domain-scoped one under the SAME name. `document.cookie`
 * then returns both, in an order nothing promises, and reading only the first pinned whichever came out
 * on top: a token minted for the apex, sent from www, rejected as `csrf invalid` on every request forever.
 * Re-minting did not help, because the mint wrote the OTHER cookie.
 */
function readCookies(name: string): string[] {
  const out: string[] = [];
  for (const p of document.cookie.split(';')) {
    const [k, ...rest] = p.trim().split('=');
    if (k === name) out.push(rest.join('='));
  }
  return out;
}

/** The cookie token minted for THIS origin, if any of them was. */
function readCookie(name: string): string | null {
  const all = readCookies(name).map((v) => { try { return decodeURIComponent(v); } catch { return v; } });
  return all.find((v) => forThisOrigin(v)) ?? all[0] ?? null;
}

/** The origin a token was minted for (`base64url(JSON{origin,ts,…}).base64url(hmac)`), or null. */
function tokenOrigin(token: string): string | null {
  try {
    const head = token.split('.')[0] ?? '';
    const b64 = head.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (head.length % 4)) % 4);
    const parsed = JSON.parse(atob(b64)) as { origin?: string };
    return typeof parsed.origin === 'string' ? parsed.origin : null;
  } catch {
    return null;
  }
}

const forThisOrigin = (token: string | null): token is string =>
  !!token && tokenOrigin(token) === window.location.origin;

/** Force the cached token to be re-fetched on the next call. Fetch wrappers should
 *  call this on a 401/403 response so a server-rotated token doesn't cause a 401 storm. */
export function invalidateCsrfCache(): void {
  cached = null;
}

export async function ensureCsrfToken(): Promise<string> {
  // SEC-012: if the cookie has changed (server-rotated) since we cached, drop
  // the cache and re-read. Module-cache is a hot-path optimization, not the
  // truth — the cookie is (when it was minted for THIS origin).
  const cookieToken = readCookie(CSRF_COOKIE);
  if (cached && cookieToken === cached) return cached;
  if (forThisOrigin(cookieToken)) {
    cached = cookieToken;
    return cached;
  }
  if (forThisOrigin(cached)) return cached;
  const res = await fetch('/a2a/auth/csrf', { method: 'GET', credentials: 'include' });
  if (!res.ok) throw new Error(`csrf token fetch failed: HTTP ${res.status}`);
  cached = ((await res.json()) as { token: string }).token;
  return cached;
}

export function csrfHeaders(): Record<string, string> {
  // SEC-012: prefer the COOKIE value over the module cache when it is ours — if rotation
  // happened mid-session, the cookie has the new value and the cache is stale. A cookie
  // minted for another local origin is ignored in favour of our own cached token.
  const cookieToken = readCookie(CSRF_COOKIE);
  // A token stamped for ANOTHER origin is not a last resort — it is a request the server will reject with
  // certainty. Sending it anyway turns a recoverable "mint me a new one" into a permanent `csrf invalid`.
  const token = forThisOrigin(cookieToken) ? cookieToken : forThisOrigin(cached) ? cached : null;
  if (!token) throw new Error('csrfHeaders: no token for this origin — call ensureCsrfToken() first.');
  return { 'X-CSRF-Token': token };
}
