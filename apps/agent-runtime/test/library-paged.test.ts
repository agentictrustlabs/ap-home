// THE LIBRARY SAVE, ONE PAGE AT A TIME (src/library-paged.ts). For a switched owner a save by id reads the root and one
// page and writes one page and the root; every answer, refusal and record write is the one the whole-list save gives —
// held to that by running the same acts against both and comparing what the Library ends up holding.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { libraryWrite, CATALOG_MAX, type LibraryEntry, type LibraryToolDeps } from '../src/library-tools.js';
import { PAGED_CATALOG_MAX } from '../src/library-paged.js';
import { compactCatalog } from '../src/catalog-codec.js';
import { CATALOG_ROOT_RECORD, applyCatalogEdit, buildPagedCatalog, catalogPageRecord, pageOf, pageRows, readCatalog, type CatalogRoot } from '../src/catalog-pages.js';

const OWNER = '0x' + 'cd'.repeat(20);
const ctx = (i: number) => ({ step: { id: `s${i}` }, index: 0, supplied: [{ stepRef: `s${i}`, data: { keep: 'yes' } }], intent: { goal: 'save it' }, operationId: `op-${i}` }) as never;
const SIG = (i: number) => '0x51' + 'ab'.repeat(1100) + i.toString(16).padStart(8, '0') + 'cd'.repeat(100);
const entry = (i: number, extra: Partial<LibraryEntry> = {}): LibraryEntry => ({
  id: `doc-${i}`, kind: 'md', name: `n${i}.md`, source: 'blob', folder: `works/${i % 20}`, contentType: 'text/markdown', size: 400, version: 1, createdAt: 1_000 + i,
  contentCommitment: `0x${i.toString(16).padStart(64, '0')}`, grants: [],
  releases: [{ canonicalId: `0xc${i}`, version: '1.0.0', bundleRoot: `0xb${i}`, owner: OWNER, publisher: OWNER, riskTier: 'low', releaseId: `0x${i.toString(16).padStart(64, 'e')}`, signature: SIG(i), signed: true, publishedAt: 5 }],
  ...extra,
});
const folderRow = (path: string, extra: Partial<LibraryEntry> = {}): LibraryEntry => ({ id: `f-${path.replace(/\//g, '-')}`, kind: 'md', name: path.split('/').pop()!, source: 'blob', folder: path.split('/').slice(0, -1).join('/'), isFolder: true, contentType: 'inode/directory', size: 0, version: 1, createdAt: 1, grants: [], ...extra });
const library = (n: number): LibraryEntry[] => [folderRow('works'), folderRow('works/3', { accessPolicy: 'public' }), ...Array.from({ length: n }, (_, i) => entry(i))];

const bytes = (v: unknown): number => (v === undefined ? 0 : JSON.stringify(v ?? null).length);

