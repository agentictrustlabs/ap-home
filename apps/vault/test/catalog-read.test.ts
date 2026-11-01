// THE VAULT SERVICE'S ONE READ OF A RECORD (src/catalog-read.ts): every tool that returns an owner's record returns the
// Library index as the same plain array — expanded when it is stored compact, ASSEMBLED when the owner is paged — and an
// entitlement's field projection applies to that array, never to the stored shape.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { compactCatalog } from '../src/catalog-codec.js';
import { CATALOG_ROOT_RECORD, buildPagedCatalog } from '../src/catalog-pages.js';
import { catalogIsPaged, readVaultRecordData } from '../src/catalog-read.js';

const OWNER = '0x' + 'ab'.repeat(20);
const SIG = (i: number) => '0x51' + 'ab'.repeat(400) + i.toString(16).padStart(8, '0');
const doc = (i: number) => ({ id: `doc-${i}`, kind: 'md', name: `n${i}.md`, folder: 'x', releases: [{ releaseId: `0xr${i}`, version: '1.0.0', signature: SIG(i), signed: true }] });
const list = (n: number) => [{ id: 'f-x', name: 'x', isFolder: true }, ...Array.from({ length: n }, (_, i) => doc(i))];

function vault() {
  const rows = new Map<string, unknown>();
  const reads: string[] = [];
  return {
    rows, reads,
    read: async (req: { owner: string; resource: string; fields?: string[] }) => {
      reads.push(req.resource);
      if (!rows.has(req.resource)) return null;
      let data = structuredClone(rows.get(req.resource));
      if (req.fields && data && typeof data === 'object' && !Array.isArray(data)) data = Object.fromEntries(Object.entries(data).filter(([k]) => req.fields!.includes(k)));
      return { owner: req.owner, resource: req.resource, classification: 'internal', data, updatedAt: '' } as never;
    },
  };
}
const page = async (v: ReturnType<typeof vault>, l: unknown[], active: boolean) => {
  const built = await buildPagedCatalog(l, { active, now: 1 });
  for (const w of built.writes) v.rows.set(`vault:${w.recordType}`, w.data);
  v.rows.set(`vault:${CATALOG_ROOT_RECORD}`, built.root);
};

describe('the Library index, as every vault tool returns it', () => {
  it('a legacy compact record is expanded (as before)', async () => {
    const v = vault();
    v.rows.set('vault:content.catalog', compactCatalog(list(5)));
    expect(await readVaultRecordData(v, OWNER, 'vault:content.catalog')).toEqual(list(5));
  });

  it('a PAGED owner is assembled from the pages, exactly', async () => {
    const v = vault();
    v.rows.set('vault:content.catalog', compactCatalog(list(3))); // the frozen pre-switch backup
    await page(v, list(80), true);
    expect(JSON.stringify(await readVaultRecordData(v, OWNER, 'vault:content.catalog'))).toBe(JSON.stringify(list(80)));
    expect(await catalogIsPaged(v, OWNER)).toBe(true);
  });

  it('a prepared but INACTIVE root changes nothing', async () => {
    const v = vault();
    v.rows.set('vault:content.catalog', list(3));
    await page(v, list(80), false);
    expect(await readVaultRecordData(v, OWNER, 'vault:content.catalog')).toEqual(list(3));
    expect(await catalogIsPaged(v, OWNER)).toBe(false);
  });

  it('the entitled read (field projection) gets the same assembled array — not the stored compact object cut to {}', async () => {
    const v = vault();
    v.rows.set('vault:content.catalog', compactCatalog(list(4)));
    expect(await readVaultRecordData(v, OWNER, 'vault:content.catalog', ['id', 'name'])).toEqual(list(4));
    await page(v, list(40), true);
    expect(await readVaultRecordData(v, OWNER, 'vault:content.catalog', ['id', 'name'])).toEqual(list(40));
  });

  it('any other record is read as it is stored, its projection applied by the vault', async () => {
    const v = vault();
    v.rows.set('vault:skills.data', { a: 1, b: 2 });
    expect(await readVaultRecordData(v, OWNER, 'vault:skills.data')).toEqual({ a: 1, b: 2 });
    expect(await readVaultRecordData(v, OWNER, 'vault:skills.data', ['a'])).toEqual({ a: 1 });
    expect(v.reads.every((r) => r === 'vault:skills.data')).toBe(true);
  });
});

it('every catalog read in the router goes through the one read (no tool expands on its own)', () => {
  const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  expect(src).not.toMatch(/expandCatalog\(/);
  expect(src.match(/readVaultRecordData\(/g)?.length).toBeGreaterThanOrEqual(3);
});

it('the interactions DO carries the identical paged-index and codec files', () => {
  for (const f of ['catalog-pages.ts', 'catalog-codec.ts']) {
    expect(readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8')).toBe(readFileSync(new URL(`../../agent-runtime/src/${f}`, import.meta.url), 'utf8'));
  }
});
