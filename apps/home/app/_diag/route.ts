// TEMPORARY diagnostic (spec 232 bring-up) — reports WHICH env vars are present
// (booleans only, never values) so we can see exactly what the Vercel runtime
// sees. DELETE after the broker key + KV are confirmed wired.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const has = (k: string) => Boolean(process.env[k] && process.env[k]!.length > 0);
  return Response.json({
    BROKER_PRIVATE_JWK: has('BROKER_PRIVATE_JWK'),
    BROKER_KID: has('BROKER_KID'),
    RPC_URL: has('RPC_URL'),
    DEMO_A2A_URL: has('DEMO_A2A_URL'),
    REDIRECT_URI_ALLOWLIST: has('REDIRECT_URI_ALLOWLIST'),
    KV_REST_API_URL: has('KV_REST_API_URL'),
    KV_REST_API_TOKEN: has('KV_REST_API_TOKEN'),
    UPSTASH_REDIS_REST_URL: has('UPSTASH_REDIS_REST_URL'),
    UPSTASH_REDIS_REST_TOKEN: has('UPSTASH_REDIS_REST_TOKEN'),
    nodeVersion: process.version,
  });
}
