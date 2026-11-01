// THE LIBRARY INDEX AT THE VAULT (src/catalog-store.ts), against the vault's real encrypted store and SQL (node:sqlite):
// every tool returns `content.catalog` as the same plain array; the paged family is reserved; a paged owner's legacy
// record is written only by the authenticated restore; the root swap and the switch are compare-and-sets.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { compactCatalog } from '../src/catalog-codec.js';
import { CATALOG_ROOT_RECORD, buildPagedCatalog, newGeneration, planPagedWrite, type CatalogRoot } from '../src/catalog-pages.js';
import { commitCatalog, getStoredCatalogRecords, readVaultRecordData, writeVaultRecord } from '../src/catalog-store.js';
import { sqliteAvailable, sqliteVault } from './support/sqlite-vault.js';

const OWNER = '0x' + 'ab'.repeat(20);
const SIG = (i: number) => '0x51' + 'ab'.repeat(400) + i.toString(16).padStart(8, '0');
const doc = (i: number) => ({ id: `doc-${i}`, kind: 'md', name: `n${i}.md`, folder: 'x', releases: [{ releaseId: `0xr${i}`, version: '1.0.0', signature: SIG(i), signed: true }] });
const list = (n: number) => [{ id: 'f-x', name: 'x', isFolder: true }, ...Array.from({ length: n }, (_, i) => doc(i))];
const CAT = 'vault:content.catalog';

async function setup(legacy: unknown[] | null) {
  const s = sqliteVault();
  const v = s.vault;
  if (legacy) expect(await writeVaultRecord(v, OWNER, 'content.catalog', compactCatalog(legacy))).toEqual({ ok: true });
  const stored = async (rt: string) => (await getStoredCatalogRecords(v, OWNER, [rt]) as { records: Record<string, { data: unknown; rev: number } | null> }).records[rt];
  const legacyRev = async () => (await stored('content.catalog'))?.rev ?? -1;
  const rootRev = async () => (await stored(CATALOG_ROOT_RECORD))?.rev ?? -1;
  /** Prepare and (optionally) activate exactly as the DO does, through `catalog_commit`. */
  const page = async (l: unknown[], active: boolean) => {
    const built = await buildPagedCatalog(l, { gen: newGeneration(1), active: false, now: 1, migratedFrom: { hash: 'h', total: l.length, legacyRev: await legacyRev(), at: 1 } });
    expect(await commitCatalog(v, OWNER, { op: 'pages', writes: built.pages.map((p) => ({ recordType: p.recordType, data: p.data })) })).toMatchObject({ ok: true });
    expect(await commitCatalog(v, OWNER, { op: 'root', data: built.root, expectRootRev: await rootRev() })).toMatchObject({ ok: true });
    if (!active) return built.root;
    const L = await legacyRev();
    const on: CatalogRoot = { ...built.root, active: true, activation: { legacyRev: L, at: 2 }, seq: built.root.seq + 1 };
    expect(await commitCatalog(v, OWNER, { op: 'root', data: on, expectRootRev: await rootRev(), expectLegacyRev: L })).toMatchObject({ ok: true });
    return on;
  };
  return { ...s, v, page, legacyRev, rootRev, stored };
}

