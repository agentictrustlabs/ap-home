// Reverse-resolve an agent address → its primary name, via /connect/reverse-name
// (a single on-chain reverseResolveString read server-side). Cached + de-duped per
// address so a page full of AddressChips makes at most one request each.
import type { Address } from '@agenticprimitives/types';

const cache = new Map<string, string | null>();
const inflight = new Map<string, Promise<string | null>>();

export async function reverseAgentName(address: Address): Promise<string | null> {
  const key = address.toLowerCase();
  if (cache.has(key)) return cache.get(key) ?? null;
  const existing = inflight.get(key);
  if (existing) return existing;
  const p = (async () => {
    try {
      const r = await fetch(`/connect/reverse-name?address=${key}`);
      const b = (await r.json().catch(() => ({}))) as { name?: string | null };
      const name = b.name ?? null;
      cache.set(key, name);
      return name;
    } catch {
      cache.set(key, null);
      return null;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}
