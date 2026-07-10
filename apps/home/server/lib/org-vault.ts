// Generic ORG-vault access over the org's standing steward-signed grant (the SAME grant messaging uses,
// widened to vault:org.invite:*). Blast-zone (spec 315): org-owned invite records — invitee email hash +
// status — live ENCRYPTED in the org vault, delegation-gated; KV holds only a random-token→public-org
// pointer. Returns null when the org hasn't enabled vault storage (no grant / no transport base) — the
// caller decides whether that's fatal (invites) or best-effort (tracking).
import { createServerVaultTransport } from './vault-transport';
import type { ServerVaultTransport } from './delegated-vault';
import { loadInboxDeliveryGrant } from '../connect/inbox-delivery-grant';
import type { DelegationWire } from '../../src/lib/delegation';

interface OrgVaultEnv {
  AUTH_CODES: { get(k: string): Promise<string | null> };
  DEMO_EDGE_URL?: string;
  A2A_VAULT_URL?: string;
  A2A_CUSTODY_URL?: string;
  DELIVERY_SERVICE_SA?: string;
}

const nonEmpty = (s?: string): boolean => !!(s && s.trim());
const baseUrl = (env: OrgVaultEnv): string | undefined =>
  [env.DEMO_EDGE_URL, env.A2A_VAULT_URL, env.A2A_CUSTODY_URL].find(nonEmpty);

/** A vault transport bound to the ORG (delegator = org SA) over its standing grant, or null if the org
 *  hasn't enabled vault storage (no delivery-service SA / no transport base / no stored grant). */
export async function orgVault(env: OrgVaultEnv, orgSA: string): Promise<ServerVaultTransport | null> {
  const base = baseUrl(env);
  if (!nonEmpty(env.DELIVERY_SERVICE_SA) || !base) return null;
  const grant = await loadInboxDeliveryGrant(env, orgSA);
  if (!grant?.delegator || !grant.signature || grant.signature === '0x') return null;
  return createServerVaultTransport({ baseUrl: base, delegation: grant as DelegationWire });
}
