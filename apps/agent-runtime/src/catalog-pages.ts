// THE LIBRARY INDEX, STORED IN PAGES (2026-11-01; copy-on-write since the data-safety review).
//
// `content.catalog` is one vault record listing every document in a Library. Every save read the whole record, expanded
// it, changed one entry and wrote the whole record back; at 3,001 entries (6.1 MB of ciphertext on the Demo Admin
// publisher) that is what ran the interactions Durable Object out of memory and what CATALOG_MAX was holding back. A
// PAGED owner keeps the same list as
//
//   content.catalog.root          { format: 'ap.catalog.paged.v2', active, pageCount: P, pages: [{k, gen, count, hash,
//                                   prevGen}], total, order, folders: [...], migratedFrom?, activation?, restore?, seq,
//                                   updatedAt }
//   content.catalog.p<k>.g<gen>   the document rows whose page is fnv1a32(id) mod P, in list order, compact-coded
//                                 (catalog-codec.ts). A page record is written ONCE and never overwritten.
//
// COPY-ON-WRITE. A write puts each changed page under a NEW generation name, then swaps the root — the single atomic
// commit (a compare-and-set on the root's stored rev at the vault). Until the root swaps, no reader can see the new
// pages; after it, none can see the old ones. A write torn anywhere before the swap is invisible, a row moved between a
// page and the root bucket moves in the swap, and a late write can never roll a page back under a newer root (the root
// names the generation). The generation the previous root named is kept while it is that page's `prevGen` (until the
// page's next change), then collected; a collection that is lost (an eviction between the swap and the collect) is
// found by the sweep, which tombstones every page record the current root does not name.
//
// THE ROOT BUCKET. Folder rows — and any row that is not a document (no string id or name) — stay in the root itself
// (`folders`): the effective-policy rule needs every folder on every save, and there are few of them.
//
// ORDER IS KEPT EXACTLY. `order` is one symbol per row of the assembled list — the page the row lives in (`0-9a-zA-Z-_`)
// or `~` for the root bucket. Each bucket keeps its rows in their relative list order, so the symbol sequence is the
// whole merge: the assembled array reproduces the original array, position for position.
//
// THE SWITCH IS PER OWNER, AND STRICT. No root record at all ⇒ the single legacy record is the catalog, exactly as
// before; a root that parses and is inactive ⇒ still the legacy record; an active root ⇒ the pages. A root record that
// EXISTS but does not parse, or was deleted, is an ERROR on every read and write — never a quiet return to the frozen
// legacy record. Once an owner is paged the legacy record is the frozen pre-switch backup.
//
// THIS FILE EXISTS TWICE (apps/agent-runtime/src and apps/vault/src), byte for byte — a test holds them equal.
import { CATALOG_RECORD, compactCatalog, expandCatalog } from './catalog-codec.js';

export const CATALOG_PAGED_FORMAT = 'ap.catalog.paged.v2';
export const CATALOG_ROOT_RECORD = 'content.catalog.root';
/**
 * PAGES PER OWNER. A constant today; the root records the count it was split with (`pageCount`) and every reader uses
 * that, so a later rebalance is a re-split under a new count (prepare → verify → activate) — 64 pages at most.
 */
export const CATALOG_PAGE_COUNT = 32;
const SYMBOLS = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-_';
export const CATALOG_ROOT_BUCKET = '~';
export const CATALOG_MAX_PAGE_COUNT = SYMBOLS.length;
const GEN_RE = /^[0-9a-z]{1,40}$/;
/** Every record of the paged family — the versioned pages, and the unversioned names reserved with them. */
const PAGE_RE = /^content\.catalog\.p(\d{1,2})(?:\.g([0-9a-z]{1,40}))?$/;
const VERSIONED_PAGE_RE = /^content\.catalog\.p(\d{1,2})\.g([0-9a-z]{1,40})$/;

