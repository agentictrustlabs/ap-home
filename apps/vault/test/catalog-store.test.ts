// THE LIBRARY INDEX AT THE VAULT (src/catalog-store.ts), against the vault's real encrypted store and SQL (node:sqlite):
// every tool returns `content.catalog` as the same plain array; the paged family is reserved; a paged owner's legacy
// record is written only by the authenticated restore; the root swap is a compare-and-set, and the switch's guarantees
// (activate only onto an identical copy, deactivate only after a restore) are enforced HERE, whatever a caller says.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { compactCatalog } from '../src/catalog-codec.js';
import { CATALOG_ROOT_RECORD, buildPagedCatalog, catalogDigest, newGeneration, planPagedWrite, type CatalogRoot } from '../src/catalog-pages.js';
import { commitCatalog, getStoredCatalogRecords, readVaultRecordData, writeVaultRecord } from '../src/catalog-store.js';
import { sqliteAvailable, sqliteVault } from './support/sqlite-vault.js';

const OWNER = '0x' + 'ab'.repeat(20);
const SIG = (i: number) => '0x51' + 'ab'.repeat(400) + i.toString(16).padStart(8, '0');
const doc = (i: number) => ({ id: `doc-${i}`, kind: 'md', name: `n${i}.md`, folder: 'x', releases: [{ releaseId: `0xr${i}`, version: '1.0.0', signature: SIG(i), signed: true }] });
const list = (n: number) => [{ id: 'f-x', name: 'x', isFolder: true }, ...Array.from({ length: n }, (_, i) => doc(i))];
const CAT = 'vault:content.catalog';
const NONCE = 'abcdefghijklmnopqrstuvwx';

async function setup(legacy: unknown[] | null) {
  const s = sqliteVault();
  const v = s.vault;
  if (legacy) expect(await writeVaultRecord(v, OWNER, 'content.catalog', compactCatalog(legacy))).toEqual({ ok: true });
  const stored = async (rt: string) => (await getStoredCatalogRecords(v, OWNER, [rt]) as { records: Record<string, { data: unknown; rev: number; deleted: boolean } | null> }).records[rt];
  const legacyRev = async () => (await stored('content.catalog'))?.rev ?? -1;
  const rootRev = async () => (await stored(CATALOG_ROOT_RECORD))?.rev ?? -1;
  const root = async () => (await stored(CATALOG_ROOT_RECORD))!.data as CatalogRoot;
  const commitRoot = async (data: CatalogRoot, extra: Record<string, unknown> = {}) => commitCatalog(v, OWNER, { op: 'root', data, expectRootRev: await rootRev(), ...extra });
  /** Prepare (pages = the legacy list) and optionally activate, exactly as the DO does. */
  const page = async (active: boolean) => {
    const l = (await readVaultRecordData(v, OWNER, CAT)) as unknown[];
    const built = await buildPagedCatalog(l, { gen: newGeneration(1), active: false, now: 1, migratedFrom: { hash: await catalogDigest(l), total: l.length, legacyRev: await legacyRev(), at: 1 } });
    if (built.pages.length) expect(await commitCatalog(v, OWNER, { op: 'pages', writes: built.pages.map((p) => ({ recordType: p.recordType, data: p.data })) })).toMatchObject({ ok: true });
    expect(await commitRoot(built.root)).toMatchObject({ ok: true });
    if (!active) return built.root;
    const L = await legacyRev();
    const on: CatalogRoot = { ...built.root, active: true, activation: { legacyRev: L, at: 2 }, seq: built.root.seq + 1 };
    expect(await commitRoot(on, { expectLegacyRev: L })).toMatchObject({ ok: true });
    return on;
  };
  /** A paged write of a whole list (what the DO's seam does). */
  const edit = async (next: unknown[]) => {
    const r = await root();
    const plan = await planPagedWrite(next, r, { gen: newGeneration(r.seq + 1), now: 3 });
    if (plan.pages.length) expect(await commitCatalog(v, OWNER, { op: 'pages', writes: plan.pages.map((p) => ({ recordType: p.recordType, data: p.data })) })).toMatchObject({ ok: true });
    expect(await commitRoot(plan.root)).toMatchObject({ ok: true });
    return plan.root;
  };
  /** Stamp a restore over the legacy record's current rev. */
  const stamp = async (fromRev?: number) => {
    const r = await root();
    const from = fromRev ?? (await legacyRev());
    return commitRoot({ ...r, restore: { nonce: NONCE, expiresAt: Date.now() + 60_000, fromRev: from, toRev: from + 1 }, seq: r.seq + 1 });
  };
  const off = async () => {
    const r = await root();
    const { restore, activation: _a, ...rest } = r;
    const L = await legacyRev();
    return commitRoot({ ...rest, active: false, migratedFrom: { hash: 'x', total: r.total, legacyRev: L, at: 9 }, seq: r.seq + 1 }, { expectLegacyRev: L });
  };
  return { ...s, v, page, edit, stamp, off, legacyRev, rootRev, root, stored, commitRoot };
}

