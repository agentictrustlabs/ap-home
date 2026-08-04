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
import { sha256Hex32, type MessageBodyStore, type MessageEnvelopeV1 } from '@agenticprimitives/fabric/messaging';

/** What the Home still needs of a body store: the READ half. The write half was deleted with the two
 *  paths that wrote into someone's inbox (spec 341 §5.2), and narrowing the TYPE is what stops one
 *  quietly coming back — a `MessageBodyStore` would compile the moment somebody re-added `putBody`. */
export type MessageBodyReader = Pick<MessageBodyStore, 'loadBody'>;
import { bridgeInteractions, interactionsBridgeConfigured, type InteractionsBridgeEnv } from '../lib/interactions-bridge';

// spec 323 W3 — the body store is FULLY DO-mediated (bridge get/put); the Home no longer needs a
// vault transport base or the delivery wire, so `BodyStoreEnv` is just the bridge env.
type BodyStoreEnv = InteractionsBridgeEnv;

/**
 * A body-store FACTORY: `bodyStoreFor(owner)` → the owner's vault body store, or `undefined`. Uniform for
 * deliver/send/read (the owner's own read+write inbox-delivery grant authorizes all three). `undefined` when
 * the path is disabled OR the owner has no stored grant ⇒ that owner falls back to KV for this call (config /
 * per-owner provisioning, NOT a runtime error-fallback). Thread into `readInboxView`/`sendFromInbox`/
 * `replyInConversation`/`deliverToInbox`.
 */
export function makeBodyStoreFactory(env: BodyStoreEnv): (owner: string) => Promise<MessageBodyReader | undefined> {
  return async (owner: string) => {
    // spec 323 W3 — the owner's 1-1 body store is FULLY DO-mediated: the Home holds NO delivery wire.
    // READ-ONLY since spec 341 §5.2. It rides `inbox.body.get` (interactions grant, dm-namespace) and
    // hash-verifies against the envelope. Fail-closed (ADR-0013): no bridge ⇒ no body store, never a
    // KV path.
    if (!interactionsBridgeConfigured(env)) return undefined;
    const toB64 = (bytes: Uint8Array): string => { let bin = ''; for (const b of bytes) bin += String.fromCharCode(b); return btoa(bin); };
    return {
      // `putBody` is GONE (spec 341 §5.2). It rode `dm.body.put` over the shared-secret bridge, and its
      // only callers were the two Home paths that wrote into someone's inbox — both deleted. Bodies are
      // now written by the RECIPIENT's own DO, under the recipient's own wire, after the recipient's
      // gate. One bridge call site fewer; the ratchet moves for the first time.
      async loadBody(envelope: MessageEnvelopeV1): Promise<Uint8Array> {
        const r = await bridgeInteractions<{ record?: { b64?: string } | null }>(env, owner, 'inbox.body.get', { resource: envelope.body.resource });
        if (!r.ok || !r.body.record?.b64) throw new Error(r.body.error ?? `message body ${envelope.body.resource} not readable via InteractionsDO`);
        const bin = atob(r.body.record.b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        if ((await sha256Hex32(bytes)) !== envelope.bodyHash) throw new Error(`message body ${envelope.id} does not match envelope bodyHash`);
        return bytes;
      },
    } satisfies MessageBodyReader;
  };
}