export const catalogPageRecord = (k: number, gen: string): string => `content.catalog.p${k}.g${gen}`;
/** The records the paged form is made of — written only by the interactions DO's catalog path, never by naming them. */
export const isPagedCatalogRecord = (recordType: string): boolean => recordType === CATALOG_ROOT_RECORD || PAGE_RE.test(recordType);
export const isVersionedPageRecord = (recordType: string): boolean => VERSIONED_PAGE_RE.test(recordType);
/** A fresh generation name: the root's next sequence number and 48 random bits, so two writers never share one. */
export function newGeneration(seq: number): string {
  const r = new Uint8Array(6);
  crypto.getRandomValues(r);
  return `${Math.max(0, Math.floor(seq)).toString(36)}${[...r].map((b) => b.toString(36).padStart(2, '0')).join('')}`.slice(0, 40);
}

export interface CatalogPageRef { k: number; gen: string | null; count: number; hash: string; prevGen?: string | null }
export interface CatalogRoot {
  format: typeof CATALOG_PAGED_FORMAT;
  /** The switch. Only `true` makes the pages the catalog. */
  active: boolean;
  pageCount: number;
  pages: CatalogPageRef[];
  /** Rows in the assembled list (every bucket). */
  total: number;
  /** One symbol per assembled row: its bucket. */
  order: string;
  /** The root bucket: folder rows and any row that is not a document, in list order. */
  folders: unknown[];
  /** What `prepare` copied: the legacy record's digest and its STORED rev then. */
  migratedFrom?: { hash: string; total: number; legacyRev: number; at: number };
  /** Set by `activate`: the legacy record's stored rev at the switch. `deactivate` requires it unchanged. */
  activation?: { legacyRev: number; at: number };
  /**
   * Set by `deactivate` before it restores the legacy record: the vault accepts that write only with this nonce, only
   * over `fromRev` (the rev the switch froze, or the rev an earlier restore produced), and the write lands as `toRev`
   * (= fromRev + 1). Kept on the root until the owner is switched off, so an interrupted rollback can be resumed.
   */
  restore?: { nonce: string; expiresAt: number; fromRev: number; toRev: number };
  /** The root's own write counter (the vault's stored rev is the compare-and-set). */
  seq: number;
  updatedAt: number;
}

/** A record as the vault stores it: the decrypted value (compact or plain — never assembled), its rev, and whether it is deleted. */
export interface StoredRecord { data: unknown; rev: number; deleted: boolean }
/** What the root record says about the owner. */
export type RootState = { kind: 'legacy' } | { kind: 'inactive' | 'active'; root: CatalogRoot; rev: number };

/** The paged index is not in a state any reader may trust. Never answered as "not paged". `pageMissing`: a named page
 *  generation was not there — which a reader holding an older root can meet after two later commits collected it. */
export class CatalogIntegrityError extends Error {
  readonly pageMissing: boolean;
  constructor(message: string, opts: { pageMissing?: boolean } = {}) { super(`catalog_integrity: ${message}`); this.name = 'CatalogIntegrityError'; this.pageMissing = opts.pageMissing === true; }
}
export const isPageMissing = (e: unknown): boolean => e instanceof CatalogIntegrityError && e.pageMissing;

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

/** FNV-1a, 32-bit: stable, well spread over short ids, and the same in every runtime. */
export function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
export const pageOf = (id: string, pageCount: number = CATALOG_PAGE_COUNT): number => fnv1a32(id) % pageCount;
/** A row the pages hold: a document (string id and name, not a folder). */
export const isDocumentRow = (e: unknown): e is { id: string; name: string } => isObj(e) && typeof e.id === 'string' && typeof e.name === 'string' && e.isFolder !== true;
const symbolOf = (k: number): string => SYMBOLS[k]!;
const bucketSymbol = (e: unknown, pageCount: number): string => (isDocumentRow(e) ? symbolOf(pageOf(e.id, pageCount)) : CATALOG_ROOT_BUCKET);
/** The bucket of a row: a page number, or -1 for the root bucket. */
export const bucketOf = (e: unknown, pageCount: number = CATALOG_PAGE_COUNT): number => (isDocumentRow(e) ? pageOf(e.id, pageCount) : -1);

