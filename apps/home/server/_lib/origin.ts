// Issuer-origin resolution for the Next/Vercel broker (spec 232). On Vercel the
// request reaches the handler on its REAL host (`alice.impact-agent.io`), so the
// per-person OP issuer (spec 230) is simply that host. We read it from the `Host`
// header (the canonical requested host — more reliable than `request.url`, which
// can reflect the server bind address) + `x-forwarded-proto`.
//
// The Cloudflare Option-2 `X-Forwarded-Host`/`PROXY_SHARED_SECRET` proxy branch
// is GONE here (spec 232 §5) — there is no Worker proxy hop on Vercel, so no
// shared-secret issuer-spoofing surface. `env` is accepted for call-site
// signature compatibility with the ported handlers but unused.
export function resolveOrigin(request: Request, _env?: unknown): string {
  const host = request.headers.get('host');
  if (host) {
    const proto = request.headers.get('x-forwarded-proto') ?? (/^(localhost|127\.|\[?::1)/.test(host) ? 'http' : 'https');
    return `${proto}://${host}`;
  }
  return new URL(request.url).origin;
}
