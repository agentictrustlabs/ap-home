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

const redis = new Redis({ url, token, automaticDeserialization: false });

export const kv: KVNamespace = {
  async get(key: string): Promise<string | null> {
    const v = await redis.get<string>(key);
    return v ?? null;
  },
  async put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void> {
    if (opts?.expirationTtl) await redis.set(key, value, { ex: opts.expirationTtl });
    else await redis.set(key, value);
  },
  async delete(key: string): Promise<void> {
    await redis.del(key);
  },
  // Cloudflare KV's `list({prefix})` has no Upstash equivalent as one call, so back it with SCAN + MATCH.
  // SCAN is cursor-paged and a batch may be partial or empty (COUNT is a hint), which is exactly the
  // Cloudflare contract the callers already loop against. Cursor "0" starts; a returned "0" means complete.
  async list(opts?: { prefix?: string; cursor?: string; limit?: number }): Promise<{ keys: { name: string }[]; list_complete: boolean; cursor?: string }> {
    const match = opts?.prefix ? `${opts.prefix}*` : '*';
    const [next, keys] = (await redis.scan(opts?.cursor ?? '0', { match, count: opts?.limit ?? 100 })) as [string, string[]];
    const complete = String(next) === '0';
    return { keys: (keys ?? []).map((name) => ({ name })), list_complete: complete, ...(complete ? {} : { cursor: String(next) }) };
  },
};