export interface SplitCatalog { pages: unknown[][]; folders: unknown[]; order: string }
export function splitCatalog(list: readonly unknown[], pageCount: number = CATALOG_PAGE_COUNT): SplitCatalog {
  if (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > CATALOG_MAX_PAGE_COUNT) throw new Error(`a catalog splits into 1..${CATALOG_MAX_PAGE_COUNT} pages, not ${pageCount}`);
  const pages: unknown[][] = Array.from({ length: pageCount }, () => []);
  const folders: unknown[] = [];
  let order = '';
  for (const e of list) {
    const sym = bucketSymbol(e, pageCount);
    if (sym === CATALOG_ROOT_BUCKET) folders.push(e); else pages[SYMBOLS.indexOf(sym)]!.push(e);
    order += sym;
  }
  return { pages, folders, order };
}

/** The list, in its original order, from a root and its pages (counts already checked by `pageRows`). */
export function assembleCatalog(root: Pick<CatalogRoot, 'order' | 'folders' | 'pageCount'>, pages: ReadonlyArray<readonly unknown[]>): unknown[] {
  const cursor = new Map<string, number>();
  const out: unknown[] = [];
  for (const sym of root.order) {
    const i = cursor.get(sym) ?? 0;
    const b = sym === CATALOG_ROOT_BUCKET ? root.folders : pages[SYMBOLS.indexOf(sym)] ?? [];
    if (i >= b.length) throw new CatalogIntegrityError(`the order names more rows in bucket ${sym} than it holds`);
    out.push(b[i]);
    cursor.set(sym, i + 1);
  }
  return out;
}

/** The assembled positions of one bucket's rows (bucket -1 is the root bucket). */
export function positionsOf(order: string, bucket: number): number[] {
  const sym = bucket < 0 ? CATALOG_ROOT_BUCKET : symbolOf(bucket);
  const out: number[] = [];
  for (let i = 0; i < order.length; i++) if (order[i] === sym) out.push(i);
  return out;
}

export async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  let hex = '';
  for (const b of new Uint8Array(digest)) hex += b.toString(16).padStart(2, '0');
  return hex;
}
/** A page's content hash: over the plain (expanded) rows, exactly as a reader receives them. */
export const pageHash = (rows: readonly unknown[]): Promise<string> => sha256Hex(JSON.stringify(rows));

const digestOf = async (pageCount: number, order: string, folders: readonly unknown[], hashes: readonly string[]) =>
  sha256Hex(`${CATALOG_PAGED_FORMAT}|${pageCount}|${order}|${await pageHash(folders)}|${hashes.join(',')}`);
/**
 * A DIGEST OF A WHOLE LIST without serializing it whole: the order, the root bucket and every page's hash. Any change to
 * any row changes its page's hash (or the order, or the root bucket), so two lists with the same digest are the same list.
 */
export async function catalogDigest(list: readonly unknown[], pageCount: number = CATALOG_PAGE_COUNT): Promise<string> {
  const split = splitCatalog(list, pageCount);
  const hashes: string[] = [];
  for (const rows of split.pages) hashes.push(await pageHash(rows));
  return digestOf(pageCount, split.order, split.folders, hashes);
}
/** The same digest, from a root alone (its recorded page hashes) — what the vault checks a restored legacy record against. */
export const rootDigest = (root: CatalogRoot): Promise<string> => digestOf(root.pageCount, root.order, root.folders, root.pages.map((p) => p.hash));
/** The same digest, of the list a root and its pages assemble to — computed from the pages, the list never built. */
export async function pagesDigest(root: CatalogRoot, pages: ReadonlyArray<readonly unknown[]>): Promise<string> {
  const hashes: string[] = [];
  for (let k = 0; k < root.pageCount; k++) hashes.push(await pageHash(pages[k] ?? []));
  return digestOf(root.pageCount, root.order, root.folders, hashes);
}