/** A switched owner: the stored records, a CatalogStore over them, and a ledger of every record read and written. */
async function pagedOwner(list: LibraryEntry[]) {
  const records = new Map<string, unknown>();
  const built = await buildPagedCatalog(list, { active: true, now: 1 });
  for (const w of built.writes) records.set(w.recordType, w.data);
  records.set(CATALOG_ROOT_RECORD, built.root);
  const ledger = { reads: [] as string[], writes: [] as string[], readBytes: 0, writeBytes: 0 };
  const failRead = new Set<string>();
  const root = () => records.get(CATALOG_ROOT_RECORD) as CatalogRoot;
  const deps: LibraryToolDeps = {
    // The whole-list reader — a paged save must never call it for the catalog.
    readSubjectRecord: async (_s, t) => { ledger.reads.push(`whole:${t}`); return structuredClone(records.get(t) ?? null); },
    writeSubjectRecord: async (_s, t, r) => {
      if (t === 'content.catalog' || t.startsWith('content.catalog.')) throw new Error(`a paged save wrote ${t} directly`);
      ledger.writes.push(t); ledger.writeBytes += bytes(r); records.set(t, structuredClone(r)); return { ok: true };
    },
    signAsOwner: async () => `0x${'5'.repeat(130)}` as `0x${string}`,
    catalogStore: {
      read: async (_o, rt) => {
        ledger.reads.push(rt);
        if (failRead.has(rt)) return { ok: false, data: null, error: 'vault unavailable' };
        const data = records.get(rt) ?? null;
        ledger.readBytes += bytes(data);
        return { ok: true, data: rt === CATALOG_ROOT_RECORD ? structuredClone(data) : pageRows(root(), Number(rt.slice('content.catalog.p'.length)), structuredClone(data)) };
      },
      // The DO's page edit, as the object runs it: root and pages FRESH, changed pages then the root.
      edit: async (_o, upserts) => {
        ledger.reads.push(`edit:${CATALOG_ROOT_RECORD}`);
        ledger.readBytes += bytes(records.get(CATALOG_ROOT_RECORD));
        const plan = await applyCatalogEdit(root(), async (k) => { ledger.reads.push(`edit:${catalogPageRecord(k)}`); ledger.readBytes += bytes(records.get(catalogPageRecord(k))); return pageRows(root(), k, records.get(catalogPageRecord(k))); }, structuredClone(upserts), 2);
        for (const w of plan.writes) { ledger.writes.push(w.recordType); ledger.writeBytes += bytes(w.data); records.set(w.recordType, w.data); }
        ledger.writes.push(CATALOG_ROOT_RECORD); ledger.writeBytes += bytes(plan.root); records.set(CATALOG_ROOT_RECORD, plan.root);
        return { ok: true };
      },
    },
  };
  const catalog = async () => (await readCatalog(async (rts) => rts.map((rt) => records.get(rt) ?? null))) as LibraryEntry[];
  const reset = () => { ledger.reads = []; ledger.writes = []; ledger.readBytes = 0; ledger.writeBytes = 0; };
  return { records, deps, ledger, catalog, reset, failRead, root };
}

/** The same Library as one legacy record, saved by the whole-list path. */
function legacyOwner(list: LibraryEntry[]) {
  const records = new Map<string, unknown>([['content.catalog', structuredClone(list)]]);
  const deps: LibraryToolDeps = {
    readSubjectRecord: async (_s, t) => structuredClone(records.get(t) ?? null),
    writeSubjectRecord: async (_s, t, r) => (records.set(t, structuredClone(r)), { ok: true }),
    signAsOwner: async () => `0x${'5'.repeat(130)}` as `0x${string}`,
  };
  return { records, deps, catalog: async () => records.get('content.catalog') as LibraryEntry[] };
}

// Ids are minted from Date.now() and Math.random(): both runs see the same sequence.
let tick = 0;
beforeEach(() => {
  tick = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => 1_700_000_000_000 + tick++);
  let r = 0;
  vi.spyOn(Math, 'random').mockImplementation(() => ((r = (r * 9301 + 49297) % 233280) / 233280));
});
afterEach(() => vi.restoreAllMocks());

