// Vault-resident inbox + channel store (spec 316 §11a cutover — the inbox/board is the vault, not the Home's KV).
//
// The `InboxDataV1` document (`inbox-data:<owner>`) and the community channel board (`channels:<orgSA>`) now
// live in the OWNER'S MCP vault as records `inbox.data` / `channels.data`, alongside the message bodies that
// moved there in spec 317. `makeInboxKv` / `makeChannelsKv` return `KV`-shaped adapters so the whole surface
// (`readInboxView` / `sendFromInbox` / `readChannels` / channel post / …) is UNCHANGED — only the one doc key
// is routed to the vault; every other key (the `inbox-audit:` log, directory, name caches) passes through to
// the real KV.
//
// Authority: the owner's standing inbox-delivery grant (delegator = owner, scoped `vault:inbox.data` +
// `vault:channels.data` + `vault:message.body:*`, read+write) — the SAME grant the a2a `messaging.deliver`
// skill and the channel body store use. Web3 is the authority (ADR-0041); demo-mcp record-scope-gates every op.
//
// Fail-closed (ADR-0013), no legacy KV doc: an owner with no provisioned grant / no transport base reads the
// doc EMPTY and CANNOT write it (send/receive/post throw a clear "provision your vault" error) — never a silent
// KV fallback. Provisioning the grant (person: "enable vault storage"; org: a steward enables it) is the one
// path to a live inbox/board (value-steps doctrine).
import { createServerVaultTransport } from './vault-transport';
import { loadInboxDeliveryGrant } from '../connect/inbox-delivery-grant';
import type { DelegationWire } from '../../src/lib/delegation';

/** The KV surface the inbox/channel functions consume (raw strings). */
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

const nonEmpty = (s?: string): boolean => !!(s && s.trim());
const vaultBaseUrl = (env: InboxStoreEnv): string | undefined =>
  [env.DEMO_EDGE_URL, env.A2A_VAULT_URL, env.A2A_CUSTODY_URL].find(nonEmpty);

/**
 * Build a `KV` for one owner where a SINGLE `docKey` reads/writes one `recordType` vault record over the
 * owner's delivery grant; all other keys pass through to `env.AUTH_CODES`. Un-provisioned owner ⇒ the doc
 * reads EMPTY and writes fail closed — the vault is the only doc residency (no KV fallback).
 */
async function makeVaultDocKv(env: InboxStoreEnv, owner: string, docKey: string, recordType: string): Promise<InboxKV> {
  const real = env.AUTH_CODES;
  const base = vaultBaseUrl(env);
  const grant = nonEmpty(env.DELIVERY_SERVICE_SA) && base ? await loadInboxDeliveryGrant(env, owner) : null;

  if (!base || !grant?.delegator || !grant.signature || grant.signature === '0x') {
    return {
      async get(key) {
        return key === docKey ? null : real.get(key);
      },
      async put(key, value, opts) {
        if (key === docKey) {
          throw new Error(`vault not provisioned for ${owner} — enable vault storage before send/receive/post`);
        }
        return real.put(key, value, opts);
      },
    };
  }

  const transport = createServerVaultTransport({ baseUrl: base, delegation: grant as DelegationWire });
  return {
    async get(key) {
      if (key !== docKey) return real.get(key);
      // Empty is an answer (ADR-0013): a stale grant that doesn't yet cover this record (record_scope_denied)
      // or a not-yet-written doc resolves to an EMPTY inbox/board — never a KV fallback. The WRITE path below
      // still fails closed, and the "stored" freshness check drives re-provisioning, so this only makes READS
      // graceful (no 500) while the owner re-signs the widened grant.
      try {
        const data = await transport.get(recordType);
        return data == null ? null : JSON.stringify(data);
      } catch {
        return null;
      }
    },
    async put(key, value, opts) {
      if (key !== docKey) return real.put(key, value, opts);
      await transport.set(recordType, JSON.parse(value));
    },
  };
}

/** The personal inbox document (`inbox-data:<owner>`) → the owner's vault record `inbox.data`. */
export function makeInboxKv(env: InboxStoreEnv, owner: string): Promise<InboxKV> {
  return makeVaultDocKv(env, owner, `inbox-data:${owner.toLowerCase()}`, 'inbox.data');
}

/** The community channel board (`channels:<orgSA>`) → the ORG's vault record `channels.data`. Same grant,
 *  same fail-closed rules; the org SA is the owner (a steward enables its vault storage). */
export function makeChannelsKv(env: InboxStoreEnv, orgSA: string): Promise<InboxKV> {
  return makeVaultDocKv(env, orgSA, `channels:${orgSA.toLowerCase()}`, 'channels.data');
}
