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
import { expandCatalog } from './catalog-codec.js';
import { CATALOG_ROOT_RECORD, CatalogIntegrityError, catalogDigest, isPagedCatalogRecord, isVersionedPageRecord, parseCatalogRoot, readCatalog, rootDigest, rootState, type CatalogRoot, type StoredRecord } from './catalog-pages.js';
import { VaultRevConflictError } from './db.js';
import { VAULT_RECORD_PREFIX, type DemoVault } from './vault.js';

type Store = Pick<DemoVault, 'read' | 'write' | 'readStored' | 'writeGuarded' | 'live' | 'tombstone' | 'revOf' | 'livePrefix'>;
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
  // A tombstone stays a tombstone (as before the paged index). It is not guarded by the root, but a switch that races it
  // fails: the legacy record's version becomes "deleted", which no activation names.
  if (data === null) { await v.write({ owner, resource: CATALOG, data: null }); return { ok: true }; }
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
    if (op === 'root') return await commitRoot(v, owner, args);
    if (op === 'restore') {
      const before = await stored(v, owner, CATALOG_ROOT_RECORD);
      const state = rootState(before);
      const nonce = String(args.nonce ?? '');
      if (state.kind !== 'active') return refuse('catalog_restore_refused', 'the owner is not paged');
      const stamp = state.root.restore;
      if (!stamp || nonce.length < 16 || stamp.nonce !== nonce || !(stamp.expiresAt >= now)) return refuse('catalog_restore_refused', 'no live restore stamp matches this nonce');
      if (!isList(args.data)) return refuse('catalog_restore_refused', 'the restored index is a list');
      const expectLegacyRev = Number(args.expectLegacyRev);
      // The restore lands over exactly the rev the stamp names — the rev the switch froze, or the one an earlier
      // restore of this rollback produced (the vault accepted that stamp only on that chain). A legacy record that
      // moved any other way is reported for a manual merge, never overwritten.
      if (expectLegacyRev !== stamp.fromRev) return refuse('catalog_legacy_moved', 'the legacy record is not the one this rollback is restoring over — nothing was written');
      try {
        await v.writeGuarded(owner, CATALOG, args.data, { expectRev: stamp.fromRev, guard: { resource: ROOT, rev: state.rev } });
      } catch (e) {
        if (e instanceof VaultRevConflictError) return refuse('catalog_conflict', 'the legacy record or the root moved since the stamp — nothing was written');
        throw e;
      }
      return { ok: true, legacyRev: await v.revOf(owner, CATALOG) };
    }
    if (op === 'sweep') {
      // Every page record the CURRENT root does not name (as a generation or as the kept previous one) is a leak — a
      // collection lost to an eviction, or a commit that died before its root swap. With no root, every page is one.
      // NEVER one that may be IN FLIGHT: a generation from a sequence past the root's (a writer's pages, its root not
      // yet swapped), or one written in the last SWEEP_MIN_AGE_MS. Those wait for a later sweep.
      const state = rootState(await stored(v, owner, CATALOG_ROOT_RECORD));
      const named = new Set<string>();
      if (state.kind !== 'legacy') for (const p of state.root.pages) for (const g of [p.gen, p.prevGen]) if (g) named.add(`content.catalog.p${p.k}.g${g}`);
      const rootSeq = state.kind === 'legacy' ? -1 : state.root.seq;
      const swept: string[] = [];
      const kept: string[] = [];
      for (const row of await v.livePrefix(owner, R('content.catalog.p'))) {
        const rt = row.resource.slice(VAULT_RECORD_PREFIX.length);
        if (!isVersionedPageRecord(rt) || named.has(rt)) continue;
        const seq = generationSeq(rt);
        const age = now - Date.parse(`${row.updated_at.replace(' ', 'T')}${/Z|[+-]\d\d:?\d\d$/.test(row.updated_at) ? '' : 'Z'}`);
        if ((seq !== null && seq > rootSeq) || !(age >= SWEEP_MIN_AGE_MS)) { kept.push(rt); continue; }
        await v.tombstone(owner, row.resource);
        swept.push(rt);
      }
      return { ok: true, swept, kept };
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
    return refuse('op: pages | root | restore | collect | sweep');
  } catch (e) {
    if (e instanceof CatalogIntegrityError) return refuse('catalog_integrity', e.message);
    throw e;
  }
}

/** A sweep leaves a page record younger than this alone: it may belong to a writer whose root swap has not landed yet. */
export const SWEEP_MIN_AGE_MS = 5 * 60_000;
/** The root sequence a generation was written for (`newGeneration`: base36 seq + 12 random characters). */
export function generationSeq(recordType: string): number | null {
  const gen = /\.g([0-9a-z]+)$/.exec(recordType)?.[1];
  if (!gen || gen.length <= 12) return null;
  const n = parseInt(gen.slice(0, -12), 36);
  return Number.isFinite(n) ? n : null;
}