describe.skipIf(!sqliteAvailable)('every vault tool returns the Library index as one plain array', () => {
  it('a legacy compact record is expanded; a prepared but inactive root changes nothing', async () => {
    const t = await setup(list(5));
    expect(await readVaultRecordData(t.v, OWNER, CAT)).toEqual(list(5));
    await t.page(list(80), false);
    expect(await readVaultRecordData(t.v, OWNER, CAT)).toEqual(list(5));
  });

  it('an active owner is assembled from the pages, exactly — and the projection applies to that array', async () => {
    const t = await setup(list(3));
    await t.page(list(120), true);
    expect(JSON.stringify(await readVaultRecordData(t.v, OWNER, CAT))).toBe(JSON.stringify(list(120)));
    expect(await readVaultRecordData(t.v, OWNER, CAT, ['id', 'name'])).toEqual(list(120));
  });

  it('the entitled read of a legacy compact record (fields) gets the array, not the compact object cut to {}', async () => {
    const t = await setup(list(4));
    expect(await readVaultRecordData(t.v, OWNER, CAT, ['id'])).toEqual(list(4));
  });

  it('AS STORED: get_catalog_records returns the legacy record compact, never the assembled pages, with its rev', async () => {
    const t = await setup(list(10));
    const before = await t.stored('content.catalog');
    await t.page(list(50), true);
    const after = await t.stored('content.catalog');
    expect(after).toEqual(before);
    expect((after!.data as { $format?: string }).$format).toBe('ap.catalog.compact.v2');
  });
});

describe.skipIf(!sqliteAvailable)('a broken paged index is an error, never the legacy record', () => {
  it('a root that does not parse fails every read and every legacy write', async () => {
    const bad = await setup(list(5));
    await bad.v.writeGuarded(OWNER, 'vault:content.catalog.root', { format: 'ap.catalog.paged.v2', active: true }, {});
    await expect(readVaultRecordData(bad.v, OWNER, CAT)).rejects.toThrow(/catalog_integrity/);
    expect(await writeVaultRecord(bad.v, OWNER, 'content.catalog', list(6))).toMatchObject({ ok: false, error: 'catalog_integrity' });
  });

  it('a DELETED root fails reads and legacy writes (it does not silently revert the owner to the frozen record)', async () => {
    const t = await setup(list(5));
    await t.page(list(20), true);
    t.exec(`UPDATE vault_objects SET deleted_at = CURRENT_TIMESTAMP WHERE resource = ?`, 'vault:content.catalog.root');
    await expect(readVaultRecordData(t.v, OWNER, CAT)).rejects.toThrow(/deleted/);
    expect(await writeVaultRecord(t.v, OWNER, 'content.catalog', list(6))).toMatchObject({ ok: false, error: 'catalog_integrity' });
  });

  it('a page the root names but that is gone fails the read', async () => {
    const t = await setup(list(5));
    const root = await t.page(list(40), true);
    const k = root.pages.find((p) => p.gen)!;
    t.exec(`UPDATE vault_objects SET deleted_at = CURRENT_TIMESTAMP WHERE resource = ?`, `vault:content.catalog.p${k.k}.g${k.gen}`);
    await expect(readVaultRecordData(t.v, OWNER, CAT)).rejects.toThrow(/missing/);
  });
});

describe.skipIf(!sqliteAvailable)('set_vault_record: the paged family is reserved; the legacy record is guarded', () => {
  it('no write or tombstone of the root or a page through set_vault_record', async () => {
    const t = await setup(list(5));
    const root = await t.page(list(20), true);
    const named = `content.catalog.p${root.pages.find((p) => p.gen)!.k}.g${root.pages.find((p) => p.gen)!.gen}`;
    for (const rt of [CATALOG_ROOT_RECORD, named, 'content.catalog.p3', 'content.catalog.p3.gzzz'])
      for (const data of [{ active: false }, null]) expect(await writeVaultRecord(t.v, OWNER, rt, data)).toMatchObject({ ok: false, error: 'catalog_record_reserved' });
    expect(JSON.stringify(await readVaultRecordData(t.v, OWNER, CAT))).toBe(JSON.stringify(list(20)));
  });

  it('a legacy write is refused while the owner is paged, and lands while not', async () => {
    const t = await setup(list(5));
    await t.page(list(20), false);
    expect(await writeVaultRecord(t.v, OWNER, 'content.catalog', list(6))).toEqual({ ok: true });
    const t2 = await setup(list(5));
    await t2.page(list(5), true);
    expect(await writeVaultRecord(t2.v, OWNER, 'content.catalog', list(6))).toMatchObject({ ok: false, error: 'catalog_paged' });
    expect(await t2.legacyRev()).toBe(0);
  });

  it('a legacy write whose root moved after it was checked writes nothing (one guarded statement)', async () => {
    const t = await setup(list(5));
    await t.page(list(5), false);
    // The root is read as inactive, then the owner is switched on before the legacy write lands.
    const racing = { ...t.v, readStored: async (o: string, r: string) => {
      const got = await t.v.readStored(o, r);
      if (r === 'vault:content.catalog.root') {
        const L = await t.legacyRev();
        const root = got!.data as CatalogRoot;
        await commitCatalog(t.v, OWNER, { op: 'root', data: { ...root, active: true, activation: { legacyRev: L, at: 3 }, seq: root.seq + 1 }, expectRootRev: got!.rev, expectLegacyRev: L });
      }
      return got;
    } };
    expect(await writeVaultRecord(racing, OWNER, 'content.catalog', list(99))).toMatchObject({ ok: false, error: 'catalog_switched' });
    expect(await t.legacyRev()).toBe(0);
  });
});

