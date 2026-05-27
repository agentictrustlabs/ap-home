// TEMPORARY diagnostic (spec 232 bring-up). Reports WHICH env vars are present
// (booleans, never values) AND the actual error from getServer (broker key) +
// a KV round-trip — so we see exactly why /jwks and /connect/nonce 500.
// DELETE once green. (Folder must NOT start with `_` — Next treats `_foo` as a
// private, non-routed folder.)
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { makeEnv } from '../_lib/env';
import { kv } from '../_lib/kv';
import { getServer } from '../../server/_lib/server-broker';

export async function GET() {
  const has = (k: string) => Boolean(process.env[k] && process.env[k]!.length > 0);
  const out: Record<string, unknown> = {
    env: {
      BROKER_PRIVATE_JWK: has('BROKER_PRIVATE_JWK'),
      BROKER_KID: has('BROKER_KID'),
      RPC_URL: has('RPC_URL'),
      DEMO_A2A_URL: has('DEMO_A2A_URL'),
      REDIRECT_URI_ALLOWLIST: has('REDIRECT_URI_ALLOWLIST'),
      KV_REST_API_URL: has('KV_REST_API_URL'),
      KV_REST_API_TOKEN: has('KV_REST_API_TOKEN'),
      UPSTASH_REDIS_REST_URL: has('UPSTASH_REDIS_REST_URL'),
      UPSTASH_REDIS_REST_TOKEN: has('UPSTASH_REDIS_REST_TOKEN'),
    },
    node: process.version,
  };
  try {
    await getServer(makeEnv());
    out.getServer = 'ok';
  } catch (e) {
    out.getServer = 'ERROR: ' + (e instanceof Error ? e.message : String(e));
  }
  try {
    await kv.put('diag:ping', '1', { expirationTtl: 60 });
    out.kv = (await kv.get('diag:ping')) === '1' ? 'ok' : 'unexpected';
  } catch (e) {
    out.kv = 'ERROR: ' + (e instanceof Error ? e.message : String(e));
  }
  return Response.json(out);
}
