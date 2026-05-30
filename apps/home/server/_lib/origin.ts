// Issuer-origin resolution for the Next/Vercel broker (spec 232; SEC-006 hardening).
//
// On Vercel the request reaches the handler on its REAL host (`alice.impact-agent.me`),
// so the per-person OP issuer (spec 230) is simply that host. We read it from the `Host`
// header (the canonical requested host — more reliable than `request.url`, which can
// reflect the server bind address) + `x-forwarded-proto`.
//
// SEC-006 closure: the broker validates the inbound `Host` against an ALLOWED_ISSUER_HOSTS
// allowlist. Wildcard pattern `*.impact-agent.me` matches any single label; explicit hosts
// match exactly. A request with a foreign Host (Vercel preview / mis-routed traffic / wildcard
// abuse) is rejected with HTTP 400 — the broker will NEVER sign `iss=<attacker-host>`.
//
// The Cloudflare Option-2 `X-Forwarded-Host`/`PROXY_SHARED_SECRET` proxy branch is GONE
// here (spec 232 §5) — there is no Worker proxy hop on Vercel.

/** Comma-separated env list of allowed issuer hosts. Entries may be exact (`impact-agent.me`)
 *  or wildcard (`*.impact-agent.me`). Wildcards match exactly ONE label (no dots) — the
 *  per-person subdomain pattern. */
const DEFAULT_ALLOWED_ISSUER_HOSTS = [
  'impact-agent.me',
  '*.impact-agent.me',
  // Localhost development — bare host + ports (matched by stripping :port below).
  'localhost',
  '127.0.0.1',
];

function parseAllowlist(env: { ALLOWED_ISSUER_HOSTS?: string } | undefined | null): string[] {
  const raw = (env?.ALLOWED_ISSUER_HOSTS ?? '').trim();
  if (!raw) return DEFAULT_ALLOWED_ISSUER_HOSTS;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

/** True iff `host` (without port) matches any pattern in the allowlist. */
export function isAllowedIssuerHost(host: string, env?: { ALLOWED_ISSUER_HOSTS?: string }): boolean {
  const bare = host.split(':')[0]?.toLowerCase() ?? '';
  if (!bare) return false;
  for (const pat of parseAllowlist(env)) {
    const p = pat.toLowerCase();
    if (p === bare) return true;
    if (p.startsWith('*.')) {
      const suffix = p.slice(2);
      // Wildcard matches EXACTLY one label — `<label>.<suffix>` with no extra dots.
      if (bare.endsWith('.' + suffix)) {
        const head = bare.slice(0, -(suffix.length + 1));
        if (head.length > 0 && !head.includes('.')) return true;
      }
    }
  }
  return false;
}

export function resolveOrigin(request: Request, env?: { ALLOWED_ISSUER_HOSTS?: string }): string {
  const host = request.headers.get('host');
  if (host) {
    // SEC-006: reject foreign / mis-routed hosts. Throwing here surfaces a 500 from
    // the route handler; the handlers themselves can choose to catch + 400 if they
    // want a softer wire response. Either way, no id_token gets signed.
    if (!isAllowedIssuerHost(host, env)) {
      throw new IssuerHostNotAllowedError(host);
    }
    const proto = request.headers.get('x-forwarded-proto') ?? (/^(localhost|127\.|\[?::1)/.test(host) ? 'http' : 'https');
    return `${proto}://${host}`;
  }
  return new URL(request.url).origin;
}

export class IssuerHostNotAllowedError extends Error {
  constructor(public readonly host: string) {
    super(`Host "${host}" is not in ALLOWED_ISSUER_HOSTS — refusing to sign id_token for this origin (SEC-006).`);
    this.name = 'IssuerHostNotAllowedError';
  }
}
