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
  VaultQueryRequest,
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
  /** Spec 356 §2.3 — a SELECTOR evaluated at the vault. Optional: a transport whose MCP surface has no
   *  query verb cannot do this, and says so rather than pretending (see the adapter's `query`). */
  query?(select: VaultQueryRequest['select'], opts: { fields?: string[]; limit?: number }): Promise<Array<{ resource: string; data: unknown; updatedAt: string }>>;
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
    /**
     * Spec 356 §2.3 — the selector runs AT the vault, so this needs a transport that can carry one.
     *
     * When it cannot, this REFUSES rather than emulating the query with `list()` + N × `read()`. That
     * emulation is the exact shape the spec forbids: it would pull an owner's whole record set through
     * this process to answer a question about three of them, and it would work well enough in a test to
     * survive review. A missing verb is a missing verb (ADR-0013).
     */
    async query<T = unknown>(req: VaultQueryRequest): Promise<VaultObject<T>[]> {
      assertOwner(req.owner);
      if (!transport.query) {
        throw new Error('this vault transport cannot run a query — its MCP surface has no query verb (spec 356 §2.3)');
      }
      const rows = await transport.query(req.select, {
        ...(req.fields ? { fields: req.fields } : {}),
        ...(typeof req.limit === 'number' ? { limit: req.limit } : {}),
      });
      return rows.map((r) => ({
        owner: transport.owner.toLowerCase(),
        resource: r.resource,
        classification: 'internal' as const,
        data: r.data as T,
        updatedAt: r.updatedAt,
      }));
    },
  };
}