const sameStamp = (a: CatalogRoot['restore'], b: CatalogRoot['restore']): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * THE ROOT SWAP — a compare-and-set on the stored root, and the switch's guarantees, enforced HERE whatever the caller says:
 *
 *   no root            → only an INACTIVE root (prepare); a deleted or unparseable stored root → refused (repair by hand)
 *   inactive → active  → the activation names the legacy rev it checked; the legacy record is still at that rev (same
 *                        statement) and its digest is the new root's digest
 *   active → active    → the activation is unchanged; the restore stamp is kept, or a NEW stamp restores over the rev
 *                        the switch froze or the rev the previous stamp's restore produced, while the legacy record is
 *                        at that rev (same statement)
 *   active → inactive  → only after a restore: the stored root carries a stamp, the legacy record is at the stamp's
 *                        `toRev` (same statement), its digest is the paged catalog's, and the new root keeps the pages
 *   inactive → inactive→ a re-prepare
 */
async function commitRoot(v: Store, owner: string, args: Record<string, unknown>): Promise<CatalogResult> {
  let root: CatalogRoot;
  try { root = parseCatalogRoot(args.data); } catch (e) { return refuse('catalog_integrity', (e as Error).message); }
  const expectRootRev = Number(args.expectRootRev);
  if (!Number.isInteger(expectRootRev)) return refuse('expectRootRev required');
  const before = await stored(v, owner, CATALOG_ROOT_RECORD);
  if ((before ? before.rev : -1) !== expectRootRev) return refuse('catalog_conflict', 'the root moved since it was read');
  let prev;
  try { prev = rootState(before); } catch (e) { return refuse('catalog_integrity', `${(e as Error).message} — the stored root must be repaired by hand before it is written again`); }
  const expectLegacyRev = args.expectLegacyRev === undefined ? undefined : Number(args.expectLegacyRev);
  const legacyNow = async () => stored(v, owner, CATALOG_RECORD);
  const legacyDigest = async (rec: StoredRecord | null): Promise<string | null> => {
    if (!rec || rec.deleted) return null;
    const list = expandCatalog(rec.data);
    return Array.isArray(list) ? catalogDigest(list, root.pageCount) : null;
  };
  let guardRev: number | undefined;
  if (prev.kind === 'legacy') {
    if (root.active) return refuse('catalog_switch_unchecked', 'a first root is written inactive (prepare), then activated');
  } else if (prev.kind === 'inactive' && root.active) {
    if (expectLegacyRev === undefined || root.activation?.legacyRev !== expectLegacyRev || root.restore) return refuse('catalog_switch_unchecked', 'an activation names the legacy rev it checked, and carries no restore stamp');
    const leg = await legacyNow();
    if (!leg || leg.rev !== expectLegacyRev) return refuse('catalog_conflict', 'the legacy record moved since activate checked it');
    if (await legacyDigest(leg) !== await rootDigest(root)) return refuse('catalog_switch_mismatch', 'the pages are not the legacy record — not switching');
    guardRev = expectLegacyRev;
  } else if (prev.kind === 'active' && root.active) {
    if (JSON.stringify(root.activation ?? null) !== JSON.stringify(prev.root.activation ?? null)) return refuse('catalog_switch_unchecked', 'an active root keeps its activation');
    if (!sameStamp(root.restore, prev.root.restore)) {
      const st = root.restore;
      const allowedFrom = [prev.root.activation?.legacyRev, prev.root.restore?.toRev].filter((r): r is number => typeof r === 'number');
      if (!st || typeof st.nonce !== 'string' || st.nonce.length < 16 || !allowedFrom.includes(st.fromRev) || st.toRev !== st.fromRev + 1) {
        return refuse('catalog_restore_refused', 'a restore stamp restores over the rev the switch froze, or the rev the previous restore produced — and is never removed while the owner is paged');
      }
      guardRev = st.fromRev;
    }
  } else if (prev.kind === 'active' && !root.active) {
    const st = prev.root.restore;
    if (!st || expectLegacyRev !== st.toRev || root.migratedFrom?.legacyRev !== st.toRev || root.restore) return refuse('catalog_switch_unchecked', 'an owner is switched off only after its legacy record was restored (the stamp, its toRev, and the new root naming it)');
    const leg = await legacyNow();
    if (!leg || leg.rev !== st.toRev) return refuse('catalog_conflict', 'the legacy record is not the restored one');
    const pagedDigest = await rootDigest(prev.root);
    if (await legacyDigest(leg) !== pagedDigest || (await rootDigest(root)) !== pagedDigest) return refuse('catalog_switch_mismatch', 'the restored legacy record is not the paged catalog — the owner stays paged');
    guardRev = st.toRev;
  }
  const named = root.pages.filter((p) => p.gen).map((p) => R(`content.catalog.p${p.k}.g${p.gen}`));
  const live = await v.live(owner, named);
  const missing = named.filter((r) => !live.has(r));
  if (missing.length) return refuse('catalog_page_missing', `the root names ${missing.length} page record(s) that do not exist: ${missing.slice(0, 3).join(', ')}`);
  try {
    // …and checked AGAIN in the write's own statement: a page tombstoned between the check above and the write fails it.
    await v.writeGuarded(owner, ROOT, root, { expectRev: expectRootRev, requireLive: named, ...(guardRev !== undefined ? { guard: { resource: CATALOG, rev: guardRev } } : {}) });
  } catch (e) {
    if (e instanceof VaultRevConflictError) return refuse('catalog_conflict', guardRev !== undefined ? 'the root or the legacy record moved, or a page it names went, since they were checked' : 'the root moved, or a page it names went, since it was read');
    throw e;
  }
  return { ok: true, rev: await v.revOf(owner, ROOT) };
}
