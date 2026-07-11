// Home-server → InteractionsDO bridge (spec 322 W3f — the 1-1 inbox residency channel).
//
// The Home reaches an owner's `inbox.data` and dm bodies ONLY through the owner's per-principal
// InteractionsDO on demo-a2a — the serialized single writer/reader over the owner's interactions
// grant. This is the SAME SEC-010 HMAC envelope as the custody bridge (timestamp + nonce + raw-body
// hash + audience `interactions.<op>`); the standing delivery grant is write-only and can no longer
// read mail. Fail-closed (ADR-0013): no configured bridge ⇒ no mail I/O — never a weaker path.
import { signBridgeCall } from '../_lib/bridge-hmac';

export interface InteractionsBridgeEnv {
  A2A_CUSTODY_URL?: string;
  A2A_CUSTODY_BRIDGE_SECRET?: string;
}

export function interactionsBridgeConfigured(env: InteractionsBridgeEnv): boolean {
  return !!(env.A2A_CUSTODY_URL?.trim() && env.A2A_CUSTODY_BRIDGE_SECRET?.trim());
}

/** One bridge-signed DO op. Returns the parsed body; `ok:false` carries the DO's error + status. */
export async function bridgeInteractions<T = Record<string, unknown>>(
  env: InteractionsBridgeEnv,
  owner: string,
  op: 'inbox.get' | 'inbox.put' | 'inbox.body.get',
  payload: unknown,
): Promise<{ ok: boolean; status: number; body: T & { error?: string } }> {
  if (!interactionsBridgeConfigured(env)) {
    return { ok: false, status: 503, body: { error: 'interactions bridge not configured' } as T & { error?: string } };
  }
  const envelope = await signBridgeCall({
    secret: env.A2A_CUSTODY_BRIDGE_SECRET!,
    audience: `interactions.${op}`,
    payload,
  });
  const resp = await fetch(`${env.A2A_CUSTODY_URL!.replace(/\/$/, '')}/interactions/${owner.toLowerCase()}/${op}`, {
    method: 'POST',
    headers: envelope.headers,
    body: envelope.body, // EXACT signed bytes — the receiver hashes the raw body
  });
  const body = (await resp.json().catch(() => ({}))) as T & { error?: string };
  return { ok: resp.ok, status: resp.status, body };
}
