// The Library index stored in pages (src/catalog-pages.ts): the split, the exact round trip, copy-on-write generations
// (a write touches only the pages that changed, under new names; the root names them), the page-local edit, and a
// strict root — anything that exists and does not parse is an error, never "not paged".
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { compactCatalog, expandCatalog, CATALOG_COMPACT_FORMAT } from '../src/catalog-codec.js';
import {
  CATALOG_PAGED_FORMAT, CATALOG_PAGE_COUNT, CATALOG_ROOT_RECORD, CatalogIntegrityError, activeCatalogRoot, applyCatalogEdit, assembleCatalog,
  buildPagedCatalog, catalogDigest, compareCatalog, fnv1a32, isPagedCatalogRecord, isVersionedPageRecord, newGeneration, pageOf, pageRecordOf,
  pageRows, pagesDigest, parseCatalogRoot, planPagedWrite, readCatalog, readCatalogPages, rootState, splitCatalog, type CatalogRoot, type PagedWrite,
} from '../src/catalog-pages.js';

const SKELETON = '0x51' + 'ab'.repeat(500);
const sigFor = (i: number): string => SKELETON + (i * 31 + 1).toString(16).padStart(8, '0') + 'cd'.repeat(300);
const doc = (i: number, extra: Record<string, unknown> = {}) => ({
  id: `doc-${i}`, kind: 'md', name: `n${i}.md`, folder: `shelf/${i % 7}`, contentType: 'text/markdown', size: 100 + i, version: 1, createdAt: 1_000 + i,
  contentCommitment: `0x${i.toString(16).padStart(64, '0')}`, grants: [],
  ...(i % 3 === 0 ? { releases: [{ canonicalId: `0xc${i}`, version: '1.0.0', bundleRoot: `0xb${i}`, owner: '0xo', publisher: '0xo', riskTier: 'low', releaseId: `0xr${i}`, signature: sigFor(i), signed: true, publishedAt: 5 }] } : {}),
  ...extra,
});
const folder = (path: string) => ({ id: `f-${path.replace(/\//g, '-')}`, kind: 'md', name: path.split('/').pop()!, folder: path.split('/').slice(0, -1).join('/'), isFolder: true, contentType: 'inode/directory' });
/** Folders interleaved with documents, plus a row that is not a document — the order a real index has. */
function catalog(n: number): unknown[] {
  const out: unknown[] = [];
  for (let i = 0; i < n; i++) {
    if (i % 50 === 0) out.push(folder(`shelf/${i / 50}`));
    out.push(doc(i));
  }
  out.splice(3, 0, { stray: true });
  return out;
}

/** An in-memory store that applies a plan the way the vault does: pages first (never over anything), then the root. */
const store = () => {
  const records = new Map<string, unknown>();
  const reads: string[] = [];
  const apply = (plan: PagedWrite) => {
    for (const w of plan.pages) { if (records.has(w.recordType)) throw new Error('page generation exists'); records.set(w.recordType, structuredClone(w.data)); }
    records.set(CATALOG_ROOT_RECORD, structuredClone(plan.root));
    for (const g of plan.garbage) records.delete(g);
  };
  const root = () => records.get(CATALOG_ROOT_RECORD) as CatalogRoot;
  const read = async () => readCatalog({
    root: async () => (records.has(CATALOG_ROOT_RECORD) ? { data: structuredClone(records.get(CATALOG_ROOT_RECORD)), rev: 0, deleted: false } : null),
    legacy: async () => structuredClone(records.get('content.catalog') ?? null),
    records: async (rts) => rts.map((rt) => { reads.push(rt); return structuredClone(records.get(rt) ?? null); }),
  });
  const load = async (k: number) => pageRows(root(), k, records.get(pageRecordOf(root(), k) ?? '') ?? null);
  return { records, reads, apply, root, read, load };
};
const gen = (n = 1) => newGeneration(n);

