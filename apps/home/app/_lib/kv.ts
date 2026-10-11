// Vercel KV (Upstash Redis) adapter implementing the broker's `KVNamespace`
// surface (spec 232 §4). The Cloudflare KV the broker was written against stores
// + returns RAW STRINGS (the broker does its own JSON.stringify/parse). Upstash's
// default auto-(de)serialization would corrupt that, so we construct the client
// with `automaticDeserialization: false` to match Cloudflare KV byte-for-byte.
//
// Vercel KV provisions `KV_REST_API_URL` + `KV_REST_API_TOKEN`.
import { Redis } from '@upstash/redis';
import type { KVNamespace } from '../../server/_lib/server-broker';

// Accept both the legacy "Vercel KV" names (KV_REST_API_*) and the current
// Upstash Marketplace integration names (UPSTASH_REDIS_REST_*).
const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL ?? '';
const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN ?? '';

/**
 * KV_KEY_PREFIX — the one thing that keeps two Homes out of each other's index when they share a store.
 *
 * What lives here is the login-facet index: `facet:cred:siwe-eoa:<address>` → the agent that credential
 * opens. Two estates are two different populations of agents (a KMS-custodied home is a CREATE2 address
 * over a derived custodian, and the roots differ), so the SAME credential names a DIFFERENT agent on each
 * one. Sharing a store unprefixed would hand a person signing into one estate an agent belonging to the
 * other — the index PROPOSES and the chain CONFIRMS, so it would not forge authority, but it would open
 * the wrong Home and is a disclosure besides.
 *
 * Unset ⇒ no prefix and keys are byte-for-byte what they always were, so an existing Home is untouched.
 * A second Home on the same store sets its own (`imbnet:`). The prefix is storage partitioning and NEVER
 * authority: nothing is permitted because of which prefix a key was read under.
 */
const PREFIX = process.env.KV_KEY_PREFIX ?? '';
const k = (key: string): string => `${PREFIX}${key}`;

const redis = new Redis({ url, token, automaticDeserialization: false });

export const kv: KVNamespace = {
  async get(key: string): Promise<string | null> {
    const v = await redis.get<string>(k(key));
    return v ?? null;
  },
  async put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void> {
    if (opts?.expirationTtl) await redis.set(k(key), value, { ex: opts.expirationTtl });
    else await redis.set(k(key), value);
  },
  async delete(key: string): Promise<void> {
    await redis.del(k(key));
  },
  // Cloudflare KV's `list({prefix})` has no Upstash equivalent as one call, so back it with SCAN + MATCH.
  // SCAN is cursor-paged and a batch may be partial or empty (COUNT is a hint), which is exactly the
  // Cloudflare contract the callers already loop against. Cursor "0" starts; a returned "0" means complete.
  async list(opts?: { prefix?: string; cursor?: string; limit?: number }): Promise<{ keys: { name: string }[]; list_complete: boolean; cursor?: string }> {
    // MATCH is prefixed too, and every name is handed back WITHOUT it — a caller gets the keys it wrote,
    // never the storage spelling. Without this a listing would walk the other Home's keys.
    const match = `${PREFIX}${opts?.prefix ?? ''}*`;
    const [next, keys] = (await redis.scan(opts?.cursor ?? '0', { match, count: opts?.limit ?? 100 })) as [string, string[]];
    const complete = String(next) === '0';
    const names = (keys ?? []).filter((n) => n.startsWith(PREFIX)).map((name) => ({ name: name.slice(PREFIX.length) }));
    return { keys: names, list_complete: complete, ...(complete ? {} : { cursor: String(next) }) };
  },
};