/** JSON with sorted keys, for comparing rows by value. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
  return JSON.stringify(v) ?? 'null';
}

/** A root, checked whole: shape, every page ref, the order against the counts. Anything else throws. */
export function parseCatalogRoot(raw: unknown): CatalogRoot {
  const bad = (why: string): never => { throw new CatalogIntegrityError(`the paged index root does not parse — ${why}`); };
  if (!isObj(raw)) return bad('not an object');
  if (raw.format !== CATALOG_PAGED_FORMAT) return bad(`format ${JSON.stringify(raw.format)}`);
  if (typeof raw.active !== 'boolean') return bad('active is not a boolean');
  const P = raw.pageCount;
  if (typeof P !== 'number' || !Number.isInteger(P) || P < 1 || P > CATALOG_MAX_PAGE_COUNT) return bad('pageCount');
  if (!Array.isArray(raw.pages) || raw.pages.length !== P) return bad('pages');
  if (typeof raw.order !== 'string' || !Array.isArray(raw.folders) || typeof raw.total !== 'number' || typeof raw.seq !== 'number') return bad('order, folders, total or seq');
  const counts = new Map<string, number>();
  for (const s of raw.order) counts.set(s, (counts.get(s) ?? 0) + 1);
  let total = raw.folders.length;
  for (const [i, p] of (raw.pages as unknown[]).entries()) {
    if (!isObj(p) || p.k !== i || typeof p.count !== 'number' || !Number.isInteger(p.count) || p.count < 0 || typeof p.hash !== 'string') return bad(`page ${i}`);
    if (p.gen !== null && (typeof p.gen !== 'string' || !GEN_RE.test(p.gen))) return bad(`page ${i} generation`);
    if (p.gen === null && p.count !== 0) return bad(`page ${i} holds rows and names no record`);
    if ((counts.get(symbolOf(i)) ?? 0) !== p.count) return bad(`page ${i}: the order says ${counts.get(symbolOf(i)) ?? 0} rows, the page ${p.count}`);
    counts.delete(symbolOf(i));
    total += p.count;
  }
  if ((counts.get(CATALOG_ROOT_BUCKET) ?? 0) !== raw.folders.length) return bad('the order and the root bucket disagree');
  counts.delete(CATALOG_ROOT_BUCKET);
  if (counts.size) return bad('the order names a bucket that does not exist');
  if (raw.total !== total || raw.order.length !== total) return bad(`total ${raw.total}, rows ${total}`);
  return raw as unknown as CatalogRoot;
}

/** The owner's state from the stored root record: no record ⇒ legacy; a deleted or unparseable one ⇒ an ERROR. */
export function rootState(rec: StoredRecord | null): RootState {
  if (!rec) return { kind: 'legacy' };
  if (rec.deleted) throw new CatalogIntegrityError('the paged index root was deleted — refusing to fall back to the legacy record');
  const root = parseCatalogRoot(rec.data);
  return { kind: root.active ? 'active' : 'inactive', root, rev: rec.rev };
}
/** The root iff it switches the owner to pages; null when there is none; throws on anything that does not parse. */
export function activeCatalogRoot(raw: unknown): CatalogRoot | null {
  if (raw === null || raw === undefined) return null;
  const root = parseCatalogRoot(raw);
  return root.active ? root : null;
}

/** The record that holds page k under this root, or null for an empty page. */
export const pageRecordOf = (root: CatalogRoot, k: number): string | null => { const g = root.pages[k]?.gen; return g ? catalogPageRecord(k, g) : null; };

/** One stored page as plain rows, checked against the root: a missing page, or one whose count differs, is an ERROR. */
export function pageRows(root: CatalogRoot, k: number, stored: unknown): unknown[] {
  const ref = root.pages[k];
  if (!ref) throw new CatalogIntegrityError(`the root has no page ${k}`);
  if (ref.gen === null) return [];
  if (stored === null || stored === undefined) throw new CatalogIntegrityError(`page ${k} (generation ${ref.gen}) is missing — refusing to read a partial catalog`, { pageMissing: true });
  const rows = expandCatalog(stored);
  if (!Array.isArray(rows)) throw new CatalogIntegrityError(`page ${k} is not a list`);
  if (rows.length !== ref.count) throw new CatalogIntegrityError(`page ${k} holds ${rows.length} rows, the root says ${ref.count}`);
  return rows;
}