describe('page assignment', () => {
  it('is fnv1a32(id) mod 32, stable and spread', () => {
    expect(fnv1a32('')).toBe(0x811c9dc5);
    expect(pageOf('doc-1')).toBe(fnv1a32('doc-1') % 32);
    const counts = new Array(CATALOG_PAGE_COUNT).fill(0);
    for (let i = 0; i < 6400; i++) counts[pageOf(`art-${i.toString(36)}`)]++;
    expect(Math.min(...counts)).toBeGreaterThan(120);
    expect(Math.max(...counts)).toBeLessThan(280);
  });

  it('documents go to pages; folders and non-document rows stay in the root bucket', () => {
    const s = splitCatalog(catalog(120));
    expect(s.folders).toHaveLength(4);
    expect(s.pages.flat()).toHaveLength(120);
    for (const [k, rows] of s.pages.entries()) for (const r of rows) expect(pageOf((r as { id: string }).id)).toBe(k);
  });

  it('names its records — versioned pages, and the reserved unversioned names — and nothing else', () => {
    expect(isPagedCatalogRecord('content.catalog.root')).toBe(true);
    expect(isPagedCatalogRecord('content.catalog.p0.gabc123')).toBe(true);
    expect(isPagedCatalogRecord('content.catalog.p31')).toBe(true);
    expect(isVersionedPageRecord('content.catalog.p31')).toBe(false);
    expect(isPagedCatalogRecord('content.catalog')).toBe(false);
    expect(isPagedCatalogRecord('content.catalog.pages')).toBe(false);
    expect(isPagedCatalogRecord('content.artifact.p1')).toBe(false);
    expect(newGeneration(5)).not.toBe(newGeneration(5));
  });
});

describe('the round trip is exact', () => {
  it('assemble(split(x)) is x — order and key order included', () => {
    const list = catalog(500);
    const s = splitCatalog(list);
    expect(JSON.stringify(assembleCatalog({ order: s.order, folders: s.folders, pageCount: 32 }, s.pages))).toBe(JSON.stringify(list));
  });

  it('through the stored form: each page compact-coded under its generation, read back through the codec', async () => {
    const list = catalog(300);
    const s = store();
    const built = await buildPagedCatalog(list, { gen: gen(), active: true, now: 1 });
    s.apply(built);
    expect(built.pages.some((w) => (w.data as { $format?: string }).$format === CATALOG_COMPACT_FORMAT)).toBe(true);
    expect(JSON.stringify(await s.read())).toBe(JSON.stringify(list));
    expect(await pagesDigest(built.root, built.root.pages.map((p) => built.pages.find((w) => w.k === p.k)?.rows ?? []))).toBe(await catalogDigest(list));
  });

  it('an empty list and a list of folders only round-trip too (no page record at all)', async () => {
    for (const list of [[], [folder('a'), folder('a/b')]]) {
      const s = store();
      const built = await buildPagedCatalog(list, { gen: gen(), active: true, now: 1 });
      expect(built.pages).toHaveLength(0);
      s.apply(built);
      expect(await s.read()).toEqual(list);
    }
  });
});

describe('the switch is the root — strict', () => {
  it('no root → the legacy record, expanded, exactly as before', async () => {
    const s = store();
    s.records.set('content.catalog', compactCatalog(catalog(40)));
    expect(await s.read()).toEqual(catalog(40));
    expect(s.reads).toEqual([]);
  });

  it('an INACTIVE root (prepared, not switched) → still the legacy record, and no page is read', async () => {
    const s = store();
    s.records.set('content.catalog', catalog(40));
    s.apply(await buildPagedCatalog([doc(999)], { gen: gen(), active: false, now: 1 }));
    expect(await s.read()).toEqual(catalog(40));
    expect(s.reads).toEqual([]);
  });

  it('a root that exists but does not parse, or was deleted, is an ERROR — never a quiet return to legacy', () => {
    expect(rootState(null)).toEqual({ kind: 'legacy' });
    expect(() => rootState({ data: { format: CATALOG_PAGED_FORMAT, active: true }, rev: 0, deleted: false })).toThrow(CatalogIntegrityError);
    expect(() => rootState({ data: null, rev: 3, deleted: true })).toThrow(/deleted/);
    expect(() => activeCatalogRoot({ format: 'ap.catalog.paged.v1', active: true, pageCount: 32, pages: [], order: '', folders: [] })).toThrow(CatalogIntegrityError);
    expect(activeCatalogRoot(null)).toBeNull();
  });

  it('a root whose order disagrees with its counts does not parse', async () => {
    const { root } = await buildPagedCatalog(catalog(60), { gen: gen(), active: true, now: 1 });
    expect(() => parseCatalogRoot(root)).not.toThrow();
    expect(() => parseCatalogRoot({ ...root, order: root.order.slice(1) })).toThrow(/order|total/);
    expect(() => parseCatalogRoot({ ...root, pages: root.pages.map((p, i) => (i === 0 ? { ...p, count: p.count + 1 } : p)) })).toThrow(CatalogIntegrityError);
    expect(() => parseCatalogRoot({ ...root, total: root.total + 1 })).toThrow(CatalogIntegrityError);
  });

  it('a page the root names but that is missing, or whose count differs, is an ERROR', async () => {
    const s = store();
    const built = await buildPagedCatalog(catalog(100), { gen: gen(), active: true, now: 1 });
    s.apply(built);
    const k = built.root.pages.find((p) => p.gen)!.k;
    const name = pageRecordOf(built.root, k)!;
    const rows = expandCatalog(s.records.get(name)) as unknown[];
    s.records.set(name, rows.slice(1));
    await expect(s.read()).rejects.toThrow(/holds \d+ rows, the root says/);
    s.records.delete(name);
    await expect(s.read()).rejects.toThrow(/is missing/);
  });
});

