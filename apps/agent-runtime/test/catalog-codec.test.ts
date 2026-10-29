// The Library index stored compact (src/catalog-codec.ts): one shared wire instead of one per signed document.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { CATALOG_COMPACT_FORMAT, compactCatalog, expandCatalog } from '../src/catalog-codec.js';

const SKELETON = '0x51' + 'ab'.repeat(500);            // the fixed part of a ~2.5 KB wrapped session signature
const sigFor = (i: number, r: number): string => { const n = (i * 31 + r * 7 + 1).toString(16).padStart(8, '0'); return SKELETON + n + 'cd'.repeat(300) + n.split('').reverse().join('').repeat(8) + 'ef'.repeat(20); };
const entry = (i: number, releases = 1) => ({
  id: `publishing-works-w${i}`, kind: 'json-ld', name: `w${i}`, folder: 'publishing/works', contentType: 'application/ld+json', size: 100 + i, version: 1,
  contentCommitment: `0x${i.toString(16).padStart(64, '0')}`, grants: [],
  releases: Array.from({ length: releases }, (_, r) => ({ canonicalId: `0xc${i}${r}`, version: `${r + 1}.0.0`, bundleRoot: `0xb${i}`, owner: '0xowner', publisher: '0xowner', riskTier: 'low', releaseId: `0xr${i}${r}`, signature: sigFor(i, r), signed: true, publishedAt: 1_000 + i })),
});
const catalog = (n: number) => Array.from({ length: n }, (_, i) => entry(i, 1 + (i % 3 === 0 ? 2 : 0)));

describe('catalog codec', () => {
  it('round-trips exactly, key order included', () => {
    const list = catalog(60);
    const packed = compactCatalog(list);
    expect((packed as { $format: string }).$format).toBe(CATALOG_COMPACT_FORMAT);
    expect(JSON.stringify(expandCatalog(packed))).toBe(JSON.stringify(list));
  });

  it('stores the shared skeleton once: the record shrinks by the repeated part', () => {
    const list = catalog(300);
    const before = JSON.stringify(list).length;
    const after = JSON.stringify(compactCatalog(list)).length;
    expect(after).toBeLessThan(before / 2);
  });

  it('signatures of different lengths each get their own base and still round-trip', () => {
    const list = catalog(30) as Array<ReturnType<typeof entry>>;
    list[4]!.releases[0]!.signature = sigFor(4, 0).slice(0, -40);
    list[9]!.releases[0]!.signature = sigFor(9, 0) + 'ab'.repeat(30);
    const packed = compactCatalog(list) as { sigBases: Record<string, string> };
    expect(Object.keys(packed.sigBases).length).toBe(3);
    expect(JSON.stringify(expandCatalog(packed))).toBe(JSON.stringify(list));
  });

  it('expand is idempotent and passes anything else through untouched', () => {
    const list = catalog(5);
    expect(expandCatalog(list)).toBe(list);
    expect(expandCatalog(null)).toBeNull();
    expect(expandCatalog({ a: 1 })).toEqual({ a: 1 });
    const once = expandCatalog(compactCatalog(list));
    expect(expandCatalog(once)).toEqual(once);
  });

  it('leaves a catalog with nothing to share alone', () => {
    const one = [entry(1)];
    expect(compactCatalog(one)).toBe(one);
    expect(compactCatalog([])).toEqual([]);
    expect(compactCatalog(null)).toBeNull();
    const noReleases = [{ id: 'a', name: 'a', kind: 'md' }, { id: 'b', name: 'b', kind: 'md' }];
    expect(compactCatalog(noReleases)).toBe(noReleases);
  });

  it('a signature that is not plain hex, or is short, stays whole', () => {
    const mixed = catalog(4) as Array<ReturnType<typeof entry>>;
    (mixed[1]!.releases[0] as { signature: string }).signature = 'not-a-hex-signature';
    (mixed[2]!.releases[0] as { signature: string }).signature = '0xabc';
    (mixed[3]!.releases[0] as { signature: string }).signature = '0x' + 'zz'.repeat(200);
    const packed = compactCatalog(mixed) as { entries: Array<{ releases: Array<{ signature: string }> }> };
    expect(packed.entries[1]!.releases[0]!.signature).toBe('not-a-hex-signature');
    expect(packed.entries[2]!.releases[0]!.signature).toBe('0xabc');
    expect(packed.entries[3]!.releases[0]!.signature.startsWith('~2:')).toBe(false);
    expect(JSON.stringify(expandCatalog(compactCatalog(mixed)))).toBe(JSON.stringify(mixed));
  });

  it('a real signature can never read as a compact reference', () => {
    const packed = compactCatalog(catalog(3)) as { entries: Array<{ releases: Array<{ signature: string }> }> };
    for (const e of packed.entries) for (const r of e.releases) expect(r.signature.startsWith('~2:')).toBe(true);
    expect(sigFor(1, 0).startsWith('~2:')).toBe(false);
  });

  it('a compact record with a missing base table or entries is returned as it came, not guessed at', () => {
    const bad = { $format: CATALOG_COMPACT_FORMAT, entries: [] };   // no base table
    expect(expandCatalog(bad)).toBe(bad);
  });

  it('the vault service carries the identical file (it expands for every other reader)', () => {
    const here = readFileSync(new URL('../src/catalog-codec.ts', import.meta.url), 'utf8');
    const there = readFileSync(new URL('../../vault/src/catalog-codec.ts', import.meta.url), 'utf8');
    expect(there).toBe(here);
  });
});
