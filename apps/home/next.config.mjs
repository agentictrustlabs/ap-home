/** @type {import('next').NextConfig} */
const DEMO_A2A_URL = process.env.DEMO_A2A_URL || 'https://demo-a2a-production.richardpedersen3.workers.dev';
// spec 278 P5: the vault-key ceremony POSTs the signed VaultKeyAuthorization to demo-mcp's
// /custody/vault-key/bind. Proxy it same-origin (the demo-mcp bind route has no CORS) — same
// pattern as /a2a. Production MUST set DEMO_MCP_URL; the fallback is solo-dev convenience only.
const DEMO_MCP_URL = process.env.DEMO_MCP_URL || 'https://demo-mcp-production.richardpedersen3.workers.dev';
// spec 288 §6 — MCP DATA (`/a2a/mcp/*`) routes through the Agentic Edge (web → edge → a2a → MCP) so the edge
// signs the GatewayAssertion demo-a2a requires (DEMO_REQUIRE_GATEWAY_ASSERTION=true); auth/session/custody
// (`/a2a/*`) stay direct to demo-a2a. demo-a2a is edge-required in prod, so the Home MUST route through the
// edge or `/a2a/mcp/*` writes (e.g. the profile save) 401 `gateway_assertion_required`. Defaults to the prod
// edge (matching DEMO_A2A_URL/DEMO_MCP_URL) so this works on Vercel WITHOUT a per-deploy env var; `??` lets a
// local dev DISABLE it with an explicit `DEMO_EDGE_URL=''` (then `/a2a/mcp/*` goes direct to a local demo-a2a).
const DEMO_EDGE_URL = process.env.DEMO_EDGE_URL ?? 'https://demo-edge-production.richardpedersen3.workers.dev';

// EXT-001 / EXT-009 — security headers baseline applied to every route. A strict CSP
// with nonces will land in a follow-up wave (the OIDC SPA mixes inline event handlers
// and dynamic JS that need careful nonce wiring before a `default-src 'self'` CSP
// won't break the live ceremony). The headers below close the cheap-to-deploy
// clickjacking / MIME-sniff / referrer-leak / permissions-API surfaces with no risk
// of breaking the running flows.
const securityHeaders = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()' },
  // HSTS — long max-age + includeSubDomains because the deployment is HTTPS-only on
  // *.impact-agent.me. Preload is intentionally NOT requested here (would lock the
  // apex into HTTPS-everywhere on the entire registrable, harder to back out).
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
  // The broker's id_tokens / cookies should never leak via prefetch.
  { key: 'X-DNS-Prefetch-Control', value: 'off' },
  // Cross-Origin-Opener-Policy: 'same-origin' would break the popup-based OIDC flows
  // that relying apps open (the SPA at the home shares window.opener for the
  // postMessage code delivery — audit-F3 exact-origin gate). Use
  // 'same-origin-allow-popups' to keep popups working while isolating the BroadcastChannel
  // and process-spectre surfaces.
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin-allow-popups' },
];

const nextConfig = {
  reactStrictMode: true,
  // Workspace packages are symlinked from the monorepo; transpile them so Next
  // bundles their (ESM) source/dist consistently across server + client.
  // EXT-004: the list grows with every consumed package; a future cleanup wave
  // collapses thin wrappers (EXT-003) which will shrink this list naturally.
  transpilePackages: [
    '@agenticprimitives/types',
    '@agenticprimitives/connect',
    '@agenticprimitives/connect-auth',
    '@agenticprimitives/agent-account',
    '@agenticprimitives/agent-naming',
    '@agenticprimitives/agent-profile',
    '@agenticprimitives/agent-relationships',
    '@agenticprimitives/delegation',
    '@agenticprimitives/identity-directory',
    '@agenticprimitives/identity-directory-adapters',
  ],
  // V1 parity with the Vite dev proxy + the Pages `/a2a/*` proxy: forward the
  // relayer calls to demo-a2a (strip the `/a2a` prefix). V2 replaces this with a
  // real Route Handler (`app/a2a/[...path]/route.ts`).
  // EXT-009: the hardcoded fallback hits a worker owned by an individual contributor;
  // production deployments MUST set `DEMO_A2A_URL` explicitly. The fallback is
  // retained only for solo-dev convenience and is not part of the deployment surface.
  async rewrites() {
    return [
      // spec 288 §6 — MCP DATA through the edge when required (matched BEFORE the general /a2a rule). The edge
      // matches `/mcp/*` → demo-a2a; the assertion binds the same path demo-a2a verifies.
      ...(DEMO_EDGE_URL
        ? [{ source: '/a2a/mcp/:path*', destination: `${DEMO_EDGE_URL}/mcp/:path*` }]
        : []),
      { source: '/a2a/:path*', destination: `${DEMO_A2A_URL}/:path*` },
      // spec 278 P5 — vault-key ceremony → demo-mcp (server-side proxy; dodges CORS on /bind). NOT a data read.
      { source: '/mcp-bind/:path*', destination: `${DEMO_MCP_URL}/:path*` },
    ];
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: securityHeaders,
      },
      // Remote-signer arrival (?signer=remote&opener=<allowlisted> on the front door only): the
      // opener relationship IS the transport — the relying app's tab holds the demo persona's key
      // and signs over postMessage (src/lib/remote-signer.ts, exact-origin gated). COOP
      // 'same-origin-allow-popups' would put this popup in a new browsing-context group and sever
      // window.opener, so the bridge could never arm. Scope: the root document with that exact
      // query only; every other route keeps the strict baseline.
      {
        source: '/',
        has: [{ type: 'query', key: 'signer', value: 'remote' }],
        headers: [{ key: 'Cross-Origin-Opener-Policy', value: 'unsafe-none' }],
      },
    ];
  },
};

export default nextConfig;
