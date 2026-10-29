// THE LIBRARY INDEX, STORED COMPACT (2026-10-28).
//
// `content.catalog` is one vault record listing every document in a Library. Each published document carries its signed
// release, and the release's `signature` is a ~2.5 KB hex string: a JSON envelope `{"wire":{delegator, delegate, authority,
// caveats[…enforcer addresses, terms…], …, "signature":"0x…"},"sig":"0x…"}` — the SAME skeleton every time, with only a
// timestamp, a salt and two 65-byte signatures differing. On the Demo Admin publisher that was 1,565 signatures = 82 % of
// a 5.2 MB record; every Library save read the whole record and wrote it back, and at ~4.5 MB the Durable Object that
// sends it ran out of memory ("isolate exceeded its memory limit"), whatever the size of the document being saved.
// Publishing stopped.
//
// The fix stores each signature as a DELTA against one base signature of its length: `~2:<len>:<start>.<chars>;…` — the
// positions that differ and what they hold — beside a `sigBases` table. Measured on the real record: 5.2 MB → 1.9 MB,
// and the transform is exactly reversible (`expandCatalog(compactCatalog(x))` is `x`, key order included). The record's
// meaning is unchanged: EVERY reader still gets the plain array — the vault service (apps/vault) and the interactions DO
// both call `expandCatalog` on a read, so the Home, the skills app and any older client never see the compact shape. A
// real signature starts `0x`, so `~2:` can never collide with one, and `expandCatalog` passes anything that is not a
// compact record through untouched, which is what makes a rollback of either side safe.
//
// THIS FILE EXISTS TWICE (apps/agent-runtime/src and apps/vault/src), byte for byte — a test holds them equal. It has
// no imports so it can live in both.

export const CATALOG_COMPACT_FORMAT = 'ap.catalog.compact.v2';
const REF = '~2:';
/** Only a plain hex signature is delta-coded: the edit syntax uses `.` and `;`, which hex never holds. */
const HEX_SIG = /^0x[0-9a-fA-F]+$/;
/** Differing positions closer than this are one edit. */
const GAP = 8;
/** A signature shorter than this is not worth a base. */
const MIN_SIG = 200;

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

const releasesOf = (e: unknown): Json[] => (isObj(e) && Array.isArray(e.releases) ? (e.releases as unknown[]).filter(isObj) : []);

/** The edits that turn `base` into `s` (same length): [start, chars] runs of differing positions. */
function editsOf(s: string, base: string): Array<[number, string]> {
  const out: Array<[number, string]> = [];
  let i = 0;
  while (i < s.length) {
    if (s.charCodeAt(i) === base.charCodeAt(i)) { i++; continue; }
    const start = i;
    let last = i;
    i++;
    while (i < s.length && i - last <= GAP) { if (s.charCodeAt(i) !== base.charCodeAt(i)) last = i; i++; }
    out.push([start, s.slice(start, last + 1)]);
    i = last + 1;
  }
  return out;
}

const applyEdits = (base: string, edits: string): string => {
  if (!edits) return base;
  let out = base;
  for (const run of edits.split(';')) {
    const dot = run.indexOf('.');
    const start = Number(run.slice(0, dot));
    const chars = run.slice(dot + 1);
    out = out.slice(0, start) + chars + out.slice(start + chars.length);
  }
  return out;
};

/** Compact a catalog for storage. Returns the array unchanged when there is nothing worth sharing. */
export function compactCatalog(list: unknown): unknown {
  if (!Array.isArray(list)) return list;
  const bases: Record<string, string> = {};
  let sigs = 0;
  for (const e of list) for (const r of releasesOf(e)) {
    const s = r.signature;
    if (typeof s !== 'string' || s.length < MIN_SIG || !HEX_SIG.test(s)) continue;
    sigs++;
    if (!(String(s.length) in bases)) bases[String(s.length)] = s;
  }
  if (sigs < 2) return list;
  const entries = list.map((e) => {
    const rels = releasesOf(e);
    if (!rels.length || !rels.some((r) => typeof r.signature === 'string' && String(r.signature.length) in bases && HEX_SIG.test(r.signature))) return e;
    return { ...(e as Json), releases: (e as { releases: unknown[] }).releases.map((r) => {
      if (!isObj(r) || typeof r.signature !== 'string' || r.signature.length < MIN_SIG || !HEX_SIG.test(r.signature)) return r;
      const base = bases[String(r.signature.length)]!;
      return { ...r, signature: `${REF}${r.signature.length}:${editsOf(r.signature, base).map(([a, c]) => `${a}.${c}`).join(';')}` };
    }) };
  });
  return { $format: CATALOG_COMPACT_FORMAT, sigBases: bases, entries };
}

/** The plain array, whatever shape was stored. Idempotent; anything that is not a compact record is returned as it came. */
export function expandCatalog<T = unknown>(data: T): T {
  if (!isObj(data) || (data as Json).$format !== CATALOG_COMPACT_FORMAT) return data;
  const bases = (data as Json).sigBases;
  const entries = (data as Json).entries;
  if (!isObj(bases) || !Array.isArray(entries)) return data;
  return entries.map((e) => {
    if (!isObj(e) || !Array.isArray(e.releases)) return e;
    return { ...e, releases: e.releases.map((r) => {
      if (!isObj(r) || typeof r.signature !== 'string' || !r.signature.startsWith(REF)) return r;
      const body = r.signature.slice(REF.length);
      const colon = body.indexOf(':');
      const base = (bases as Record<string, unknown>)[body.slice(0, colon)];
      if (typeof base !== 'string') return r;
      return { ...r, signature: applyEdits(base, body.slice(colon + 1)) };
    }) };
  }) as unknown as T;
}

/** The record type this codec is for. */
export const CATALOG_RECORD = 'content.catalog';
