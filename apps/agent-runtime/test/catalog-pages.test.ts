// The Library index stored in pages (src/catalog-pages.ts): the split, the exact round trip, the write that touches only
// the pages that changed, the page-local edit, and the read that never mistakes a missing page for an empty one.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { compactCatalog, expandCatalog, CATALOG_COMPACT_FORMAT } from '../src/catalog-codec.js';
import {
  CATALOG_PAGED_FORMAT, CATALOG_PAGE_COUNT, CATALOG_ROOT_RECORD, activeCatalogRoot, applyCatalogEdit, asCatalogRoot, assembleCatalog,
  buildPagedCatalog, catalogDigest, catalogPageRecord, compareCatalog, fnv1a32, isPagedCatalogRecord, pageOf, pageRows, planPagedWrite, readCatalog,
  splitCatalog, type CatalogRoot,
} from '../src/catalog-pages.js';

const SKELETON = '0x51' + 'ab'.repeat(500);
const sigFor = (i: number): string => SKELETON + (i * 31 + 1).toString(16).padStart(8, '0') + 'cd'.repeat(300);
export const doc = (i: number, extra: Record<string, unknown> = {}) => ({
  id: `doc-${i}`, kind: 'md', name: `n${i}.md`, folder: `shelf/${i % 7}`, contentType: 'text/markdown', size: 100 + i, version: 1, createdAt: 1_000 + i,
  contentCommitment: `0x${i.toString(16).padStart(64, '0')}`, grants: [],
  ...(i % 3 === 0 ? { releases: [{ canonicalId: `0xc${i}`, version: '1.0.0', bundleRoot: `0xb${i}`, owner: '0xo', publisher: '0xo', riskTier: 'low', releaseId: `0xr${i}`, signature: sigFor(i), signed: true, publishedAt: 5 }] } : {}),
  ...extra,
});
const folder = (path: string) => ({ id: `f-${path.replace(/\//g, '-')}`, kind: 'md', name: path.split('/').pop()!, folder: path.split('/').slice(0, -1).join('/'), isFolder: true, contentType: 'inode/directory' });
/** Folders interleaved with documents, plus a row that is not a document — the order a real index has. */
export function catalog(n: number): unknown[] {
  const out: unknown[] = [];
  for (let i = 0; i < n; i++) {
    if (i % 50 === 0) out.push(folder(`shelf/${i / 50}`));
    out.push(doc(i));
  }
  out.splice(3, 0, { stray: true });
  return out;
}

const store = () => {
  const records = new Map<string, unknown>();
  const reads: string[] = [];
  const readMany = async (rts: string[]) => rts.map((rt) => { reads.push(rt); return structuredClone(records.get(rt) ?? null); });
  return { records, reads, readMany };
};
const putPlan = (records: Map<string, unknown>, plan: { writes: Array<{ recordType: string; data: unknown }>; root: CatalogRoot }) => {
  for (const w of plan.writes) records.set(w.recordType, structuredClone(w.data));
  records.set(CATALOG_ROOT_RECORD, structuredClone(plan.root));
};

describe('page assignment', () => {
  it('is fnv1a32(id) mod 32, stable and spread', () => {
    expect(fnv1a32('')).toBe(0x811c9dc5);
    expect(pageOf('doc-1')).toBe(fnv1a32('doc-1') % 32);
    const counts = new Array(CATALOG_PAGE_COUNT).fill(0);
    for (let i = 0; i < 6400; i++) counts[pageOf(`art-${i.toString(36)}`)]++;
    expect(Math.min(...counts)).toBeGreaterThan(120); // ~200 each
    expect(Math.max(...counts)).toBeLessThan(280);
  });

  it('documents go to pages; folders and non-document rows stay in the root bucket', () => {
    const s = splitCatalog(catalog(120));
    expect(s.folders.every((f) => (f as { isFolder?: boolean }).isFolder === true || (f as { stray?: boolean }).stray === true)).toBe(true);
    expect(s.folders).toHaveLength(4);
    expect(s.pages.flat()).toHaveLength(120);
    for (const [k, rows] of s.pages.entries()) for (const r of rows) expect(pageOf((r as { id: string }).id)).toBe(k);
  });

  it('names its records and nothing else', () => {
    expect(isPagedCatalogRecord('content.catalog.root')).toBe(true);
    expect(isPagedCatalogRecord('content.catalog.p0')).toBe(true);
    expect(isPagedCatalogRecord('content.catalog.p31')).toBe(true);
    expect(isPagedCatalogRecord('content.catalog')).toBe(false);
    expect(isPagedCatalogRecord('content.catalog.pages')).toBe(false);
    expect(isPagedCatalogRecord('content.artifact.p1')).toBe(false);
  });
});