/** Read several records at once, AS STORED; each answer is the record's data or null. */
export type ReadRecords = (recordTypes: string[]) => Promise<unknown[]>;
/** Pages read per round trip. */
export const PAGE_READ_BATCH = 8;

/** Every page of a root, as plain rows, `batch` records per read; empty pages are not read. */
export async function readCatalogPages(root: CatalogRoot, readMany: ReadRecords, batch: number = PAGE_READ_BATCH): Promise<unknown[][]> {
  const pages: unknown[][] = Array.from({ length: root.pageCount }, () => []);
  const ks = root.pages.filter((p) => p.gen !== null).map((p) => p.k);
  for (let i = 0; i < ks.length; i += batch) {
    const chunk = ks.slice(i, i + batch);
    const got = await readMany(chunk.map((k) => pageRecordOf(root, k)!));
    chunk.forEach((k, j) => { pages[k] = pageRows(root, k, got[j]); });
  }
  return pages;
}

/** Where a reader gets the records from. */
export interface CatalogSource {
  root(): Promise<StoredRecord | null>;
  /** The legacy record as stored (compact or plain). */
  legacy(): Promise<unknown>;
  records: ReadRecords;
}
/**
 * THE CATALOG AS EVERY READER SEES IT: the plain array, whichever form the owner keeps. No root ⇒ the legacy record
 * (expanded), an inactive root ⇒ the same, an active root ⇒ its pages assembled, anything else ⇒ an error.
 */
export async function readCatalog(src: CatalogSource, batch: number = PAGE_READ_BATCH): Promise<unknown> {
  let rec = await src.root();
  for (let attempt = 0; ; attempt++) {
    const st = rootState(rec);
    if (st.kind !== 'active') return expandCatalog((await src.legacy()) ?? null);
    try {
      return assembleCatalog(st.root, await readCatalogPages(st.root, src.records, batch));
    } catch (e) {
      // A page the root named was collected by later commits: read the root once more, and only if it moved, again.
      if (attempt > 0 || !isPageMissing(e)) throw e;
      const again = await src.root();
      if (!again || again.rev === rec?.rev) throw e;
      rec = again;
    }
  }
}

// ── the write half (the interactions DO) ────────────────────────────────────────────────────────────────────────────

export interface PagedWrite {
  /** New page records, each under a fresh generation name — written before the root, never over anything. */
  pages: Array<{ recordType: string; data: unknown; k: number; rows: unknown[] }>;
  root: CatalogRoot;
  /** Generations no root names after this one commits (the previous root's `prevGen`s): collected AFTER the root swap,
   *  best effort; anything a lost collection leaves behind is found by the sweep (`catalog_commit` op `sweep`). */
  garbage: string[];
}

/** One page's new ref, and what it writes and frees. */
async function nextRef(old: CatalogPageRef | undefined, k: number, rows: unknown[], gen: string, out: PagedWrite, force = false): Promise<CatalogPageRef> {
  const hash = await pageHash(rows);
  if (!force && old && old.hash === hash && old.count === rows.length) return old;
  const g = rows.length ? gen : null;
  if (g) out.pages.push({ recordType: catalogPageRecord(k, g), data: compactCatalog(rows), k, rows });
  if (old?.prevGen && old.prevGen !== old.gen && old.prevGen !== g) out.garbage.push(catalogPageRecord(k, old.prevGen));
  return { k, gen: g, count: rows.length, hash, prevGen: old?.gen ?? null };
}

