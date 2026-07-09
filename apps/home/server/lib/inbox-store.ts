// Vault-resident inbox store (spec 316 §11a cutover — the inbox is the vault, not the Home's KV).
//
// The `InboxDataV1` document (`inbox-data:<owner>`) now lives in the OWNER'S MCP vault as the record
// `inbox.data`, alongside the message bodies that moved there in spec 317. `makeInboxKv(env, owner)` returns a
// `KV`-shaped adapter so the whole inbox surface (`readInboxView` / `sendFromInbox` / `applyMessageAction` /
// case transitions / …) is UNCHANGED — only the `inbox-data:` key is routed to the vault; every other key
// (the `inbox-audit:` log, name caches) passes through to the real KV.
//
// Authority: the owner's standing inbox-delivery grant (delegator = owner, scoped `vault:inbox.data` +
// `vault:message.body:*`, read+write) — the SAME grant the a2a `messaging.deliver` skill uses to append on
// delivery. Web3 is the authority (ADR-0041); demo-mcp record-scope-gates every read/write.
//
// Fail-closed (ADR-0013), no legacy KV inbox: an owner with no provisioned grant / no transport base has an
// EMPTY inbox (reads resolve null ⇒ `loadInboxData` returns the empty doc) and CANNOT be written (send/receive
// throw a clear "provision your vault" error) — never a silent KV fallback. Provisioning the grant is the one
// path to a live inbox (value-steps doctrine).
import { createServerVaultTransport } from './vault-transport';
import { loadInboxDeliveryGrant } from '../connect/inbox-delivery-grant';
import type { DelegationWire } from '../../src/lib/delegation';

/** The KV surface the inbox-data functions consume (raw strings). */
export interface InboxKV {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
}

interface InboxStoreEnv {
  AUTH_CODES: InboxKV;
  DEMO_EDGE_URL?: string;
  A2A_VAULT_URL?: string;
  A2A_CUSTODY_URL?: string;
  DELIVERY_SERVICE_SA?: string;
}

/** The vault record type that holds the owner's inbox document (matches `INBOX_DATA_RESOURCE_SCOPE`
 *  `vault:inbox.data` — demo-mcp prefixes `vault:` on the recordType). */
const INBOX_DATA_RECORD = 'inbox.data';
const nonEmpty = (s?: string): boolean => !!(s && s.trim());
const dataKeyFor = (owner: string): string => `inbox-data:${owner.toLowerCase()}`;
const vaultBaseUrl = (env: InboxStoreEnv): string | undefined =>
  [env.DEMO_EDGE_URL, env.A2A_VAULT_URL, env.A2A_CUSTODY_URL].find(nonEmpty);

/**
 * Build the inbox KV for one owner. The `inbox-data:<owner>` key reads/writes the `inbox.data` vault record
 * over the owner's delivery grant; all other keys pass through to `env.AUTH_CODES`. When the owner has no
 * provisioned grant (or no transport base), the inbox reads EMPTY and writes fail closed — the vault is the
 * only inbox residency (no KV fallback).
 */
export async function makeInboxKv(env: InboxStoreEnv, owner: string): Promise<InboxKV> {
  const real = env.AUTH_CODES;
  const dataKey = dataKeyFor(owner);
  const base = vaultBaseUrl(env);
  const grant = nonEmpty(env.DELIVERY_SERVICE_SA) && base ? await loadInboxDeliveryGrant(env, owner) : null;

  if (!base || !grant?.delegator || !grant.signature || grant.signature === '0x') {
    // Un-provisioned owner: empty, fail-closed inbox (never the old KV doc).
    return {
      async get(key) {
        return key === dataKey ? null : real.get(key);
      },
      async put(key, value, opts) {
        if (key === dataKey) {
          throw new Error('inbox vault not provisioned for this owner — enable vault storage to send/receive');
        }
        return real.put(key, value, opts);
      },
    };
  }

  const transport = createServerVaultTransport({ baseUrl: base, delegation: grant as DelegationWire });
  return {
    async get(key) {
      if (key !== dataKey) return real.get(key);
      const data = await transport.get(INBOX_DATA_RECORD);
      return data == null ? null : JSON.stringify(data);
    },
    async put(key, value, opts) {
      if (key !== dataKey) return real.put(key, value, opts);
      await transport.set(INBOX_DATA_RECORD, JSON.parse(value));
    },
  };
}
