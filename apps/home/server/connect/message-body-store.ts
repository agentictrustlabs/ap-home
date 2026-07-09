// Gated message-body store construction (spec 317 §5.1 — the vault cutover).
//
// Returns a fabric `MessageBodyStore` over an owner's MCP vault WHEN the vault-backed body path is configured,
// else `undefined` ⇒ `inbox-data` uses the KV `doc.bodies` (unchanged, deploy-safe). ONE mechanism per call
// (ADR-0013): config decides, never a runtime fallback. The store is uniform per owner (read+write grant, the
// §5.1 testnet posture) — `bodyStoreFor(owner)` serves deliver/send (write) AND read from the owner's own
// standing inbox-delivery grant.
//
// Transport: the server posts `{delegation, requester, recordType, data}` to demo-a2a `/mcp/vault/*`
// (server-mint — demo-a2a's `DEMO_ALLOW_SERVER_MINT=true` mints the `sub=owner` token; demo-mcp ERC-1271-
// verifies the grant + record-scope-gates it). `A2A_VAULT_URL` is the demo-a2a origin serving `/mcp/vault/*`;
// prod `/mcp/*` is edge-gated (spec 288), so `EDGE_GATEWAY_ASSERTION` (if set) rides as the assertion header.
import type { MessageBodyStore } from '@agenticprimitives/fabric/messaging';
import { createOwnerMessageBodyStore } from '../lib/vault-transport';
import { loadInboxDeliveryGrant } from './inbox-delivery-grant';
import type { DelegationWire } from '../../src/lib/delegation';

interface BodyStoreEnv {
  AUTH_CODES: { get(k: string): Promise<string | null> };
  /** demo-a2a origin serving `/mcp/vault/*` (server-to-server). Falls back to `A2A_CUSTODY_URL`. */
  A2A_VAULT_URL?: string;
  A2A_CUSTODY_URL?: string;
  /** The provisioned delivery-service SA — its presence is the vault-path ENABLE flag (spec 317 §3.4). */
  DELIVERY_SERVICE_SA?: string;
  /** Optional spec-288 edge gateway-assertion header for a server-side `/mcp/*` call (posture TBD, §5.1). */
  EDGE_GATEWAY_ASSERTION?: string;
}

const nonEmpty = (s?: string): boolean => !!(s && s.trim());

/** Vault bodies are enabled only when the delivery-service SA is provisioned AND an a2a vault URL is set. */
export function vaultBodiesEnabled(env: BodyStoreEnv): boolean {
  return nonEmpty(env.DELIVERY_SERVICE_SA) && (nonEmpty(env.A2A_VAULT_URL) || nonEmpty(env.A2A_CUSTODY_URL));
}

/**
 * A body-store FACTORY: `bodyStoreFor(owner)` → the owner's vault body store, or `undefined`. Uniform for
 * deliver/send/read (the owner's own read+write inbox-delivery grant authorizes all three). `undefined` when
 * the path is disabled OR the owner has no stored grant ⇒ that owner falls back to KV for this call (config /
 * per-owner provisioning, NOT a runtime error-fallback). Thread into `readInboxView`/`sendFromInbox`/
 * `replyInConversation`/`deliverToInbox`.
 */
export function makeBodyStoreFactory(env: BodyStoreEnv): (owner: string) => Promise<MessageBodyStore | undefined> {
  return async (owner: string) => {
    if (!vaultBodiesEnabled(env)) return undefined;
    const grant = await loadInboxDeliveryGrant(env, owner);
    if (!grant?.delegator || !grant.signature || grant.signature === '0x') return undefined; // no standing grant ⇒ KV
    const headers = nonEmpty(env.EDGE_GATEWAY_ASSERTION) ? { 'x-gateway-assertion': env.EDGE_GATEWAY_ASSERTION! } : undefined;
    return createOwnerMessageBodyStore({
      baseUrl: (env.A2A_VAULT_URL ?? env.A2A_CUSTODY_URL)!,
      delegation: grant as DelegationWire,
      headers,
    });
  };
}