describe('a save by id reads the root and ONE page, and writes ONE page and the root', () => {
  it('a re-save of an existing document', async () => {
    const o = await pagedOwner(library(300));
    o.reset();
    const out = (await libraryWrite(o.deps, OWNER, 'library.file.save', { id: 'doc-42', name: 'n42.md', folder: 'works/2', text: 'v2', kind: 'md' }, ctx(1))) as { saved: boolean; file: { version: number } };
    expect(out).toMatchObject({ saved: true, file: { version: 2 } });
    const k = pageOf('doc-42');
    expect(o.ledger.reads).toEqual([CATALOG_ROOT_RECORD, catalogPageRecord(k), `edit:${CATALOG_ROOT_RECORD}`, `edit:${catalogPageRecord(k)}`]);
    expect(o.ledger.writes.sort()).toEqual(['content.artifact.doc-42', catalogPageRecord(k), CATALOG_ROOT_RECORD].sort());
    const saved = (await o.catalog()).find((e) => e.id === 'doc-42')!;
    expect(saved).toMatchObject({ version: 2, releases: library(1)[2]!.releases ? expect.any(Array) : undefined });
    expect(saved.bytesB64).toBeUndefined();
    expect((o.records.get('content.artifact.doc-42') as { bytesB64: string }).bytesB64).toBe(btoa('v2'));
  });

  it('a visibility change and a release by id', async () => {
    const o = await pagedOwner(library(300));
    o.reset();
    await libraryWrite(o.deps, OWNER, 'library.file.visibility', { id: 'doc-7', accessPolicy: 'public' }, ctx(2));
    expect(o.ledger.writes.sort()).toEqual([catalogPageRecord(pageOf('doc-7')), CATALOG_ROOT_RECORD].sort());
    o.reset();
    const pub = (await libraryWrite(o.deps, OWNER, 'library.file.publish', { id: 'doc-7' }, ctx(3))) as { published: boolean; release: { version: string } };
    expect(pub).toMatchObject({ published: true, release: { version: '2.0.0' } });
    expect(o.ledger.writes.sort()).toEqual([catalogPageRecord(pageOf('doc-7')), CATALOG_ROOT_RECORD].sort());
    expect(o.ledger.reads.filter((r) => r.startsWith('content.catalog.p'))).toEqual([catalogPageRecord(pageOf('doc-7')), catalogPageRecord(pageOf('doc-7'))]);
    const e = (await o.catalog()).find((x) => x.id === 'doc-7')!;
    expect(e.accessPolicy).toBe('public');
    expect(e.releases).toHaveLength(2);
  });

  it('never reads the whole catalog', async () => {
    const o = await pagedOwner(library(100));
    await libraryWrite(o.deps, OWNER, 'library.file.save', { id: 'doc-1', name: 'n1.md', folder: 'works/1', text: 'x' }, ctx(4));
    await libraryWrite(o.deps, OWNER, 'library.file.save', { name: 'brand-new.md', folder: 'works/1', text: 'y' }, ctx(5));
    expect(o.ledger.reads.filter((r) => r.startsWith('whole:content.catalog'))).toEqual([]);
  });
});

describe('a save that names no id walks the pages one at a time and matches as before', () => {
  it('a document already at that path is re-saved (version 2), not twinned', async () => {
    const o = await pagedOwner(library(200));
    o.reset();
    const out = (await libraryWrite(o.deps, OWNER, 'library.file.save', { name: 'n9.md', folder: 'works/9', text: 'again' }, ctx(6))) as { file: { id: string; version: number } };
    expect(out.file).toMatchObject({ id: 'doc-9', version: 2 });
    expect(o.ledger.reads.filter((r) => /^content\.catalog\.p\d+$/.test(r))).toHaveLength(32 + 1);
    expect(o.ledger.writes.filter((w) => w.startsWith('content.catalog.p'))).toEqual([catalogPageRecord(pageOf('doc-9'))]);
    expect((await o.catalog()).filter((e) => e.name === 'n9.md')).toHaveLength(1);
  });

  it('a new document is minted and lands, appended, in its own page', async () => {
    const o = await pagedOwner(library(200));
    const out = (await libraryWrite(o.deps, OWNER, 'library.file.save', { name: 'fresh.md', folder: 'works/1', text: 'new' }, ctx(7))) as { file: { id: string } };
    const all = await o.catalog();
    expect(all.at(-1)!.id).toBe(out.file.id);
    expect(all).toHaveLength(library(200).length + 1);
    expect(o.root().total).toBe(library(200).length + 1);
  });

  it('a name that matches two documents is refused with the same words, in list order', async () => {
    const list = [...library(60), entry(500, { name: 'twin.md', folder: 'a' }), entry(501, { name: 'twin.md', folder: 'b' })];
    const p = await pagedOwner(list);
    const l = legacyOwner(list);
    const a = await libraryWrite(p.deps, OWNER, 'library.file.visibility', { name: 'twin.md', accessPolicy: 'public' }, ctx(8)).catch((e: Error) => e.message);
    const b = await libraryWrite(l.deps, OWNER, 'library.file.visibility', { name: 'twin.md', accessPolicy: 'public' }, ctx(8)).catch((e: Error) => e.message);
    expect(a).toBe(b);
    expect(a).toMatch(/2 documents match — which one\? a\/twin\.md · b\/twin\.md/);
    const none = await libraryWrite(p.deps, OWNER, 'library.file.visibility', { name: 'nothing-like-it', accessPolicy: 'public' }, ctx(9)).catch((e: Error) => e.message);
    expect(none).toBe('no document named "nothing-like-it" in the Library');
  });
});

