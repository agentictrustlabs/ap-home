// THE LIBRARY INDEX AT THE VAULT (docs/design/library-paged-catalog.md) — the record semantics every vault tool applies to
// `content.catalog` and its paged form, separated from authentication so they can be tested against a real store.
//
//   READ    `content.catalog` is returned as the plain array whatever its form: the legacy record expanded (compact
//           codec), or — when the owner's root is active — the pages assembled. A root that exists but is deleted or
//           does not parse is an ERROR, never a quiet return to the frozen legacy record. A field projection applies to
//           the assembled array, never to the stored shape.
//   WRITE   the paged family (`content.catalog.root`, `content.catalog.p<k>[.g<gen>]`) is RESERVED: no ordinary write or
//           tombstone reaches it. A write of the legacy record is refused while the owner is paged (`catalog_paged`),
//           and otherwise lands only if the root has not moved since it was checked (one guarded statement).
//   COMMIT  `catalog_commit` — on the service-MAC `/tools/*` path only, called by the interactions DO — writes new page
//           generations (never over anything), swaps the root by compare-and-set (a switch also requires the legacy
//           record's stored rev, in the same statement), restores the legacy record under the nonce `deactivate`
//           stamped into the root, and collects page generations no root names.
import { projectFields } from '@agenticprimitives/vault';
import { CATALOG_RECORD } from './catalog-codec.js';
import { CATALOG_ROOT_RECORD, CatalogIntegrityError, isPagedCatalogRecord, isVersionedPageRecord, parseCatalogRoot, readCatalog, rootState, type CatalogRoot, type StoredRecord } from './catalog-pages.js';
import { VaultRevConflictError } from './db.js';
import { VAULT_RECORD_PREFIX, type DemoVault } from './vault.js';

type Store = Pick<DemoVault, 'read' | 'write' | 'readStored' | 'writeGuarded' | 'live' | 'tombstone' | 'revOf'>;
export type CatalogResult = ({ ok: true } & Record<string, unknown>) | { ok: false; error: string; detail?: string };

const R = (recordType: string): string => `${VAULT_RECORD_PREFIX}${recordType}`;
const CATALOG = R(CATALOG_RECORD);
const ROOT = R(CATALOG_ROOT_RECORD);
const refuse = (error: string, detail?: string): CatalogResult => ({ ok: false, error, ...(detail ? { detail } : {}) });
const isList = (v: unknown): boolean => Array.isArray(v) || (!!v && typeof v === 'object' && Array.isArray((v as { entries?: unknown }).entries));

async function stored(v: Store, owner: string, recordType: string): Promise<StoredRecord | null> {
  return v.readStored(owner, R(recordType));
}
const liveData = async (v: Store, owner: string, recordType: string): Promise<unknown> => {
  const r = await stored(v, owner, recordType);
  return r && !r.deleted ? r.data : null;
};

/** ONE READ of a record's data, as every tool returns it. Throws CatalogIntegrityError on a broken paged index. */
export async function readVaultRecordData(v: Store, owner: string, resource: string, fields?: string[]): Promise<unknown> {
  if (resource !== CATALOG) {
    const obj = await v.read({ owner, resource, ...(fields ? { fields } : {}) });
    return obj?.data ?? null;
  }
  const data = await readCatalog({
    root: () => stored(v, owner, CATALOG_ROOT_RECORD),
    legacy: () => liveData(v, owner, CATALOG_RECORD),
    records: (rts) => Promise.all(rts.map((rt) => liveData(v, owner, rt))),
  });
  return projectFields(data ?? null, fields);
}

/** AN ORDINARY WRITE (set_vault_record): the paged family is reserved; the legacy record is guarded by the switch. */
export async function writeVaultRecord(v: Store, owner: string, recordType: string, data: unknown): Promise<CatalogResult> {
  const resource = R(recordType);
  if (isPagedCatalogRecord(recordType)) return refuse('catalog_record_reserved', `${recordType} is part of the paged Library index — only the owner's interactions object writes it`);
  if (recordType !== CATALOG_RECORD) { await v.write({ owner, resource, data }); return { ok: true }; }
  const rootRec = await stored(v, owner, CATALOG_ROOT_RECORD);
  let state;
  try { state = rootState(rootRec); } catch (e) { return refuse('catalog_integrity', (e as Error).message); }
  if (state.kind === 'active') return refuse('catalog_paged', "this Library index is stored in pages — write it through the owner's interactions object, never as the single legacy record");
  try {
    await v.writeGuarded(owner, CATALOG, data, { guard: { resource: ROOT, rev: rootRec ? rootRec.rev : -1 } });
  } catch (e) {
    if (e instanceof VaultRevConflictError) return refuse('catalog_switched', 'the Library index changed form while this write was in flight — read it again and retry');
    throw e;
  }
  return { ok: true };
}

/** The legacy record, the root and pages AS STORED, with their versions (`get_catalog_records`). */
export async function getStoredCatalogRecords(v: Store, owner: string, recordTypes: readonly string[]): Promise<CatalogResult> {
  if (!recordTypes.length || recordTypes.length > 64) return refuse('recordTypes: 1..64');
  if (recordTypes.some((rt) => rt !== CATALOG_RECORD && !isPagedCatalogRecord(rt))) return refuse('catalog records only (content.catalog, its root and its pages)');
  const records: Record<string, StoredRecord | null> = {};
  for (const rt of recordTypes) records[rt] = await stored(v, owner, rt);
  return { ok: true, records };
}

