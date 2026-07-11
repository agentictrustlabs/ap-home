// Vault-resident inbox store (spec 316 §11a residency; spec 322 W3f authority cutover).
//
// The `InboxDataV1` document lives in the OWNER'S MCP vault as record `inbox.data` — but the Home
// no longer touches it with the delivery grant (which is WRITE-ONLY since W3f). Every doc read and
// write goes through the owner's per-principal InteractionsDO on demo-a2a (`inbox.get`/`inbox.put`
// over the SEC-010 bridge HMAC): ONE serialized writer, reads under the owner's interactions grant.
// `makeInboxKv` keeps the `KV` shape so the whole surface (`readInboxView` / `sendFromInbox` /
// `deliverToInbox` / …) is unchanged — only the one doc key routes to the DO; every other key (the
// `inbox-audit:` log, name caches) passes through to the real KV.
//
// Fail-closed (ADR-0013), no legacy residency: an owner whose interactions plane isn't enabled (DO
// 409) or an unconfigured bridge reads the doc EMPTY and CANNOT write it — never a silent fallback.
// Enabling interactions (person: sign-in/join ceremony; org: a steward enables it) is the one path
// to a live inbox.
import { bridgeInteractions, interactionsBridgeConfigured, type InteractionsBridgeEnv } from './interactions-bridge';

/** The KV surface the inbox functions consume (raw strings). */
export interface InboxKV {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
}

interface InboxStoreEnv extends InteractionsBridgeEnv {
  AUTH_CODES: InboxKV;
}

/** The personal/org inbox document (`inbox-data:<owner>`) → the owner's vault record `inbox.data`,
 *  read + written ONLY via the owner's InteractionsDO. All other keys pass through to the real KV. */
export async function makeInboxKv(env: InboxStoreEnv, owner: string): Promise<InboxKV> {
  const real = env.AUTH_CODES;
  const docKey = `inbox-data:${owner.toLowerCase()}`;

  if (!interactionsBridgeConfigured(env)) {
    return {
      async get(key) {
        return key === docKey ? null : real.get(key);
      },
      async put(key, value, opts) {
        if (key === docKey) throw new Error(`interactions bridge not configured — cannot reach ${owner}'s inbox`);
        return real.put(key, value, opts);
      },
    };
  }

  return {
    async get(key) {
      if (key !== docKey) return real.get(key);
      // Empty is an answer (ADR-0013): an owner who hasn't enabled interactions (DO 409) or a
      // not-yet-written doc reads as an EMPTY inbox — never a second mechanism. The WRITE path
      // below still fails closed with the DO's actual error.
      const r = await bridgeInteractions<{ doc?: unknown }>(env, owner, 'inbox.get', {}).catch(() => null);
      if (!r?.ok || r.body.doc == null) return null;
      return JSON.stringify(r.body.doc);
    },
    async put(key, value, opts) {
      if (key !== docKey) return real.put(key, value, opts);
      const r = await bridgeInteractions(env, owner, 'inbox.put', { doc: JSON.parse(value) });
      if (!r.ok) throw new Error(r.body.error ?? `inbox write via InteractionsDO failed (${r.status})`);
    },
  };
}
