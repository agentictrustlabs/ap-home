// TEMPORARY diagnostic (spec 235 bring-up) — reports which broker env keys are PRESENT
// (booleans only, never values) + a build marker so we can tell a stale deployment from an
// env-scope problem. REMOVE once the Google OIDC env is confirmed live.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = (request: Request): Response => {
  const e = process.env;
  const body = {
    marker: 'spec235-debug-1',
    origin: new URL(request.url).origin,
    present: {
      BROKER_PRIVATE_JWK: !!e.BROKER_PRIVATE_JWK,
      GOOGLE_CLIENT_ID: !!e.GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET: !!e.GOOGLE_CLIENT_SECRET,
      GOOGLE_REDIRECT_URI: !!e.GOOGLE_REDIRECT_URI,
      A2A_CUSTODY_URL: !!e.A2A_CUSTODY_URL,
      A2A_CUSTODY_BRIDGE_SECRET: !!e.A2A_CUSTODY_BRIDGE_SECRET,
      DEMO_SSO_AUD: !!e.DEMO_SSO_AUD,
      REDIRECT_URI_ALLOWLIST: !!e.REDIRECT_URI_ALLOWLIST,
    },
  };
  return new Response(JSON.stringify(body, null, 2), {
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
};
