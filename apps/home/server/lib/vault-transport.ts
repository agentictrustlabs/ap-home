// Concrete server-side vault transport (spec 317 W1 impl / W3 delivery keystone).
//
// Implements `ServerVaultTransport` by POSTing to demo-a2a's `/mcp/vault/{get,set,list}` server-to-server
// with a signed `DelegationWire` (delegator = the vault owner) — demo-a2a ERC-1271-verifies it, opens a
// session, mints a `sub = owner` token, and demo-mcp keys the record by that owner + enforces the record
// scope (spec 317 §3.2). This is the piece that lets inbox delivery/send/read vault-back bodies through MCP
// instead of the cleartext KV `bodies` map.
//
// INJECTABLE by design: `fetchImpl` + `headers` are supplied by the caller so this leaf is testable without a
// live edge, and the two deployment-coupled concerns live at the call site, not here:
//   • `baseUrl` — the demo-a2a origin serving `/mcp/vault/*` (server-to-server; NOT the browser `/a2a/*` proxy).
//   • `headers` — the Agentic Edge gateway assertion (`/mcp/*` is edge-required in prod, spec 288); when the
//     Home routes through the edge it passes the assertion here, else it calls demo-a2a directly.
// Client-mint (a `token`, the spec-317 F4 secure path) is a later addition; today the server-mint delegation
// form is used (gated by demo-a2a's `DEMO_ALLOW_SERVER_MINT`, an accepted testnet posture — spec 317 §3.3 F4).
import type { VaultClassification, VaultRef } from '@agenticprimitives/vault';
import { createVaultMessageBodyStore, type MessageBodyStore } from '@agenticprimitives/fabric/messaging';
import { createDelegatedVault, type ServerVaultTransport } from './delegated-vault';
import type { DelegationWire } from '../../src/lib/delegation';

export interface ServerVaultTransportOpts {
  /** Absolute demo-a2a base URL serving `/mcp/vault/*` (e.g. `env.A2A_CUSTODY_URL` host, or the edge origin). */
  baseUrl: string;
  /** The OWNER's signed authorization (`delegator` = owner); the transport acts AS `delegation.delegate`. */
  delegation: DelegationWire;
  /** Injected fetch (defaults to the global) — for tests + runtime portability. */
  fetchImpl?: typeof fetch;
  /** Extra request headers, e.g. the Agentic Edge gateway assertion for `/mcp/*` (spec 288). */
  headers?: Record<string, string>;
}

/**
 * A {@link ServerVaultTransport} bound to ONE owner via `opts.delegation` (delegator = owner). Payload-only:
 * `get` returns the stored record data (or `null`); `set` upserts (`data: null` tombstones); `list`
 * enumerates the owner's record types. Fail-closed: a non-`ok` MCP response throws.
 */
export function createServerVaultTransport(opts: ServerVaultTransportOpts): ServerVaultTransport {
  const doFetch = opts.fetchImpl ?? fetch;
  const base = opts.baseUrl.replace(/\/$/, '');
  const post = async (path: 'get' | 'set' | 'list', extra: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const res = await doFetch(`${base}/mcp/vault/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
      body: JSON.stringify({ delegation: opts.delegation, requester: opts.delegation.delegate, ...extra }),
    });
    const j = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok || !j || j.ok !== true) {
      throw new Error((j?.detail as string) ?? (j?.error as string) ?? `vault ${path} failed (HTTP ${res.status})`);
    }
    return j;
  };
  return {
    owner: opts.delegation.delegator,
    async get(recordType) {
      const j = await post('get', { recordType });
      return j.data ?? null;
    },
    async set(recordType, data) {
      await post('set', { recordType, data });
    },
    async list(): Promise<VaultRef[]> {
      const j = await post('list', {});
      const records = (j.records ?? []) as Array<{ record_type: string; updated_at: string }>;
      // demo-mcp list returns recordType without the `vault:` prefix (VAULT_RECORD_PREFIX stripped); the
      // delegated-vault adapter maps resource↔recordType 1:1, so resource == record_type here.
      return records.map((r) => ({
        resource: r.record_type,
        classification: 'internal' as VaultClassification,
        updatedAt: r.updated_at,
      }));
    },
  };
}

/**
 * Compose the full server-side stack — a2a vault transport → delegated `Vault` → fabric message-body store —
 * bound to ONE owner + authorized by ONE `DelegationWire`. This is the seam inbox **delivery** (the recipient's
 * inbox-delivery grant, W3) and **send** (the sender's self-delegation, W4) call to store a body in the owner's
 * MCP vault (`message.body:<id>`, record-scope enforced) and to read it back **hash-verified** against the
 * envelope `bodyHash` (fail-closed on miss/mismatch — ADR-0013). Replaces the cleartext KV `bodies` map.
 */
export function createOwnerMessageBodyStore(opts: ServerVaultTransportOpts): MessageBodyStore {
  const transport = createServerVaultTransport(opts);
  return createVaultMessageBodyStore(createDelegatedVault(transport), transport.owner);
}