describe.skipIf(!sqliteAvailable)('every vault tool returns the Library index as one plain array', () => {
  it('a legacy compact record is expanded; a prepared but inactive root changes nothing', async () => {
    const t = await setup(list(5));
    await t.page(false);
    await expect(readVaultRecordData(t.v, OWNER, CAT)).resolves.toEqual(list(5));
    await writeVaultRecord(t.v, OWNER, 'content.catalog', list(6));
    expect(await readVaultRecordData(t.v, OWNER, CAT)).toEqual(list(6));
  });

  it('an active owner is assembled from the pages, exactly — and the projection applies to that array', async () => {
    const t = await setup(list(30));
    await t.page(true);
    await t.edit(list(120));
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
    await t.page(true);
    await t.edit(list(50));
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

  it('a DELETED root fails reads and legacy writes, and cannot be revived through the root swap', async () => {
    const t = await setup(list(20));
    const on = await t.page(true);
    t.exec(`UPDATE vault_objects SET deleted_at = CURRENT_TIMESTAMP WHERE resource = ?`, 'vault:content.catalog.root');
    await expect(readVaultRecordData(t.v, OWNER, CAT)).rejects.toThrow(/deleted/);
    expect(await writeVaultRecord(t.v, OWNER, 'content.catalog', list(6))).toMatchObject({ ok: false, error: 'catalog_integrity' });
    expect(await commitCatalog(t.v, OWNER, { op: 'root', data: on, expectRootRev: -2 })).toMatchObject({ ok: false, error: 'catalog_integrity' });
    expect(await commitCatalog(t.v, OWNER, { op: 'root', data: { ...on, active: false }, expectRootRev: -2, expectLegacyRev: await t.legacyRev() })).toMatchObject({ ok: false, error: 'catalog_integrity' });
  });

  it('a page the root names but that is gone fails the read', async () => {
    const t = await setup(list(40));
    const root = await t.page(true);
    const k = root.pages.find((p) => p.gen)!;
    t.exec(`UPDATE vault_objects SET deleted_at = CURRENT_TIMESTAMP WHERE resource = ?`, `vault:content.catalog.p${k.k}.g${k.gen}`);
    await expect(readVaultRecordData(t.v, OWNER, CAT)).rejects.toThrow(/missing/);
  });
});

describe.skipIf(!sqliteAvailable)('set_vault_record: the paged family is reserved; the legacy record is guarded', () => {
  it('no write or tombstone of the root or a page through set_vault_record', async () => {
    const t = await setup(list(20));
    const root = await t.page(true);
    const named = `content.catalog.p${root.pages.find((p) => p.gen)!.k}.g${root.pages.find((p) => p.gen)!.gen}`;
    for (const rt of [CATALOG_ROOT_RECORD, named, 'content.catalog.p3', 'content.catalog.p3.gzzz'])
      for (const data of [{ active: false }, null]) expect(await writeVaultRecord(t.v, OWNER, rt, data)).toMatchObject({ ok: false, error: 'catalog_record_reserved' });
    expect(JSON.stringify(await readVaultRecordData(t.v, OWNER, CAT))).toBe(JSON.stringify(list(20)));
  });

  it('a legacy write (or tombstone) is refused while the owner is paged, and lands while not', async () => {
    const t = await setup(list(5));
    await t.page(true);
    expect(await writeVaultRecord(t.v, OWNER, 'content.catalog', list(6))).toMatchObject({ ok: false, error: 'catalog_paged' });
    expect(await writeVaultRecord(t.v, OWNER, 'content.catalog', null)).toMatchObject({ ok: false, error: 'catalog_paged' });
    expect(await t.legacyRev()).toBe(0);
  });

  it('a tombstone of a legacy owner\'s catalog is a tombstone (as before), not a stored null', async () => {
    const t = await setup(list(5));
    expect(await writeVaultRecord(t.v, OWNER, 'content.catalog', null)).toEqual({ ok: true });
    expect(await t.stored('content.catalog')).toMatchObject({ deleted: true });
    expect(await readVaultRecordData(t.v, OWNER, CAT)).toBeNull();
  });

  it('a legacy write whose root moved after it was checked writes nothing (one guarded statement)', async () => {
    const t = await setup(list(5));
    await t.page(false);
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

describe.skipIf(!sqliteAvailable)('catalog_commit: pages and the root swap', () => {
  it('a page generation is written once, never over anything', async () => {
    const t = await setup(list(5));
    const w = { recordType: 'content.catalog.p1.gabc', data: [doc(1)] };
    expect(await commitCatalog(t.v, OWNER, { op: 'pages', writes: [w] })).toMatchObject({ ok: true });
    expect(await commitCatalog(t.v, OWNER, { op: 'pages', writes: [{ ...w, data: [doc(2)] }] })).toMatchObject({ ok: false, error: 'catalog_page_exists' });
    expect(await commitCatalog(t.v, OWNER, { op: 'pages', writes: [{ recordType: CATALOG_ROOT_RECORD, data: [] }] })).toMatchObject({ ok: false });
  });

  it('the root swap is a compare-and-set, and never names a page that does not exist', async () => {
    const t = await setup(list(30));
    const root = await t.page(true);
    const plan = await planPagedWrite([...list(30), doc(999)], root, { gen: newGeneration(root.seq + 1), now: 3 });
    const stale = await t.rootRev();
    expect(await commitCatalog(t.v, OWNER, { op: 'root', data: plan.root, expectRootRev: stale })).toMatchObject({ ok: false, error: 'catalog_page_missing' });
    await commitCatalog(t.v, OWNER, { op: 'pages', writes: plan.pages.map((p) => ({ recordType: p.recordType, data: p.data })) });
    expect(await commitCatalog(t.v, OWNER, { op: 'root', data: plan.root, expectRootRev: stale })).toMatchObject({ ok: true });
    const other = await planPagedWrite(list(30), root, { gen: newGeneration(root.seq + 1), now: 4 });
    await commitCatalog(t.v, OWNER, { op: 'pages', writes: other.pages.map((p) => ({ recordType: p.recordType, data: p.data })) });
    expect(await commitCatalog(t.v, OWNER, { op: 'root', data: other.root, expectRootRev: stale })).toMatchObject({ ok: false, error: 'catalog_conflict' });
    expect(await readVaultRecordData(t.v, OWNER, CAT)).toEqual([...list(30), doc(999)]);
  });

  it('a first root must be inactive', async () => {
    const t = await setup(list(3));
    const built = await buildPagedCatalog(list(3), { gen: newGeneration(1), active: true, now: 1 });
    await commitCatalog(t.v, OWNER, { op: 'pages', writes: built.pages.map((p) => ({ recordType: p.recordType, data: p.data })) });
    expect(await t.commitRoot({ ...built.root, activation: { legacyRev: 0, at: 1 } }, { expectLegacyRev: 0 })).toMatchObject({ ok: false, error: 'catalog_switch_unchecked' });
  });
});

describe.skipIf(!sqliteAvailable)('the switch, enforced at the vault', () => {
  it('activate requires the legacy rev it checked — atomically — and pages identical to the legacy record', async () => {
    const t = await setup(list(5));
    const root = await t.page(false);
    const L = await t.legacyRev();
    const on = { ...root, active: true, activation: { legacyRev: L, at: 2 }, seq: root.seq + 1 };
    expect(await t.commitRoot(on)).toMatchObject({ ok: false, error: 'catalog_switch_unchecked' });
    expect(await writeVaultRecord(t.v, OWNER, 'content.catalog', list(7))).toEqual({ ok: true }); // a direct writer moves the legacy record
    expect(await t.commitRoot(on, { expectLegacyRev: L })).toMatchObject({ ok: false, error: 'catalog_conflict' });
    // the same rev check passes, but the pages are not the legacy record: refused
    const L2 = await t.legacyRev();
    expect(await t.commitRoot({ ...on, activation: { legacyRev: L2, at: 3 } }, { expectLegacyRev: L2 })).toMatchObject({ ok: false, error: 'catalog_switch_mismatch' });
    expect(await readVaultRecordData(t.v, OWNER, CAT)).toEqual(list(7));
  });

  it('PROBE: active → inactive with NO restore is refused — post-activation edits are never dropped', async () => {
    const t = await setup(list(40));
    await t.page(true);
    await t.edit([...list(40), doc(4242)]);
    expect(await t.off()).toMatchObject({ ok: false, error: 'catalog_switch_unchecked' });
    // a stamp alone (the restore never ran) is not enough either
    expect(await t.stamp()).toMatchObject({ ok: true });
    expect(await t.off()).toMatchObject({ ok: false, error: 'catalog_switch_unchecked' });
    expect((await readVaultRecordData(t.v, OWNER, CAT) as Array<{ id?: string }>).some((e) => e.id === 'doc-4242')).toBe(true);
  });

  it('a restore of the WRONG content cannot switch the owner off (the digest is checked)', async () => {
    const t = await setup(list(10));
    await t.page(true);
    await t.edit([...list(10), doc(77)]);
    const L = await t.legacyRev();
    await t.stamp();
    expect(await commitCatalog(t.v, OWNER, { op: 'restore', nonce: NONCE, data: list(10), expectLegacyRev: L })).toMatchObject({ ok: true }); // stale content
    expect(await t.off()).toMatchObject({ ok: false, error: 'catalog_switch_mismatch' });
    // a correct re-restore over the rev the first restore produced, then the switch off
    await t.stamp(L + 1);
    expect(await commitCatalog(t.v, OWNER, { op: 'restore', nonce: NONCE, data: [...list(10), doc(77)], expectLegacyRev: L + 1 })).toMatchObject({ ok: true, legacyRev: L + 2 });
    expect(await t.off()).toMatchObject({ ok: true });
    expect(await readVaultRecordData(t.v, OWNER, CAT)).toEqual([...list(10), doc(77)]);
  });

  it('a stamp may only restore over the frozen rev or the rev the previous restore produced, and is never dropped while paged', async () => {
    const t = await setup(list(10));
    const on = await t.page(true);
    const L = await t.legacyRev();
    expect(await t.stamp(L + 3)).toMatchObject({ ok: false, error: 'catalog_restore_refused' });
    expect(await t.stamp(L)).toMatchObject({ ok: true });
    const stamped = await t.root();
    expect(await t.commitRoot({ ...stamped, restore: undefined, seq: stamped.seq + 1 } as CatalogRoot)).toMatchObject({ ok: false, error: 'catalog_restore_refused' });
    expect(await t.commitRoot({ ...stamped, activation: { legacyRev: L + 1, at: 9 }, seq: stamped.seq + 1 })).toMatchObject({ ok: false, error: 'catalog_switch_unchecked' });
    void on;
  });

  it('the restore writes the legacy record only under the live nonce, over the stamp\'s rev, and only if nothing moved', async () => {
    const t = await setup(list(20));
    await t.page(true);
    await t.edit(list(21));
    const L = await t.legacyRev();
    const restore = (nonce: string, expectLegacyRev = L, now?: number) => commitCatalog(t.v, OWNER, { op: 'restore', nonce, data: list(21), expectLegacyRev }, now);
    expect(await restore(NONCE)).toMatchObject({ ok: false, error: 'catalog_restore_refused' }); // no stamp
    expect(await t.stamp()).toMatchObject({ ok: true });
    expect(await restore('x'.repeat(24))).toMatchObject({ ok: false, error: 'catalog_restore_refused' });
    expect(await restore(NONCE, L + 5)).toMatchObject({ ok: false, error: 'catalog_legacy_moved' });
    expect(await restore(NONCE, L, Date.now() + 120_000)).toMatchObject({ ok: false, error: 'catalog_restore_refused' }); // expired
    t.exec(`UPDATE vault_objects SET rev = rev + 1 WHERE resource = ?`, 'vault:content.catalog'); // moved behind every guard
    expect(await restore(NONCE)).toMatchObject({ ok: false, error: 'catalog_conflict' });
    t.exec(`UPDATE vault_objects SET rev = rev - 1 WHERE resource = ?`, 'vault:content.catalog');
    expect(await restore(NONCE)).toMatchObject({ ok: true, legacyRev: L + 1 });
    expect((await t.stored('content.catalog'))!.data).toEqual(list(21));
    expect(JSON.stringify(await readVaultRecordData(t.v, OWNER, CAT))).toBe(JSON.stringify(list(21))); // still paged
    expect(await t.off()).toMatchObject({ ok: true });
  });
});

describe.skipIf(!sqliteAvailable)('collection and the sweep', () => {
  it('collect tombstones only generations no root names', async () => {
    const t = await setup(list(30));
    const root = await t.page(true);
    const named = root.pages.filter((p) => p.gen).map((p) => `content.catalog.p${p.k}.g${p.gen}`);
    await commitCatalog(t.v, OWNER, { op: 'pages', writes: [{ recordType: 'content.catalog.p0.gorphan', data: [] }] });
    expect(await commitCatalog(t.v, OWNER, { op: 'collect', recordTypes: [named[0], 'content.catalog.p0.gorphan'] })).toMatchObject({ ok: true, collected: ['content.catalog.p0.gorphan'] });
    expect(JSON.stringify(await readVaultRecordData(t.v, OWNER, CAT))).toBe(JSON.stringify(list(30)));
  });

  it('the sweep finds every page record the current root does not name (a lost collection), and keeps prevGen', async () => {
    const t = await setup(list(30));
    await t.page(true);
    const changed = list(30).map((e) => (e.id === 'doc-5' ? { ...e, name: 'renamed.md' } : e));
    const r1 = await t.edit(changed);
    const k = r1.pages.find((p) => p.prevGen)!;
    await commitCatalog(t.v, OWNER, { op: 'pages', writes: [{ recordType: 'content.catalog.p1.gleak1', data: [doc(1)] }, { recordType: 'content.catalog.p2.gleak2', data: [] }] });
    const out = await commitCatalog(t.v, OWNER, { op: 'sweep' }) as { swept: string[] };
    expect(out.swept.sort()).toEqual(['content.catalog.p1.gleak1', 'content.catalog.p2.gleak2']);
    expect(await t.stored(`content.catalog.p${k.k}.g${k.prevGen}`)).toMatchObject({ deleted: false });
    expect(JSON.stringify(await readVaultRecordData(t.v, OWNER, CAT))).toBe(JSON.stringify(changed));
  });
});

it('the interactions DO carries the identical paged-index and codec files', () => {
  for (const f of ['catalog-pages.ts', 'catalog-codec.ts']) {
    expect(readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8')).toBe(readFileSync(new URL(`../../agent-runtime/src/${f}`, import.meta.url), 'utf8'));
  }
});
