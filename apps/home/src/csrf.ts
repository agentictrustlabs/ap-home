// CSRF helper (ported from demo-web) — pairs with demo-a2a's /auth/csrf.
// Double-submit: a non-HttpOnly cookie JS can read, echoed in X-CSRF-Token.
const CSRF_COOKIE = 'agentic-csrf';
let cached: string | null = null;

function readCookie(name: string): string | null {
  for (const p of document.cookie.split(';')) {
    const [k, ...rest] = p.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return null;
}

export async function ensureCsrfToken(): Promise<string> {
  if (cached) return cached;
  const fromCookie = readCookie(CSRF_COOKIE);
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
  const token = cached ?? readCookie(CSRF_COOKIE);
  if (!token) throw new Error('csrfHeaders: call ensureCsrfToken() first.');
  return { 'X-CSRF-Token': decodeURIComponent(token) };
}
