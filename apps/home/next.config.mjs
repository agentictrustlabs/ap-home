/** @type {import('next').NextConfig} */
const DEMO_A2A_URL = process.env.DEMO_A2A_URL || 'https://demo-a2a-production.richardpedersen3.workers.dev';

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
    return [{ source: '/a2a/:path*', destination: `${DEMO_A2A_URL}/:path*` }];
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