describe('copy-on-write: a write puts changed pages under new names and swaps the root', () => {
  it('one entry changed → one new page generation; the old one is kept as prevGen, the one before is collected', async () => {
    const s = store();
    const list = catalog(400);
    s.apply(await buildPagedCatalog(list, { gen: gen(1), active: true, now: 1 }));
    const k = pageOf('doc-77');
    const g1 = s.root().pages[k]!.gen;
    const bump = (l: unknown[], v: number) => l.map((e) => ((e as { id?: string }).id === 'doc-77' ? { ...(e as object), version: v } : e));
    const p2 = await planPagedWrite(bump(list, 2), s.root(), { gen: gen(2), now: 2 });
    expect(p2.pages.map((w) => w.k)).toEqual([k]);
    expect(p2.garbage).toEqual([]);
    s.apply(p2);
    expect(s.root().pages[k]).toMatchObject({ prevGen: g1 });
    expect(s.records.has(`content.catalog.p${k}.g${g1}`)).toBe(true); // kept until the next successful write
    const p3 = await planPagedWrite(bump(list, 3), s.root(), { gen: gen(3), now: 3 });
    expect(p3.garbage).toEqual([`content.catalog.p${k}.g${g1}`]);
    s.apply(p3);
    expect(await s.read()).toEqual(bump(list, 3));
  });

  it('a removal and a move of a folder: only the removed row’s page changes; the move is the root’s order', async () => {
    const s = store();
    const list = catalog(200);
    s.apply(await buildPagedCatalog(list, { gen: gen(1), active: true, now: 1 }));
    const rest = list.filter((e) => (e as { id?: string }).id !== 'doc-5');
    const next = [...rest.slice(1), rest[0]];
    const plan = await planPagedWrite(next, s.root(), { gen: gen(2), now: 2 });
    expect(plan.pages.map((w) => w.k)).toEqual([pageOf('doc-5')]);
    s.apply(plan);
    expect(await s.read()).toEqual(next);
  });

  it('no change → no page is written', async () => {
    const built = await buildPagedCatalog(catalog(100), { gen: gen(1), active: true, now: 1 });
    expect((await planPagedWrite(structuredClone(catalog(100)), built.root, { gen: gen(2), now: 2 })).pages).toHaveLength(0);
  });

  it('a write interrupted at ANY point before the root swap leaves the catalog exactly as it was', async () => {
    const list = catalog(300);
    const next = [...list.map((e) => ((e as { id?: string }).id === 'doc-10' ? { ...(e as object), isFolder: true } : e)), folder('new'), doc(9000)];
    const s0 = store();
    s0.apply(await buildPagedCatalog(list, { gen: gen(1), active: true, now: 1 }));
    const plan = await planPagedWrite(next, s0.root(), { gen: gen(2), now: 2 });
    for (let stop = 0; stop <= plan.pages.length; stop++) {
      const s = store();
      for (const [k, v] of s0.records) s.records.set(k, structuredClone(v));
      for (const w of plan.pages.slice(0, stop)) s.records.set(w.recordType, w.data); // then the writer dies
      expect(await s.read()).toEqual(list);
    }
    s0.apply(plan);
    expect(await s0.read()).toEqual(next);
  });
});