/** THE PAGED INDEX'S OWN WRITES (`catalog_commit`). */
export async function commitCatalog(v: Store, owner: string, args: Record<string, unknown>, now: number = Date.now()): Promise<CatalogResult> {
  const op = String(args.op ?? '');
  try {
    if (op === 'pages') {
      // New generations only: a page record is written once, never over anything (expect absent).
      const writes = Array.isArray(args.writes) ? (args.writes as Array<{ recordType?: unknown; data?: unknown }>) : [];
      if (!writes.length || writes.length > 64) return refuse('writes: 1..64 page records');
      for (const w of writes) if (typeof w.recordType !== 'string' || !isVersionedPageRecord(w.recordType) || !isList(w.data)) return refuse('a page write names a versioned page record and carries a list');
      for (const w of writes) {
        try { await v.writeGuarded(owner, R(w.recordType as string), w.data, { expectRev: -1 }); } catch (e) {
          if (e instanceof VaultRevConflictError) return refuse('catalog_page_exists', `${String(w.recordType)} already exists — a page generation is written once`);
          throw e;
        }
      }
      return { ok: true, written: writes.length };
    }
    if (op === 'root') {
      let root: CatalogRoot;
      try { root = parseCatalogRoot(args.data); } catch (e) { return refuse('catalog_integrity', (e as Error).message); }
      const expectRootRev = Number(args.expectRootRev);
      if (!Number.isInteger(expectRootRev)) return refuse('expectRootRev required');
      const before = await stored(v, owner, CATALOG_ROOT_RECORD);
      if ((before ? before.rev : -1) !== expectRootRev) return refuse('catalog_conflict', 'the root moved since it was read');
      let wasActive = true; // a stored root that does not parse is treated as active: any change of state then needs the legacy check
      try { wasActive = rootState(before).kind === 'active'; } catch { /* stays true */ }
      const transition = wasActive !== root.active;
      const expectLegacyRev = args.expectLegacyRev === undefined ? undefined : Number(args.expectLegacyRev);
      if (transition) {
        if (expectLegacyRev === undefined || !Number.isInteger(expectLegacyRev)) return refuse('catalog_switch_unchecked', 'switching an owner on or off names the legacy record version it checked');
        if (root.active && root.activation?.legacyRev !== expectLegacyRev) return refuse('catalog_switch_unchecked', 'the activation names a different legacy version');
        if (!root.active && root.migratedFrom?.legacyRev !== expectLegacyRev) return refuse('catalog_switch_unchecked', 'the deactivation names a different legacy version');
      }
      const named = root.pages.filter((p) => p.gen).map((p) => R(`content.catalog.p${p.k}.g${p.gen}`));
      const live = await v.live(owner, named);
      const missing = named.filter((r) => !live.has(r));
      if (missing.length) return refuse('catalog_page_missing', `the root names ${missing.length} page record(s) that do not exist: ${missing.slice(0, 3).join(', ')}`);
      try {
        await v.writeGuarded(owner, ROOT, root, { expectRev: expectRootRev, ...(transition ? { guard: { resource: CATALOG, rev: expectLegacyRev! } } : {}) });
      } catch (e) {
        if (e instanceof VaultRevConflictError) return refuse('catalog_conflict', transition ? 'the root or the legacy record moved since they were checked' : 'the root moved since it was read');
        throw e;
      }
      return { ok: true, rev: await v.revOf(owner, ROOT) };
    }
    if (op === 'restore') {
      const before = await stored(v, owner, CATALOG_ROOT_RECORD);
      const state = rootState(before);
      const nonce = String(args.nonce ?? '');
      if (state.kind !== 'active') return refuse('catalog_restore_refused', 'the owner is not paged');
      const stamp = state.root.restore;
      if (!stamp || nonce.length < 16 || stamp.nonce !== nonce || !(stamp.expiresAt >= now)) return refuse('catalog_restore_refused', 'no live restore stamp matches this nonce');
      if (!isList(args.data)) return refuse('catalog_restore_refused', 'the restored index is a list');
      const expectLegacyRev = Number(args.expectLegacyRev);
      if (!Number.isInteger(expectLegacyRev)) return refuse('expectLegacyRev required');
      // The frozen record must be exactly what the switch left: a legacy record that moved while paged is reported for a
      // manual merge, never overwritten.
      if (state.root.activation?.legacyRev !== expectLegacyRev) return refuse('catalog_legacy_moved', 'the legacy record is not the one the switch froze — nothing was written');
      try {
        await v.writeGuarded(owner, CATALOG, args.data, { expectRev: expectLegacyRev, guard: { resource: ROOT, rev: state.rev } });
      } catch (e) {
        if (e instanceof VaultRevConflictError) return refuse('catalog_conflict', 'the legacy record or the root moved since deactivate checked them — nothing was written');
        throw e;
      }
      return { ok: true, legacyRev: await v.revOf(owner, CATALOG) };
    }
    if (op === 'collect') {
      const rts = Array.isArray(args.recordTypes) ? (args.recordTypes as unknown[]).filter((r): r is string => typeof r === 'string') : [];
      const state = rootState(await stored(v, owner, CATALOG_ROOT_RECORD));
      const named = new Set<string>();
      if (state.kind !== 'legacy') for (const p of state.root.pages) for (const g of [p.gen, p.prevGen]) if (g) named.add(`content.catalog.p${p.k}.g${g}`);
      const collected: string[] = [];
      for (const rt of rts) if (isVersionedPageRecord(rt) && !named.has(rt)) { await v.tombstone(owner, R(rt)); collected.push(rt); }
      return { ok: true, collected };
    }
    return refuse('op: pages | root | restore | collect');
  } catch (e) {
    if (e instanceof CatalogIntegrityError) return refuse('catalog_integrity', e.message);
    throw e;
  }
}