describe('the same acts, paged and whole-list, leave the same Library', () => {
  it('saves, re-saves by path and by id, folders, visibility by name, releases of a page and of a bundle folder', async () => {
    const list = library(120);
    const p = await pagedOwner(list);
    const l = legacyOwner(list);
    const acts: Array<[string, Record<string, unknown>]> = [
      ['library.file.save', { name: 'alpha.md', folder: 'works/1', text: 'a' }],
      ['library.file.save', { name: 'alpha.md', folder: 'works/1', text: 'a2' }],
      ['library.file.save', { name: 'bundle', folder: 'works', isFolder: true }],
      ['library.file.save', { name: 'SKILL.md', folder: 'works/bundle', text: '# s', kind: 'skill' }],
      ['library.file.save', { id: 'doc-33', name: 'n33.md', folder: 'works/13', text: 'v2', accessPolicy: 'public' }],
      ['library.file.visibility', { name: 'n44', accessPolicy: 'public' }],
      ['library.file.visibility', { name: 'bundle', accessPolicy: 'public' }],
      ['library.file.publish', { name: 'alpha' }],
      ['library.file.publish', { name: 'bundle', folder: 'works' }],
      ['library.file.save', { name: 'n12.md', folder: 'works/12', text: 'by path' }],
    ];
    const answers: unknown[][] = [[], []];
    for (const [side, o] of [[0, p], [1, l]] as const) {
      tick = 0;
      let r = 0;
      vi.spyOn(Math, 'random').mockImplementation(() => ((r = (r * 9301 + 49297) % 233280) / 233280));
      for (const [i, [tool, args]] of acts.entries()) answers[side]!.push(await libraryWrite(o.deps, OWNER, tool, args, ctx(100 + i)).catch((e: Error) => ({ refused: e.message })));
    }
    expect(answers[0]).toEqual(answers[1]);
    expect(await p.catalog()).toEqual(await l.catalog());
    for (const [k, v] of l.records) if (k.startsWith('content.artifact.')) expect(p.records.get(k), k).toEqual(v);
  });
});

describe('the cap', () => {
  it(`a paged Library indexes up to ${PAGED_CATALOG_MAX}; the next new document is refused in words, a re-save is not`, async () => {
    const full = Array.from({ length: PAGED_CATALOG_MAX }, (_, i) => ({ id: `d-${i}`, kind: 'md', name: `d${i}.md`, folder: 'f' })) as LibraryEntry[];
    const o = await pagedOwner(full);
    await expect(libraryWrite(o.deps, OWNER, 'library.file.save', { id: 'one-more', name: 'one-more.md', folder: 'f', text: 'x' }, ctx(20))).rejects.toThrow(/the most it indexes \(10000\)/);
    expect(o.root().total).toBe(PAGED_CATALOG_MAX);
    await expect(libraryWrite(o.deps, OWNER, 'library.file.save', { id: 'd-5', name: 'd5.md', folder: 'f', text: 'x' }, ctx(21))).resolves.toMatchObject({ saved: true });
  });

  it(`past the legacy cap (${CATALOG_MAX}) a paged Library still saves`, async () => {
    const o = await pagedOwner(Array.from({ length: CATALOG_MAX + 1 }, (_, i) => ({ id: `d-${i}`, kind: 'md', name: `d${i}.md`, folder: 'f' })) as LibraryEntry[]);
    await expect(libraryWrite(o.deps, OWNER, 'library.file.save', { id: 'next-one', name: 'next.md', folder: 'f', text: 'x' }, ctx(22))).resolves.toMatchObject({ saved: true });
  });

  it('a paged owner saved without the page store goes through the whole list (the DO pages it) under the paged cap', async () => {
    const list = Array.from({ length: CATALOG_MAX + 5 }, (_, i) => ({ id: `d-${i}`, kind: 'md', name: `d${i}.md`, folder: 'f' })) as LibraryEntry[];
    const records = new Map<string, unknown>([['content.catalog', list], [CATALOG_ROOT_RECORD, (await buildPagedCatalog(list, { active: true, now: 1 })).root]]);
    const deps: LibraryToolDeps = { readSubjectRecord: async (_s, t) => structuredClone(records.get(t) ?? null), writeSubjectRecord: async (_s, t, r) => (records.set(t, r), { ok: true }) };
    await expect(libraryWrite(deps, OWNER, 'library.file.save', { name: 'x.md', folder: 'f', text: 'x' }, ctx(23))).resolves.toMatchObject({ saved: true });
    expect((records.get('content.catalog') as unknown[]).length).toBe(CATALOG_MAX + 6);
  });
});

