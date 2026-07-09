// Gated message-body store construction (spec 317 §5.1 — the vault cutover).
//
// Returns a fabric `MessageBodyStore` over an owner's MCP vault WHEN the owner's standing delivery grant is
// provisioned, else `undefined` — which is FAIL-CLOSED, not a KV path: `persistBody` throws and `resolveBodies`
// yields nothing until the grant exists (spec 316 §11a cutover — the vault is the ONLY body residency; there is
// no KV `doc.bodies`). ONE mechanism (ADR-0013), never a runtime fallback. The store is uniform per owner
// (read+write grant) — `bodyStoreFor(owner)` serves deliver/send (write) AND read from the owner's own grant.
//
// Transport + edge posture (spec 288): the server posts `{delegation, requester, recordType, data}` to
// `/mcp/vault/*` (server-mint — demo-a2a's `DEMO_ALLOW_SERVER_MINT=true`, ALREADY set in wrangler.toml, mints
// the `sub=owner` token; demo-mcp ERC-1271-verifies the grant + record-scope-gates it). In the default prod
// posture `/mcp/*` is EDGE-GATED (`DEMO_REQUIRE_GATEWAY_ASSERTION=true`) and the **Agentic Edge is the assertion
// SIGNER** — so the correct path is to route THROUGH the edge (`DEMO_EDGE_URL`, exactly as the browser's
// `/a2a/mcp/*` does), letting the edge sign the assertion. `baseUrl` therefore prefers `DEMO_EDGE_URL`, falling
// back to a direct demo-a2a origin (`A2A_VAULT_URL`/`A2A_CUSTODY_URL`) only for an EDGE-LESS deploy
// (`EDGE_REQUIRED=false`). RESOLVED (§5.1 posture question): the edge DOES admit the Home's server-side
// (session-less) call — `demo-edge`'s `runAdmission` is route+size+rate ONLY, NOT session-gated (spec 288
// §4 / ADR-0043: admission is not authority), and `/mcp/vault/*` matches its `a2a.data` route → A2A binding
// → demo-a2a server-mint. No first-party edge-admit rule is required; no proof-of-possession, no Origin
// rejection (Origin only shapes CORS response headers, which this server-side caller ignores). The edge
// signs the GatewayAssertion; demo-a2a verifies it + mints the `sub=owner` token.
import type { MessageBodyStore } from '@agenticprimitives/fabric/messaging';
import { createOwnerMessageBodyStore } from '../lib/vault-transport';
import { loadInboxDeliveryGrant } from './inbox-delivery-grant';
import type { DelegationWire } from '../../src/lib/delegation';

interface BodyStoreEnv {
  AUTH_CODES: { get(k: string): Promise<string | null> };
  /** The Agentic Edge origin (assertion signer) — PREFERRED base; the server routes `/mcp/vault/*` through it. */
  DEMO_EDGE_URL?: string;
  /** Direct demo-a2a origin serving `/mcp/vault/*` — used only for an EDGE-LESS deploy. */
  A2A_VAULT_URL?: string;
  A2A_CUSTODY_URL?: string;
  /** The provisioned delivery-service SA — its presence is the vault-path ENABLE flag (spec 317 §3.4). */
  DELIVERY_SERVICE_SA?: string;
}

const nonEmpty = (s?: string): boolean => !!(s && s.trim());

/** The transport base: the edge (assertion signer) when set, else a direct a2a origin (edge-less deploy). */
function vaultBaseUrl(env: BodyStoreEnv): string | undefined {
  return [env.DEMO_EDGE_URL, env.A2A_VAULT_URL, env.A2A_CUSTODY_URL].find(nonEmpty);
}

/** Vault bodies are enabled only when the delivery-service SA is provisioned AND a transport base is resolvable. */
export function vaultBodiesEnabled(env: BodyStoreEnv): boolean {
  return nonEmpty(env.DELIVERY_SERVICE_SA) && !!vaultBaseUrl(env);
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
    if (!grant?.delegator || !grant.signature || grant.signature === '0x') return undefined; // no grant ⇒ fail-closed (no bodies until provisioned; NOT KV)
    // Routing through the edge means the edge signs the GatewayAssertion — no header minted here (the Home is
    // not the signer; there is no buildGatewayAssertion). For an edge-less base the a2a call is direct.
    return createOwnerMessageBodyStore({
      baseUrl: vaultBaseUrl(env)!,
      delegation: grant as DelegationWire,
    });
  };
}
