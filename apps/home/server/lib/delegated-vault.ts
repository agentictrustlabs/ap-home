// Server-side delegated vault seam (spec 317 W1). Adapts a delegation-authorized MCP vault to the
// `@agenticprimitives/vault` `Vault` interface, so `fabric`'s `createVaultMessageBodyStore` can store
// and read message bodies in an agent's OWN vault (residency, spec 316 §11a) instead of the cleartext
// KV `bodies` map this replaces.
//
// Why a server-side transport port (not `src/lib/vault-client.ts`): that client is BROWSER-only —
// same-origin fetch with cookies + CSRF. Inbox delivery/send/read run SERVER-side (`server/connect/
// inbox.ts` → `src/home/inbox-data.ts`). The concrete transport POSTs to the Agentic Edge → demo-a2a
// → demo-mcp with a signed `DelegationWire` (spec 277); it is INJECTED here so this adapter stays
// unit-testable without the live edge (the edge gateway-assertion requirement, spec 288, lives in the
// concrete transport, not this leaf).
//
// One transport instance is bound to exactly ONE vault owner via the delegation whose delegator IS the
// owner. A read/write for any other owner is a fail-closed error — no cross-owner vault access, one
// mechanism (ADR-0013). Authority is the signed, scoped, revocable delegation the transport carries
// (recipient's inbox-delivery grant inbound, sender's self-scoped grant outbound — spec 317 §3), never
// app trust: Web3 is the authority (ADR-0041).
import type {
  Vault,
  VaultObject,
  VaultReadRequest,
  VaultWriteRequest,
  VaultRef,
} from '@agenticprimitives/vault';

/**
 * Server-side, delegation-authorized vault transport for ONE owner. `recordType` is the MCP vault's
 * record key (== the fabric `VaultRef.resource`). Payload-only: `get` returns the stored `data` (or
 * `null` if absent/tombstoned), matching `vaultReadWithDelegation`; `set` upserts (`data: null`
 * tombstones), matching `vaultWriteWithDelegation`.
 *
 * NOTE (fidelity gap, resolved in a later wave): the MCP `set` verb takes `{recordType, data}` with no
 * `classification` param, so a write's `VaultClassification` is not persisted through this transport.
 * The fabric message-body store does not read classification back (it lives in the envelope + the
 * stored record's own fields), so body round-trips are unaffected; a general vault needing
 * classification round-trips must carry it inside `data`.
 */
export interface ServerVaultTransport {
  /** The vault owner this transport is authorized for (== the delegation's delegator). */
  readonly owner: string;
  get(recordType: string): Promise<unknown | null>;
  set(recordType: string, data: unknown): Promise<void>;
  list(): Promise<VaultRef[]>;
}

/**
 * Adapt a delegation-bound {@link ServerVaultTransport} to the `Vault` interface. `resource` maps 1:1
 * to the MCP `recordType`. The transport is bound to ONE owner, so a request for any other owner
 * throws (fail-closed — no silent cross-owner access, ADR-0013).
 */
export function createDelegatedVault(transport: ServerVaultTransport): Vault {
  const assertOwner = (owner: string): void => {
    if (owner.toLowerCase() !== transport.owner.toLowerCase()) {
      throw new Error(`delegated vault is bound to ${transport.owner}, not ${owner}`);
    }
  };
  return {
    async read<T = unknown>(req: VaultReadRequest): Promise<VaultObject<T> | null> {
      assertOwner(req.owner);
      const data = (await transport.get(req.resource)) as T | null;
      if (data === null) return null;
      return {
        owner: transport.owner.toLowerCase(),
        resource: req.resource,
        // Payload-only transport: classification is not returned by MCP `get`. The message-body store
        // never reads it back (it verifies bytes against the envelope `bodyHash`), so `internal` is a
        // safe non-widening default here; it is NOT trusted as an access decision (ADR-0041).
        classification: 'internal',
        data,
        updatedAt: new Date().toISOString(),
      };
    },
    async write<T = unknown>(req: VaultWriteRequest<T>): Promise<void> {
      assertOwner(req.owner);
      await transport.set(req.resource, req.data);
    },
    async list(owner: string): Promise<VaultRef[]> {
      assertOwner(owner);
      return transport.list();
    },
  };
}