describe('a page-local edit', () => {
  const setup = async (n = 300) => {
    const s = store();
    const list = catalog(n);
    s.apply(await buildPagedCatalog(list, { gen: gen(1), active: true, now: 1 }));
    const loads: number[] = [];
    const load = async (k: number) => { loads.push(k); return s.load(k); };
    return { s, list, load, loads };
  };

  it('replaces the first row with that id in place, loading only its page', async () => {
    const w = await setup();
    const plan = await applyCatalogEdit(w.s.root(), w.load, [doc(42, { version: 9 })], { gen: gen(2), now: 2 });
    expect(w.loads).toEqual([pageOf('doc-42')]);
    expect(plan.pages.map((x) => x.k)).toEqual([pageOf('doc-42')]);
    w.s.apply(plan);
    expect(await w.s.read()).toEqual(w.list.map((e) => ((e as { id?: string }).id === 'doc-42' ? doc(42, { version: 9 }) : e)));
  });

  it('appends a new row at the end, as the whole-list save did', async () => {
    const w = await setup();
    w.s.apply(await applyCatalogEdit(w.s.root(), w.load, [doc(5000)], { gen: gen(2), now: 2 }));
    expect(await w.s.read()).toEqual([...w.list, doc(5000)]);
    expect(w.s.root().total).toBe(w.list.length + 1);
  });

  it('a new folder lands in the root bucket and writes no page', async () => {
    const w = await setup();
    const plan = await applyCatalogEdit(w.s.root(), w.load, [folder('new/one')], { gen: gen(2), now: 2 });
    expect(plan.pages).toHaveLength(0);
    w.s.apply(plan);
    expect(await w.s.read()).toEqual([...w.list, folder('new/one')]);
  });

  it('a document re-saved as a folder, and back, keeps its position — and an interrupted move changes nothing', async () => {
    for (const dir of ['to-folder', 'to-doc'] as const) {
      const w = await setup();
      const start = dir === 'to-folder' ? w.list : w.list.map((e) => ((e as { id?: string }).id === 'doc-10' ? { ...doc(10), isFolder: true } : e));
      if (dir === 'to-doc') w.s.apply(await buildPagedCatalog(start, { gen: gen(3), active: true, now: 3, previous: w.s.root() }));
      const moved = dir === 'to-folder' ? { ...doc(10), isFolder: true } : doc(10);
      const plan = await applyCatalogEdit(w.s.root(), w.load, [moved], { gen: gen(4), now: 4 });
      // interrupted after the page write, before the root: nothing visible changed, nothing lost or doubled
      for (const pw of plan.pages) w.s.records.set(pw.recordType, pw.data);
      expect(await w.s.read()).toEqual(start);
      w.s.records.set(CATALOG_ROOT_RECORD, plan.root);
      const want = start.map((e) => ((e as { id?: string }).id === 'doc-10' ? moved : e));
      expect(await w.s.read()).toEqual(want);
    }
  });
});

describe('comparing the pages to a list', () => {
  it('passes on an exact copy and names what differs otherwise', async () => {
    const list = catalog(120);
    const built = await buildPagedCatalog(list, { gen: gen(), active: false, now: 1 });
    const load = async (k: number) => built.pages.find((w) => w.k === k)?.rows ?? [];
    expect((await compareCatalog(list, built.root, load)).ok).toBe(true);
    const changed = structuredClone(list) as Array<Record<string, unknown>>;
    const i = changed.findIndex((e) => e.id === 'doc-8');
    changed[i] = { ...changed[i], name: 'renamed.md' };
    const bad = await compareCatalog(changed, built.root, load);
    expect(bad.mismatches).toEqual([expect.objectContaining({ id: 'doc-8', reason: 'value differs' })]);
    expect((await compareCatalog([...list].reverse(), built.root, load)).orderExact).toBe(false);
    const { name: _n, ...rest } = changed[i] as Record<string, unknown>;
    changed[i] = { ...rest, name: (list[i] as { name: string }).name };
    expect((await compareCatalog(changed, built.root, load)).mismatches).toEqual([expect.objectContaining({ id: 'doc-8', reason: 'key order differs' })]);
  });
});

it('the digest of a list changes with any row, the order, or a folder — and only then', async () => {
  const list = catalog(200);
  const d = await catalogDigest(list);
  expect(await catalogDigest(structuredClone(list))).toBe(d);
  const changed = structuredClone(list) as Array<Record<string, unknown>>;
  changed[10] = { ...changed[10], size: 1 };
  expect(await catalogDigest(changed)).not.toBe(d);
  expect(await catalogDigest([list[1], list[0], ...list.slice(2)])).not.toBe(d);
  expect(await catalogDigest(list.filter((e) => !(e as { isFolder?: boolean }).isFolder))).not.toBe(d);
});

it('readCatalogPages reads only named pages, in batches', async () => {
  const built = await buildPagedCatalog([doc(1), doc(2)], { gen: gen(), active: true, now: 1 });
  const asked: string[][] = [];
  await readCatalogPages(built.root, async (rts) => { asked.push(rts); return rts.map((rt) => built.pages.find((w) => w.recordType === rt)!.data); });
  expect(asked.flat()).toHaveLength(built.pages.length);
});

it('the vault service carries the identical file', () => {
  const here = readFileSync(new URL('../src/catalog-pages.ts', import.meta.url), 'utf8');
  const there = readFileSync(new URL('../../vault/src/catalog-pages.ts', import.meta.url), 'utf8');
  expect(there).toBe(here);
});
