// spec 323 W3.2 — generic ORG-vault access is now FULLY DO-mediated: the org's invite records
// (`org.invite:*`) read/written through the org's InteractionsDO (`invite.get`/`invite.put`, which
// wield the DO-held write-only delivery wire). The Home holds NO org wire. Returns null when the org
// hasn't enabled storage (its DO has no delivery grant — `status.deliveryGranted` is false); callers
// decide whether that's fatal (invites) or best-effort (tracking). Blast-zone unchanged (spec 315):
// invitee email hash + status live encrypted in the org vault, never in KV.
import type { ServerVaultTransport } from './delegated-vault';
import { bridgeInteractions, interactionsBridgeConfigured, type InteractionsBridgeEnv } from './interactions-bridge';

type OrgVaultEnv = InteractionsBridgeEnv;

/** A vault transport bound to the ORG over its DO-held delivery wire, or null when the org hasn't
 *  enabled storage. The transport's get/set bridge to the org's InteractionsDO invite ops. */
export async function orgVault(env: OrgVaultEnv, orgSA: string): Promise<ServerVaultTransport | null> {
  if (!interactionsBridgeConfigured(env)) return null;
  // Probe the DO: no delivery grant ⇒ storage not enabled ⇒ null (status is an open read).
  try {
    const st = await fetch(`${env.A2A_CUSTODY_URL!.replace(/\/$/, '')}/interactions/${orgSA.toLowerCase()}/status`).then((r) => r.json()) as { deliveryGranted?: boolean };
    if (!st?.deliveryGranted) return null;
  } catch {
    return null;
  }
  return {
    async get(recordType: string) {
      const r = await bridgeInteractions<{ record?: unknown }>(env, orgSA, 'invite.get', { resource: recordType });
      return r.ok ? (r.body.record ?? null) : null;
    },
    async set(recordType: string, data: unknown) {
      const r = await bridgeInteractions(env, orgSA, 'invite.put', { resource: recordType, data });
      if (!r.ok) throw new Error(r.body.error ?? `org.invite write via InteractionsDO failed (${r.status})`);
    },
  } as ServerVaultTransport;
}