/** A fresh paged form of `list` (prepare). Every non-empty page is written; a previous root's pages become garbage. */
export async function buildPagedCatalog(list: readonly unknown[], opts: { gen: string; active: boolean; now: number; pageCount?: number; migratedFrom?: CatalogRoot['migratedFrom']; previous?: CatalogRoot | null }): Promise<PagedWrite> {
  const pageCount = opts.pageCount ?? CATALOG_PAGE_COUNT;
  const split = splitCatalog(list, pageCount);
  const out: PagedWrite = { pages: [], root: null as unknown as CatalogRoot, garbage: [] };
  const refs: CatalogPageRef[] = [];
  for (let k = 0; k < pageCount; k++) {
    const rows = split.pages[k]!;
    const hash = await pageHash(rows);
    const gen = rows.length ? opts.gen : null;
    if (gen) out.pages.push({ recordType: catalogPageRecord(k, gen), data: compactCatalog(rows), k, rows });
    refs.push({ k, gen, count: rows.length, hash, prevGen: null });
  }
  for (const p of opts.previous?.pages ?? []) for (const g of [p.gen, p.prevGen]) if (g) out.garbage.push(catalogPageRecord(p.k, g));
  out.root = { format: CATALOG_PAGED_FORMAT, active: opts.active, pageCount, pages: refs, total: list.length, order: split.order, folders: split.folders, ...(opts.migratedFrom ? { migratedFrom: opts.migratedFrom } : {}), seq: (opts.previous?.seq ?? 0) + 1, updatedAt: opts.now };
  return out;
}

/** A WHOLE-LIST write onto an existing root: only the pages whose content changed get a new generation. */
export async function planPagedWrite(list: readonly unknown[], root: CatalogRoot, opts: { gen: string; now: number }): Promise<PagedWrite> {
  const split = splitCatalog(list, root.pageCount);
  const out: PagedWrite = { pages: [], root: null as unknown as CatalogRoot, garbage: [] };
  const refs: CatalogPageRef[] = [];
  for (let k = 0; k < root.pageCount; k++) refs.push(await nextRef(root.pages[k], k, split.pages[k]!, opts.gen, out));
  out.root = { ...root, pages: refs, total: list.length, order: split.order, folders: split.folders, seq: root.seq + 1, updatedAt: opts.now };
  return out;
}

const nthOf = (order: readonly string[], sym: string, n: number): number => { let seen = 0; for (let i = 0; i < order.length; i++) if (order[i] === sym && seen++ === n) return i; return -1; };
const countBefore = (order: readonly string[], sym: string, end: number): number => { let c = 0; for (let i = 0; i < end; i++) if (order[i] === sym) c++; return c; };

/**
 * A PAGE-LOCAL EDIT: each upsert replaces the FIRST row with its id (where it sits in the assembled list — the legacy
 * `findIndex` rule) in place, or is appended at the end when no row has that id. A row whose bucket changes (a document
 * re-saved as a folder) moves buckets and keeps its position — the page and the root change in ONE commit (the swap).
 */
