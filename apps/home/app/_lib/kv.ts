// Vercel KV (Upstash Redis) adapter implementing the broker's `KVNamespace`
// surface (spec 232 §4). The Cloudflare KV the broker was written against stores
// + returns RAW STRINGS (the broker does its own JSON.stringify/parse). Upstash's
// default auto-(de)serialization would corrupt that, so we construct the client
// with `automaticDeserialization: false` to match Cloudflare KV byte-for-byte.
//
// Vercel KV provisions `KV_REST_API_URL` + `KV_REST_API_TOKEN`.
import { Redis } from '@upstash/redis';
import type { KVNamespace } from '../../server/_lib/server-broker';

const redis = new Redis({
  url: process.env.KV_REST_API_URL ?? '',
  token: process.env.KV_REST_API_TOKEN ?? '',
  automaticDeserialization: false,
});

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
};
