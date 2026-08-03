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


/**
 * spec 341 Wave 2a — the in-isolate read cache the cursor makes possible.
 *
 * Keyed by owner, holding the last revision and the exact JSON it corresponded to. When the DO answers
 * `unchanged`, the cached JSON is returned and the caller skips `hydrateInboxStores` entirely — an
 * O(events) replay it otherwise performs on every poll, several times a minute.
 *
 * Isolate-scoped ON PURPOSE, and safe because the revision is a content digest: a cache hit means the
 * bytes are identical, so a stale entry cannot be served as fresh. A cold isolate simply misses and
 * does the full read — the correctness does not depend on the cache surviving.
 *
 * Bounded, because an isolate serving many owners would otherwise grow without limit. Eviction is
 * oldest-first and the loss is a cache miss, never a wrong answer.
 */
const REV_CACHE_MAX = 32;
const revCache = new Map<string, { revision: string; json: string }>();

function cacheGet(owner: string): { revision: string; json: string } | undefined {
  return revCache.get(owner);
}

function cacheSet(owner: string, revision: string, json: string): void {
  if (revCache.has(owner)) revCache.delete(owner);
  revCache.set(owner, { revision, json });
  while (revCache.size > REV_CACHE_MAX) {
    const oldest = revCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    revCache.delete(oldest);
  }
}

/** A write invalidates this owner's entry. The next read re-fetches and re-caches; keeping a stale
 *  revision here would send `sinceRev` for a document we no longer hold, and the DO would answer
 *  `unchanged` while our cached JSON was behind. Correctness, not optimization. */
function cacheDrop(owner: string): void {
  revCache.delete(owner);
}

/** The personal/org inbox document (`inbox-data:<owner>`) → the owner's vault record `inbox.data`,
 *  read + written ONLY via the owner's InteractionsDO. All other keys pass through to the real KV. */
export async function makeInboxKv(env: InboxStoreEnv, owner: string): Promise<InboxKV> {
  const real = env.AUTH_CODES;
  const ownerKey = owner.toLowerCase();
  const docKey = `inbox-data:${ownerKey}`;

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
      // Present the cursor we hold; the DO answers `unchanged` when the document still digests to it.
      const cached = cacheGet(ownerKey);
      const r = await bridgeInteractions<{ doc?: unknown; unchanged?: boolean; revision?: string }>(
        env,
        owner,
        'inbox.get',
        cached ? { sinceRev: cached.revision } : {},
      ).catch(() => null);
      if (!r?.ok) return null;
      if (r.body.unchanged === true) {
        if (cached) return cached.json;
        // `unchanged` with nothing cached is a contradiction — we only ever send `sinceRev` when we
        // hold the document it names. Falling through here would return null, and null renders as
        // "your inbox is empty": a silent WRONG answer, not a degraded one. So re-read without the
        // cursor rather than guess. One retry, and it cannot loop: the second call sends no cursor,
        // so the DO has nothing to match and must return the document (ADR-0013 — one mechanism, and
        // an impossible state is refused rather than interpreted).
        const full = await bridgeInteractions<{ doc?: unknown; revision?: string }>(env, owner, 'inbox.get', {}).catch(() => null);
        if (!full?.ok || full.body.doc == null) return null;
        const fullJson = JSON.stringify(full.body.doc);
        if (typeof full.body.revision === 'string') cacheSet(ownerKey, full.body.revision, fullJson);
        return fullJson;
      }
      if (r.body.doc == null) return null;
      const json = JSON.stringify(r.body.doc);
      if (typeof r.body.revision === 'string') cacheSet(ownerKey, r.body.revision, json);
      return json;
    },
    async put(key, value, opts) {
      if (key !== docKey) return real.put(key, value, opts);
      cacheDrop(ownerKey);
      const r = await bridgeInteractions(env, owner, 'inbox.put', { doc: JSON.parse(value) });
      if (!r.ok) throw new Error(r.body.error ?? `inbox write via InteractionsDO failed (${r.status})`);
    },
  };
}