export async function applyCatalogEdit(root: CatalogRoot, loadPage: (k: number) => Promise<unknown[]>, upserts: readonly unknown[], opts: { gen: string; now: number }): Promise<PagedWrite> {
  const P = root.pageCount;
  const order = root.order.split('');
  const folders = root.folders.slice();
  const loaded = new Map<number, unknown[]>();
  const page = async (k: number): Promise<unknown[]> => {
    let rows = loaded.get(k);
    if (!rows) { rows = (await loadPage(k)).slice(); loaded.set(k, rows); }
    return rows;
  };
  for (const u of upserts) {
    if (!isObj(u) || typeof u.id !== 'string' || !u.id) throw new Error('a catalog edit names each row by its id');
    const homeK = pageOf(u.id, P);
    const rows = await page(homeK);
    const at: Array<{ k: number; j: number; pos: number }> = [];
    const jf = folders.findIndex((x) => isObj(x) && x.id === u.id);
    if (jf >= 0) at.push({ k: -1, j: jf, pos: nthOf(order, CATALOG_ROOT_BUCKET, jf) });
    const jp = rows.findIndex((x) => isObj(x) && x.id === u.id);
    if (jp >= 0) at.push({ k: homeK, j: jp, pos: nthOf(order, symbolOf(homeK), jp) });
    const target = bucketOf(u, P);
    const tSym = target < 0 ? CATALOG_ROOT_BUCKET : symbolOf(target);
    const tRows = target < 0 ? folders : rows;
    if (!at.length) { tRows.push(u); order.push(tSym); continue; }
    const first = at.sort((a, b) => a.pos - b.pos)[0]!;
    if (first.k === target) { tRows[first.j] = u; continue; }
    (first.k < 0 ? folders : rows).splice(first.j, 1);
    order[first.pos] = tSym;
    tRows.splice(countBefore(order, tSym, first.pos), 0, u);
  }
  const out: PagedWrite = { pages: [], root: null as unknown as CatalogRoot, garbage: [] };
  const refs: CatalogPageRef[] = [];
  for (let k = 0; k < P; k++) {
    const rows = loaded.get(k);
    refs.push(rows ? await nextRef(root.pages[k], k, rows, opts.gen, out) : root.pages[k]!);
  }
  out.root = { ...root, pages: refs, total: order.length, order: order.join(''), folders, seq: root.seq + 1, updatedAt: opts.now };
  return out;
}

export interface CatalogMismatch { bucket: number; index: number; id: string | null; reason: string }
export interface CatalogComparison { ok: boolean; total: number; pagedTotal: number; orderExact: boolean; mismatches: CatalogMismatch[]; mismatchCount: number }

/**
 * DOES THE PAGED FORM HOLD EXACTLY `expected`? Entry by entry — canonical value and exact JSON (key order) — bucket by
 * bucket, plus the order and the count. One page is held at a time.
 */
export async function compareCatalog(expected: readonly unknown[], root: CatalogRoot, loadPage: (k: number) => Promise<unknown[]>, limit = 20): Promise<CatalogComparison> {
  const split = splitCatalog(expected, root.pageCount);
  const mismatches: CatalogMismatch[] = [];
  let count = 0;
  const miss = (m: CatalogMismatch) => { count++; if (mismatches.length < limit) mismatches.push(m); };
  const orderExact = split.order === root.order;
  if (!orderExact) miss({ bucket: -2, index: -1, id: null, reason: `order differs (${split.order.length} rows expected, ${root.order.length} in the root)` });
  let pagedTotal = root.folders.length;
  const compareBucket = async (bucket: number, want: readonly unknown[], have: readonly unknown[]) => {
    if (want.length !== have.length) miss({ bucket, index: -1, id: null, reason: `${want.length} rows expected, ${have.length} stored` });
    for (let i = 0; i < Math.max(want.length, have.length); i++) {
      const w = want[i]; const h = have[i];
      const id = isObj(w) && typeof w.id === 'string' ? w.id : isObj(h) && typeof h.id === 'string' ? h.id : null;
      if (w === undefined || h === undefined) { miss({ bucket, index: i, id, reason: w === undefined ? 'extra stored row' : 'row missing' }); continue; }
      if (await sha256Hex(canonicalJson(w)) !== await sha256Hex(canonicalJson(h))) miss({ bucket, index: i, id, reason: 'value differs' });
      else if (JSON.stringify(w) !== JSON.stringify(h)) miss({ bucket, index: i, id, reason: 'key order differs' });
    }
  };
  await compareBucket(-1, split.folders, root.folders);
  for (let k = 0; k < root.pageCount; k++) {
    const rows = await loadPage(k);
    pagedTotal += rows.length;
    await compareBucket(k, split.pages[k]!, rows);
  }
  if (root.total !== expected.length) miss({ bucket: -2, index: -1, id: null, reason: `the root counts ${root.total} rows, ${expected.length} expected` });
  return { ok: count === 0 && pagedTotal === expected.length, total: expected.length, pagedTotal, orderExact, mismatches, mismatchCount: count };
}

export { CATALOG_RECORD };