describe('the round trip is exact', () => {
  it('assemble(split(x)) is x — order and key order included', async () => {
    const list = catalog(500);
    const s = splitCatalog(list);
    expect(JSON.stringify(assembleCatalog({ order: s.order, folders: s.folders, pageCount: 32 }, s.pages))).toBe(JSON.stringify(list));
  });

  it('through the stored form: each page compact-coded, read back through the codec', async () => {
    const list = catalog(300);
    const built = await buildPagedCatalog(list, { active: true, now: 1 });
    const { records, readMany } = store();
    putPlan(records, built);
    expect(built.writes.some((w) => (w.data as { $format?: string }).$format === CATALOG_COMPACT_FORMAT)).toBe(true);
    expect(JSON.stringify(await readCatalog(readMany))).toBe(JSON.stringify(list));
  });

  it('an empty list and a list of folders only round-trip too', async () => {
    for (const list of [[], [folder('a'), folder('a/b')]]) {
      const { records, readMany } = store();
      putPlan(records, await buildPagedCatalog(list, { active: true, now: 1 }));
      expect(await readCatalog(readMany)).toEqual(list);
    }
  });
});

describe('the switch is the root, and only an active one', () => {
  it('no root → the legacy record, expanded, exactly as before', async () => {
    const { records, readMany, reads } = store();
    const legacy = catalog(40);
    records.set('content.catalog', compactCatalog(legacy));
    expect(await readCatalog(readMany)).toEqual(legacy);
    expect(reads).toEqual([CATALOG_ROOT_RECORD, 'content.catalog']);
  });

  it('an INACTIVE root (prepared, not switched) → still the legacy record', async () => {
    const { records, readMany, reads } = store();
    const legacy = catalog(40);
    records.set('content.catalog', legacy);
    putPlan(records, await buildPagedCatalog([doc(999)], { active: false, now: 1 }));
    expect(await readCatalog(readMany)).toEqual(legacy);
    expect(reads.filter((r) => r.startsWith('content.catalog.p'))).toHaveLength(0);
  });

  it('a root that does not parse is not a switch', () => {
    expect(activeCatalogRoot(null)).toBeNull();
    expect(activeCatalogRoot({ format: CATALOG_PAGED_FORMAT, active: true })).toBeNull();
    expect(activeCatalogRoot({ format: 'other', active: true, pageCount: 32, pages: [], order: '', folders: [] })).toBeNull();
    expect(activeCatalogRoot({ format: CATALOG_PAGED_FORMAT, active: 'yes', pageCount: 32, pages: [], order: '', folders: [] })).toBeNull();
    expect(asCatalogRoot({ format: CATALOG_PAGED_FORMAT, active: false, pageCount: 32, pages: [], order: '', folders: [] })).not.toBeNull();
  });

  it('a page the root says holds rows but that is missing is an ERROR, never an empty page', async () => {
    const { records, readMany } = store();
    const built = await buildPagedCatalog(catalog(100), { active: true, now: 1 });
    putPlan(records, built);
    const k = built.root.pages.find((p) => p.count > 0)!.k;
    records.delete(catalogPageRecord(k));
    await expect(readCatalog(readMany)).rejects.toThrow(/page \d+ is missing/);
    expect(pageRows(built.root, built.root.pages.find((p) => p.count === 0)?.k ?? 99, null)).toEqual([]);
  });
});

describe('a whole-list write touches only the pages that changed', () => {
  it('one entry changed → one page and the root', async () => {
    const list = catalog(400);
    const built = await buildPagedCatalog(list, { active: true, now: 1 });
    const next = structuredClone(list) as Array<Record<string, unknown>>;
    const i = next.findIndex((e) => e.id === 'doc-77');
    next[i] = { ...next[i], version: 2 };
    const plan = await planPagedWrite(next, built.root, 2);
    expect(plan.writes.map((w) => w.recordType)).toEqual([catalogPageRecord(pageOf('doc-77'))]);
    expect(plan.root.rev).toBe(built.root.rev + 1);
    const { records, readMany } = store();
    putPlan(records, built); putPlan(records, plan);
    expect(await readCatalog(readMany)).toEqual(next);
  });

  it('a removal and a reorder are carried exactly (order lives in the root)', async () => {
    const list = catalog(200);
    const built = await buildPagedCatalog(list, { active: true, now: 1 });
    // doc-5 removed and the first folder moved to the end: only doc-5's page changes; the move is the root's order.
    const rest = list.filter((e) => (e as { id?: string }).id !== 'doc-5');
    const next = [...rest.slice(1), rest[0]];
    const plan = await planPagedWrite(next, built.root, 2);
    expect(plan.writes.map((w) => w.recordType)).toEqual([catalogPageRecord(pageOf('doc-5'))]);
    const { records, readMany } = store();
    putPlan(records, built); putPlan(records, plan);
    expect(await readCatalog(readMany)).toEqual(next);
  });

  it('no change → no page is written', async () => {
    const list = catalog(100);
    const built = await buildPagedCatalog(list, { active: true, now: 1 });
    expect((await planPagedWrite(structuredClone(list), built.root, 2)).writes).toHaveLength(0);
  });
});