describe.skipIf(!sqliteAvailable)('catalog_commit', () => {
  it('a page generation is written once, never over anything', async () => {
    const t = await setup(list(5));
    const w = { recordType: 'content.catalog.p1.gabc', data: [doc(1)] };
    expect(await commitCatalog(t.v, OWNER, { op: 'pages', writes: [w] })).toMatchObject({ ok: true });
    expect(await commitCatalog(t.v, OWNER, { op: 'pages', writes: [{ ...w, data: [doc(2)] }] })).toMatchObject({ ok: false, error: 'catalog_page_exists' });
    expect(await commitCatalog(t.v, OWNER, { op: 'pages', writes: [{ recordType: CATALOG_ROOT_RECORD, data: [] }] })).toMatchObject({ ok: false });
  });

  it('the root swap is a compare-and-set, and never names a page that does not exist', async () => {
    const t = await setup(list(5));
    const root = await t.page(list(30), true);
    const plan = await planPagedWrite([...list(30), doc(999)], root, { gen: newGeneration(root.seq + 1), now: 3 });
    const stale = await t.rootRev();
    // pages not written yet ⇒ the root may not name them
    expect(await commitCatalog(t.v, OWNER, { op: 'root', data: plan.root, expectRootRev: stale })).toMatchObject({ ok: false, error: 'catalog_page_missing' });
    await commitCatalog(t.v, OWNER, { op: 'pages', writes: plan.pages.map((p) => ({ recordType: p.recordType, data: p.data })) });
    expect(await commitCatalog(t.v, OWNER, { op: 'root', data: plan.root, expectRootRev: stale })).toMatchObject({ ok: true });
    // a second writer that read the same root loses, and changes nothing
    const other = await planPagedWrite(list(30), root, { gen: newGeneration(root.seq + 1), now: 4 });
    await commitCatalog(t.v, OWNER, { op: 'pages', writes: other.pages.map((p) => ({ recordType: p.recordType, data: p.data })) });
    expect(await commitCatalog(t.v, OWNER, { op: 'root', data: other.root, expectRootRev: stale })).toMatchObject({ ok: false, error: 'catalog_conflict' });
    expect(await readVaultRecordData(t.v, OWNER, CAT)).toEqual([...list(30), doc(999)]);
  });

  it('switching on requires the legacy rev it checked — atomically: a legacy write after the check fails the switch', async () => {
    const t = await setup(list(5));
    const root = await t.page(list(5), false);
    const L = await t.legacyRev();
    const on = { ...root, active: true, activation: { legacyRev: L, at: 2 }, seq: root.seq + 1 };
    expect(await commitCatalog(t.v, OWNER, { op: 'root', data: on, expectRootRev: await t.rootRev() })).toMatchObject({ ok: false, error: 'catalog_switch_unchecked' });
    expect(await writeVaultRecord(t.v, OWNER, 'content.catalog', list(7))).toEqual({ ok: true }); // a direct writer moves the legacy record
    expect(await commitCatalog(t.v, OWNER, { op: 'root', data: on, expectRootRev: await t.rootRev(), expectLegacyRev: L })).toMatchObject({ ok: false, error: 'catalog_conflict' });
    expect(await readVaultRecordData(t.v, OWNER, CAT)).toEqual(list(7));
  });

  it('the restore writes the legacy record only under the live nonce deactivate stamped, and only if nothing moved', async () => {
    const t = await setup(list(5));
    const root = await t.page(list(20), true);
    const L = await t.legacyRev();
    const restore = (nonce: string, expectLegacyRev = L) => commitCatalog(t.v, OWNER, { op: 'restore', nonce, data: list(21), expectLegacyRev });
    expect(await restore('n'.repeat(24))).toMatchObject({ ok: false, error: 'catalog_restore_refused' }); // no stamp
    const nonce = 'abcdefghijklmnopqrstuvwx';
    const stamped = { ...root, restore: { nonce, expiresAt: Date.now() + 60_000 }, seq: root.seq + 1 };
    expect(await commitCatalog(t.v, OWNER, { op: 'root', data: stamped, expectRootRev: await t.rootRev() })).toMatchObject({ ok: true });
    expect(await restore('x'.repeat(24))).toMatchObject({ ok: false, error: 'catalog_restore_refused' });
    expect(await restore(nonce, L + 5)).toMatchObject({ ok: false, error: 'catalog_legacy_moved' });
    // a legacy record moved behind every guard (raw SQL) is never overwritten, whatever rev the caller names
    t.exec(`UPDATE vault_objects SET rev = rev + 1 WHERE resource = ?`, 'vault:content.catalog');
    expect(await restore(nonce, L + 1)).toMatchObject({ ok: false, error: 'catalog_legacy_moved' });
    expect(await restore(nonce, L)).toMatchObject({ ok: false, error: 'catalog_conflict' });
    t.exec(`UPDATE vault_objects SET rev = rev - 1 WHERE resource = ?`, 'vault:content.catalog');
    expect(await commitCatalog(t.v, OWNER, { op: 'restore', nonce, data: list(21), expectLegacyRev: L }, Date.now() + 120_000)).toMatchObject({ ok: false, error: 'catalog_restore_refused' }); // expired
    expect(await restore(nonce)).toMatchObject({ ok: true, legacyRev: L + 1 });
    expect((await t.stored('content.catalog'))!.data).toEqual(list(21));
    // still paged until the root is switched off
    expect(JSON.stringify(await readVaultRecordData(t.v, OWNER, CAT))).toBe(JSON.stringify(list(20)));
  });

  it('collect tombstones only generations no root names', async () => {
    const t = await setup(list(5));
    const root = await t.page(list(30), true);
    const named = root.pages.filter((p) => p.gen).map((p) => `content.catalog.p${p.k}.g${p.gen}`);
    await commitCatalog(t.v, OWNER, { op: 'pages', writes: [{ recordType: 'content.catalog.p0.gorphan', data: [] }] });
    const out = await commitCatalog(t.v, OWNER, { op: 'collect', recordTypes: [named[0], 'content.catalog.p0.gorphan'] });
    expect(out).toMatchObject({ ok: true, collected: ['content.catalog.p0.gorphan'] });
    expect(JSON.stringify(await readVaultRecordData(t.v, OWNER, CAT))).toBe(JSON.stringify(list(30)));
  });
});

it('the interactions DO carries the identical paged-index and codec files', () => {
  for (const f of ['catalog-pages.ts', 'catalog-codec.ts']) {
    expect(readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8')).toBe(readFileSync(new URL(`../../agent-runtime/src/${f}`, import.meta.url), 'utf8'));
  }
});
