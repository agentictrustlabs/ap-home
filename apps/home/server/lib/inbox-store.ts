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
import { interactionsBridgeConfigured, type InteractionsBridgeEnv } from './interactions-bridge';
import { callInteractions } from '../connect/channels';

/** The KV surface the inbox functions consume (raw strings). */
export interface InboxKV {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
}

/** An inbox.doc read that failed for a reason the caller must not render as "empty". */
export class InboxReadError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'InboxReadError';
  }
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
/**
 * spec 341 §1 — `session` converts the authority on this read/write from a SHARED SECRET to the
 * person's own broker session.
 *
 * The bridge proved *the caller is our Home*; the session proves *the caller is the owner*, which is
 * the fact the operation actually turns on. `ownerOrBridge` accepts either (caller-selected, ADR-0013)
 * and now also accepts a relying id_token (§4.2), so any Home holding the owner's session drives these
 * with no secret at all — which is what spec 323 W4's portable Home asked for.
 *
 * `stewardship` covers the ORG case: an org has no session, so a steward fails `sa === principal` by
 * definition. Presenting the org's stewardship delegation is how they prove the right — the SAME proof
 * `applications.*` and `content.*` take. Before it existed the org path had no option but the shared
 * secret, not because a secret was the right authority but because nothing else could express "this
 * person may act for this org".
 *
 * Neither omitted ⇒ the bridge, unchanged.
 */
export async function makeInboxKv(env: InboxStoreEnv, owner: string, session?: string, stewardship?: unknown): Promise<InboxKV> {
  const real = env.AUTH_CODES;
  /**
   * The one place this module chooses its authority — and there is now only ONE to choose.
   *
   * The bridge branch is GONE (spec 341 §1). Both callers pass a session: the person's own for their
   * inbox, the same session plus the org's stewardship delegation for an org's. So the shared-secret
   * path was unreachable, and an unreachable fallback is not a safety net — it is a second mechanism
   * waiting for someone to route to it (ADR-0013).
   *
   * Fail-closed: no session ⇒ no read. That is the correct answer, because without one there is
   * nothing to check except possession of a secret, which is what this removes.
   */
  const doOp = async <T>(op: 'inbox.get' | 'inbox.put', payload: Record<string, unknown>): Promise<{ ok: boolean; status: number; body: T & { error?: string; code?: string } }> => {
    if (!session) throw new InboxReadError('home session required', 401);
    const r = await callInteractions(env as never, owner, op, { ...payload, session, ...(stewardship ? { stewardship } : {}) });
    return { ok: r.status < 400 && r.body.ok !== false, status: r.status, body: r.body as T & { error?: string; code?: string } };
  };

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
      // A not-yet-written doc is empty. A refused read is not — it throws. The two used to be
      // collapsed, and every relying app without a read grant rendered an empty mailbox over mail
      // that was sitting in the vault.
      // Present the cursor we hold; the DO answers `unchanged` when the document still digests to it.
      const cached = cacheGet(ownerKey);
      const r = await doOp<{ doc?: unknown; unchanged?: boolean; revision?: string }>('inbox.get', cached ? { sinceRev: cached.revision } : {});
      // A refusal is a ceremony, not an empty mailbox. Swallowing `read_grant_absent` (or a
      // missing interactions grant) as `null` made every relying app render "Nothing here yet"
      // over mail that was sitting in the vault.
      if (!r.ok) {
        throw new InboxReadError(r.body.error ?? 'inbox read refused', r.status, r.body.code);
      }
      if (r.body.unchanged === true) {
        if (cached) return cached.json;
        // `unchanged` with nothing cached is a contradiction — we only ever send `sinceRev` when we
        // hold the document it names. Falling through here would return null, and null renders as
        // "your inbox is empty": a silent WRONG answer, not a degraded one. So re-read without the
        // cursor rather than guess. One retry, and it cannot loop: the second call sends no cursor,
        // so the DO has nothing to match and must return the document (ADR-0013 — one mechanism, and
        // an impossible state is refused rather than interpreted).
        const full = await doOp<{ doc?: unknown; revision?: string }>('inbox.get', {});
        if (!full.ok) throw new InboxReadError(full.body.error ?? 'inbox read refused', full.status, full.body.code);
        if (full.body.doc == null) return null;
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
      const r = await doOp('inbox.put', { doc: JSON.parse(value) });
      // `null` is a transport failure, `ok:false` an authorization one. Both must THROW: a swallowed
      // write reads as a successful save and loses the person's mail silently (ADR-0013).
      if (!r.ok) throw new InboxReadError(r.body.error ?? 'inbox write via InteractionsDO failed', r.status, r.body.code);
    },
  };
}
