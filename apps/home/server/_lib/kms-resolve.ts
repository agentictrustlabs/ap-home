// Shared derive-only bridge to the KMS master holder (demo-a2a): given a credential subject
// (iss, sub) + rotation, return the per-subject KMS-custodied SA (spec 235 §5). Server-to-server,
// bridge-HMAC authenticated (SEC-010). The broker can't derive it itself — it holds no master.
//
// Generic on (iss, sub): the SAME endpoint serves Google (iss = 'https://accounts.google.com') and
// email (iss = 'email', sub = SHA-256(email)). The bridge audience `custody.google.resolve` is that
// endpoint's HMAC namespace — a purpose tag on `/custody/oidc/resolve`, NOT a claim about the credential
// kind — so email reuses it (no demo-a2a change). A future coordinated rename to `custody.oidc.resolve`
// would touch both the broker and demo-a2a's `expectedAudience`; kept a single constant here for that.
import type { CanonicalAgentId } from '@agenticprimitives/types';
import { signBridgeCall } from './bridge-hmac';
import type { Env } from './server-broker';

/** The custody-resolve endpoint's bridge audience (its HMAC namespace, not a per-credential name). */
export const CUSTODY_RESOLVE_AUDIENCE = 'custody.google.resolve';

export async function resolveKmsAgent(
  env: Env,
  iss: string,
  sub: string,
  rotation: number,
): Promise<{ ok: true; agentId: CanonicalAgentId } | { ok: false; reason: string }> {
  if (!env.A2A_CUSTODY_URL || !env.A2A_CUSTODY_BRIDGE_SECRET) {
    return { ok: false, reason: 'custody not configured' };
  }
  try {
    // SEC-010: per-call HMAC envelope. A compromise of the shared key yields short-window replay only —
    // bounded by BRIDGE_FRESHNESS_MS + single-use nonces at the receiver.
    const envelope = await signBridgeCall({
      secret: env.A2A_CUSTODY_BRIDGE_SECRET,
      audience: CUSTODY_RESOLVE_AUDIENCE,
      payload: { iss, sub, rotation },
    });
    const res = await fetch(`${env.A2A_CUSTODY_URL.replace(/\/$/, '')}/custody/oidc/resolve`, {
      method: 'POST',
      headers: envelope.headers,
      body: envelope.body,
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; agentId?: string; error?: string };
    if (!res.ok || !body.ok || !body.agentId) return { ok: false, reason: body.error ?? `resolve HTTP ${res.status}` };
    return { ok: true, agentId: body.agentId as CanonicalAgentId };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : 'resolve failed' };
  }
}