describe('a page-local edit', () => {
  const setup = async (n = 300) => {
    const list = catalog(n);
    const { records, readMany, reads } = store();
    putPlan(records, await buildPagedCatalog(list, { active: true, now: 1 }));
    const root = () => records.get(CATALOG_ROOT_RECORD) as CatalogRoot;
    const loads: number[] = [];
    const load = async (k: number) => { loads.push(k); return pageRows(root(), k, records.get(catalogPageRecord(k))); };
    return { list, records, readMany, reads, root, load, loads };
  };

  it('replaces the first row with that id in place, loading only its page', async () => {
    const w = await setup();
    const plan = await applyCatalogEdit(w.root(), w.load, [doc(42, { version: 9 })], 2);
    expect(w.loads).toEqual([pageOf('doc-42')]);
    expect(plan.writes.map((x) => x.k)).toEqual([pageOf('doc-42')]);
    putPlan(w.records, plan);
    const want = w.list.map((e) => ((e as { id?: string }).id === 'doc-42' ? doc(42, { version: 9 }) : e));
    expect(await readCatalog(w.readMany)).toEqual(want);
  });

  it('appends a new row at the end, as the whole-list save did', async () => {
    const w = await setup();
    putPlan(w.records, await applyCatalogEdit(w.root(), w.load, [doc(5000)], 2));
    expect(await readCatalog(w.readMany)).toEqual([...w.list, doc(5000)]);
    expect(w.root().total).toBe(w.list.length + 1);
  });

  it('a new folder lands in the root bucket and touches no page', async () => {
    const w = await setup();
    const plan = await applyCatalogEdit(w.root(), w.load, [folder('new/one')], 2);
    expect(plan.writes).toHaveLength(0);
    putPlan(w.records, plan);
    expect(await readCatalog(w.readMany)).toEqual([...w.list, folder('new/one')]);
  });

  it('a row that changes bucket keeps its position', async () => {
    const w = await setup();
    const asFolder = { ...doc(10), isFolder: true };
    putPlan(w.records, await applyCatalogEdit(w.root(), w.load, [asFolder], 2));
    expect(await readCatalog(w.readMany)).toEqual(w.list.map((e) => ((e as { id?: string }).id === 'doc-10' ? asFolder : e)));
  });

  it('a page torn ahead of its root (page written, root not) loses nothing and is repaired by the next edit', async () => {
    const w = await setup();
    const k = pageOf('doc-1');
    const page = pageRows(w.root(), k, w.records.get(catalogPageRecord(k)));
    w.records.set(catalogPageRecord(k), compactCatalog([...page, doc(7001, { id: 'torn-row' })].filter((e) => pageOf((e as { id: string }).id) === k || (e as { id: string }).id === 'torn-row')));
    const torn = (await readCatalog(w.readMany)) as Array<{ id?: string }>;
    expect(torn.some((e) => e.id === 'torn-row')).toBe(true);
    expect(torn).toHaveLength(w.list.length + 1);
    putPlan(w.records, await applyCatalogEdit(w.root(), w.load, [doc(1, { version: 3 })], 2));
    const after = (await readCatalog(w.readMany)) as Array<{ id?: string }>;
    expect(after.some((e) => e.id === 'torn-row')).toBe(true);
    expect(w.root().total).toBe(w.list.length + 1);
  });
});

describe('comparing the pages to a list', () => {
  it('passes on an exact copy and names what differs otherwise', async () => {
    const list = catalog(120);
    const built = await buildPagedCatalog(list, { active: false, now: 1 });
    const load = async (k: number) => built.writes[k]!.rows;
    expect((await compareCatalog(list, built.root, load)).ok).toBe(true);
    const changed = structuredClone(list) as Array<Record<string, unknown>>;
    const i = changed.findIndex((e) => e.id === 'doc-8');
    changed[i] = { ...changed[i], name: 'renamed.md' };
    const bad = await compareCatalog(changed, built.root, load);
    expect(bad.ok).toBe(false);
    expect(bad.mismatches).toEqual([expect.objectContaining({ id: 'doc-8', reason: 'value differs' })]);
    const reordered = await compareCatalog([...list].reverse(), built.root, load);
    expect(reordered.ok).toBe(false);
    expect(reordered.orderExact).toBe(false);
    const { name: _n, ...rest } = changed[i] as Record<string, unknown>;
    changed[i] = { ...rest, name: (list[i] as { name: string }).name }; // same values, different key order
    const keyOrder = await compareCatalog(changed, built.root, load);
    expect(keyOrder.mismatches).toEqual([expect.objectContaining({ id: 'doc-8', reason: 'key order differs' })]);
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

it('expandCatalog of a page that holds nothing worth sharing is the page itself', () => {
  const rows = [doc(1)];
  expect(expandCatalog(compactCatalog(rows))).toBe(rows);
});

it('the vault service carries the identical file (it assembles for every other reader)', () => {
  const here = readFileSync(new URL('../src/catalog-pages.ts', import.meta.url), 'utf8');
  const there = readFileSync(new URL('../../vault/src/catalog-pages.ts', import.meta.url), 'utf8');
  expect(there).toBe(here);
});
