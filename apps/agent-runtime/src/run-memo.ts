// A MINUTE'S MEMORY OF WHAT AN AGENT IS — for the reads a run makes before it can think.
//
// Every ask reads the addressee's playbook from its vault, its type and its advertised capabilities from
// the chain, and its catalog binding from its name records — four to five seconds before a model is
// asked anything, on a question that arrives on a card table's clock (measured: playbook 1.9–3.0 s,
// catalog 0.9 s, type 0.5 s, capabilities 0.15 s ×2). None of them changes between two hands. A playbook
// is content-addressed and re-assigned once in a while; a name record moves when somebody edits it.
//
// So each is remembered PER ISOLATE for a short while. Sixty seconds is the whole design: long enough to
// cover a session of questions, short enough that a re-assigned playbook or a moved record is what the
// next minute's asks see. Nothing here is authority — a stale playbook answers with last minute's
// doctrine, never with a permission it no longer holds, because the gates read the chain themselves.
//
// In-isolate only, on purpose. A shared cache would be a second source of truth with its own
// invalidation to get wrong; an isolate forgets on its own.

const TTL_MS = 60_000;
const local = new Map<string, { at: number; value: unknown }>();

/**
 * THE COLO'S CACHE, NOT THE ISOLATE'S. The edge spreads one person's asks across isolates, so an
 * in-isolate map was cold on the second ask as often as the first (measured). The Workers Cache API is
 * shared by every isolate in a colo and expires on its own; the map in front of it saves the
 * round-trip within one isolate. Both hold JSON — a playbook, a binding, a list of ids — never a key.
 */
const shared = (): Cache | null => { try { return (globalThis as { caches?: { default?: Cache } }).caches?.default ?? null; } catch { return null; } };
const urlOf = (key: string) => `https://run-memo.internal/${encodeURIComponent(key)}`;

/** Run `fn` once per `key` per minute; a failure is not remembered. */
export async function remembered<T>(key: string, fn: () => Promise<T>, ttlMs = TTL_MS): Promise<T> {
  const now = Date.now();
  const hit = local.get(key);
  if (hit && now - hit.at < ttlMs) return hit.value as T;
  const cache = shared();
  if (cache) {
    try {
      const res = await cache.match(urlOf(key));
      if (res) {
        const value = (await res.json()) as T;
        local.set(key, { at: now, value });
        return value;
      }
    } catch { /* a cache miss by any other name */ }
  }
  const value = await fn();
  local.set(key, { at: now, value });
  if (cache && value !== undefined) {
    try {
      await cache.put(urlOf(key), new Response(JSON.stringify(value ?? null), { headers: { 'content-type': 'application/json', 'cache-control': `max-age=${Math.floor(ttlMs / 1000)}` } }));
    } catch { /* remembering is best-effort; the answer is not */ }
  }
  if (local.size > 500) for (const [k, v] of local) if (now - v.at >= ttlMs) local.delete(k);
  return value;
}

/** Forget one agent's memory — after a write this Worker itself made to what it remembers. */
export async function forget(key: string): Promise<void> {
  local.delete(key);
  const cache = shared();
  if (cache) { try { await cache.delete(urlOf(key)); } catch { /* nothing to forget */ } }
}