describe('a read that failed is never an empty Library', () => {
  it('a root that cannot be read refuses the save and writes nothing', async () => {
    const o = await pagedOwner(library(20));
    o.failRead.add(CATALOG_ROOT_RECORD);
    o.reset();
    await expect(libraryWrite(o.deps, OWNER, 'library.file.save', { id: 'doc-1', name: 'n1.md', text: 'x' }, ctx(30))).rejects.toThrow(/could not be read/);
    expect(o.ledger.writes).toEqual([]);
  });

  it('a page that cannot be read refuses the save and writes nothing', async () => {
    const o = await pagedOwner(library(20));
    o.failRead.add(catalogPageRecord(pageOf('doc-1')));
    o.reset();
    await expect(libraryWrite(o.deps, OWNER, 'library.file.save', { id: 'doc-1', name: 'n1.md', text: 'x' }, ctx(31))).rejects.toThrow(/page \d+ could not be read/);
    expect(o.ledger.writes).toEqual([]);
  });

  it('a page the root counts but that is gone refuses the save', async () => {
    const o = await pagedOwner(library(20));
    o.records.delete(catalogPageRecord(pageOf('doc-1')));
    await expect(libraryWrite(o.deps, OWNER, 'library.file.save', { id: 'doc-1', name: 'n1.md', text: 'x' }, ctx(32))).rejects.toThrow(/is missing/);
  });

  it('a legacy owner whose index read failed is refused, not overwritten with one entry', async () => {
    const records = new Map<string, unknown>([['content.catalog', library(5)]]);
    const deps: LibraryToolDeps = {
      readSubjectRecord: async () => null,
      readSubjectRecordStatus: async (_s, t) => (t === 'content.catalog' ? { ok: false, data: null, error: 'vault timeout' } : { ok: true, data: null }),
      writeSubjectRecord: async (_s, t, r) => (records.set(t, r), { ok: true }),
    };
    await expect(libraryWrite(deps, OWNER, 'library.file.save', { name: 'x.md', text: 'x' }, ctx(33))).rejects.toThrow(/could not be read \(vault timeout\)/);
    expect(records.get('content.catalog')).toEqual(library(5));
  });
});

it("a visibility change keeps the document's body (the index entry carries none to write over it)", async () => {
  const o = await pagedOwner(library(10));
  o.records.set('content.artifact.doc-3', { id: 'doc-3', bytesB64: btoa('the body') });
  await libraryWrite(o.deps, OWNER, 'library.file.visibility', { id: 'doc-3', accessPolicy: 'public' }, ctx(40));
  expect((o.records.get('content.artifact.doc-3') as { bytesB64: string }).bytesB64).toBe(btoa('the body'));
});

describe('the budget', () => {
  it('a save in a 6,000-document Library moves a small fraction of the catalog (measured)', async () => {
    const list = library(6000);
    const whole = JSON.stringify(compactCatalog(list)).length; // what one whole-list read OR write moved
    const o = await pagedOwner(list);
    o.reset();
    await libraryWrite(o.deps, OWNER, 'library.file.save', { id: 'doc-4321', name: 'n4321.md', folder: 'works/1', text: 'edited' }, ctx(50));
    const moved = o.ledger.readBytes + o.ledger.writeBytes;
    // Root (order + folders) twice read and once written, the page twice read and once written, the document's record.
    // The whole-list save moved `whole` in and `whole` out — at least 2 × whole.
    process.stderr.write(`[paged budget] catalog ${whole} B compact; one save moved ${moved} B (${(moved / (2 * whole) * 100).toFixed(1)}% of a whole-list save)\n`);
    expect(moved).toBeLessThan((2 * whole) / 8);
    expect(o.ledger.writes.filter((w) => w.startsWith('content.catalog.p'))).toHaveLength(1);
  });
});
