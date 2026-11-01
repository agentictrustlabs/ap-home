// THE LIBRARY INDEX, STORED IN PAGES (2026-11-01).
//
// `content.catalog` is one vault record listing every document in a Library. Every save read the whole record, expanded
// it, changed one entry and wrote the whole record back; at 3,001 entries (6.1 MB of ciphertext on the Demo Admin
// publisher) that is what ran the interactions Durable Object out of memory and what CATALOG_MAX was holding back. A
// PAGED owner keeps the same list as
//
//   content.catalog.root   { format: 'ap.catalog.paged.v1', active, pageCount: P, pages: [{k, count, hash}], total,
//                            order, folders: [...], migratedFrom?, rev, updatedAt }
//   content.catalog.p<k>   k = 0..P-1 — the document rows whose page is fnv1a32(id) mod P, in list order, compact-coded
//                          (catalog-codec.ts), so a save that touches one document reads and writes ONE page.
//
// THE ROOT BUCKET. Folder rows — and any row that is not a document (no string id or name) — stay in the root itself
// (`folders`): the effective-policy rule needs every folder on every save, and there are few of them.
//
// ORDER IS KEPT EXACTLY. `order` is one symbol per row of the assembled list — the page the row lives in (`0-9a-zA-Z-_`)
// or `~` for the root bucket. Each bucket keeps its rows in their relative list order, so the symbol sequence is the
// whole merge: the assembled array reproduces the original array, position for position (10 KB at 10,000 rows, against
// ~250 KB for a list of ids, and no field added to an entry that a reader would see).
//
// THE SWITCH IS PER OWNER. Only a root with `active: true` makes an owner paged; otherwise — no root, a prepared but
// inactive root, or a root that does not parse — the single legacy record is the catalog, exactly as before. Once an
// owner is paged the legacy record is never written by the paged path: it stays as the frozen pre-switch backup, and
// only the explicit rollback (`deactivate`) writes it again, carrying every save made since the switch back into it.
//
// PAGES ARE THE TRUTH, THE ROOT IS THEIR INDEX. A write puts the changed pages first and the root last. A write torn
// between the two leaves a page the root does not describe; assembly never drops such rows (rows past the order are
// appended, in bucket order), a page-local edit re-derives the page's order from the page it read, and a missing page
// that the root says holds rows is an ERROR, never an empty page — a partial catalog must not read as a small one.
//
// THIS FILE EXISTS TWICE (apps/agent-runtime/src and apps/vault/src), byte for byte — a test holds them equal. The vault
// service uses the read half (`readCatalog`); the interactions DO uses all of it.
import { CATALOG_RECORD, compactCatalog, expandCatalog } from './catalog-codec.js';

export const CATALOG_PAGED_FORMAT = 'ap.catalog.paged.v1';
export const CATALOG_ROOT_RECORD = 'content.catalog.root';
/**
 * PAGES PER OWNER. A constant today; the root records the count it was split with (`pageCount`) and every reader uses
 * that, so a later rebalance is a re-split under a new count (prepare → verify → activate, as for the first switch) and
 * needs no change here beyond the symbol table (64 pages at most).
 */
export const CATALOG_PAGE_COUNT = 32;
const SYMBOLS = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-_';
export const CATALOG_ROOT_BUCKET = '~';
export const CATALOG_MAX_PAGE_COUNT = SYMBOLS.length;
const PAGE_RE = /^content\.catalog\.p(\d{1,2})$/;

export const catalogPageRecord = (k: number): string => `content.catalog.p${k}`;
/** The records the paged form is made of — written only by the paged path, never by an app or a caller directly. */
export const isPagedCatalogRecord = (recordType: string): boolean => recordType === CATALOG_ROOT_RECORD || PAGE_RE.test(recordType);
export const pageOfRecord = (recordType: string): number | null => { const m = PAGE_RE.exec(recordType); return m ? Number(m[1]) : null; };

export interface CatalogPageRef { k: number; count: number; hash: string }
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
  /** What `prepare` copied: the sha256 of the legacy record's plaintext then. `activate` requires it unchanged. */
  migratedFrom?: { hash: string; total: number; at: number };
  rev: number;
  updatedAt: number;
}

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

/** The list, in its original order, from the root and its pages. Rows the order does not reach are appended, never dropped. */
export function assembleCatalog(root: Pick<CatalogRoot, 'order' | 'folders' | 'pageCount'>, pages: ReadonlyArray<readonly unknown[]>): unknown[] {
  const cursor = new Map<string, number>();
  const bucket = (sym: string): readonly unknown[] => (sym === CATALOG_ROOT_BUCKET ? root.folders : pages[SYMBOLS.indexOf(sym)] ?? []);
  const out: unknown[] = [];
  for (const sym of root.order) {
    const i = cursor.get(sym) ?? 0;
    const b = bucket(sym);
    if (i < b.length) out.push(b[i]);
    cursor.set(sym, i + 1);
  }
  for (const sym of [CATALOG_ROOT_BUCKET, ...pages.map((_, k) => symbolOf(k))]) {
    const b = bucket(sym);
    for (let i = cursor.get(sym) ?? 0; i < b.length; i++) out.push(b[i]);
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

/** JSON with sorted keys, for comparing rows by value. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
  return JSON.stringify(v) ?? 'null';
}

/** A root that parses, active or not. */
export function asCatalogRoot(raw: unknown): CatalogRoot | null {
  if (!isObj(raw) || raw.format !== CATALOG_PAGED_FORMAT) return null;
  const { pageCount, pages, order, folders } = raw;
  if (typeof pageCount !== 'number' || !Number.isInteger(pageCount) || pageCount < 1 || pageCount > CATALOG_MAX_PAGE_COUNT) return null;
  if (!Array.isArray(pages) || typeof order !== 'string' || !Array.isArray(folders)) return null;
  return raw as unknown as CatalogRoot;
}
/** The root iff it switches the owner to pages. */
export function activeCatalogRoot(raw: unknown): CatalogRoot | null {
  const root = asCatalogRoot(raw);
  return root && root.active === true ? root : null;
}

/** How many rows the root says page k holds. */
export const pageCountOf = (root: CatalogRoot, k: number): number => root.pages.find((p) => p.k === k)?.count ?? 0;

/** One stored page as plain rows. A page the root says holds rows but that is not there is an error, never empty. */
export function pageRows(root: CatalogRoot, k: number, stored: unknown): unknown[] {
  const rows = expandCatalog(stored ?? null);
  if (Array.isArray(rows)) return rows;
  if (stored === null || stored === undefined) {
    const want = pageCountOf(root, k);
    if (want === 0) return [];
    throw new Error(`the Library index page ${k} is missing (the root says it holds ${want} entries) — refusing to read a partial catalog`);
  }
  throw new Error(`the Library index page ${k} is not a list`);
}

/** Read several records at once; each answer is the record's data or null. */
export type ReadRecords = (recordTypes: string[]) => Promise<unknown[]>;
/** Pages read per round trip. */
export const PAGE_READ_BATCH = 8;

/** Every page of a root, as plain rows, `batch` records per read. */
export async function readCatalogPages(root: CatalogRoot, readMany: ReadRecords, batch: number = PAGE_READ_BATCH): Promise<unknown[][]> {
  const pages: unknown[][] = [];
  for (let k0 = 0; k0 < root.pageCount; k0 += batch) {
    const ks = Array.from({ length: Math.min(batch, root.pageCount - k0) }, (_, i) => k0 + i);
    const got = await readMany(ks.map(catalogPageRecord));
    ks.forEach((k, i) => { pages[k] = pageRows(root, k, got[i]); });
  }
  return pages;
}

/**
 * THE CATALOG AS EVERY READER SEES IT: the plain array, whichever form the owner keeps. The root is read first; an
 * active root's pages are assembled, anything else reads the legacy record (expanded) exactly as before.
 */
export async function readCatalog(readMany: ReadRecords, batch: number = PAGE_READ_BATCH): Promise<unknown> {
  const [rootRaw] = await readMany([CATALOG_ROOT_RECORD]);
  const root = activeCatalogRoot(rootRaw);
  if (!root) return expandCatalog((await readMany([CATALOG_RECORD]))[0] ?? null);
  return assembleCatalog(root, await readCatalogPages(root, readMany, batch));
}

// ── the write half (the interactions DO) ────────────────────────────────────────────────────────────────────────────

export interface PagedWrite { writes: Array<{ recordType: string; data: unknown; k: number; rows: unknown[] }>; root: CatalogRoot }

/** A fresh paged form of `list`: every page written, the root last. `prepare` uses it (inactive) and nothing else. */
export async function buildPagedCatalog(list: readonly unknown[], opts: { active: boolean; now: number; pageCount?: number; migratedFrom?: CatalogRoot['migratedFrom']; rev?: number }): Promise<PagedWrite> {
  const pageCount = opts.pageCount ?? CATALOG_PAGE_COUNT;
  const split = splitCatalog(list, pageCount);
  const refs: CatalogPageRef[] = [];
  const writes: PagedWrite['writes'] = [];
  for (let k = 0; k < pageCount; k++) {
    const rows = split.pages[k]!;
    refs.push({ k, count: rows.length, hash: await pageHash(rows) });
    writes.push({ recordType: catalogPageRecord(k), data: compactCatalog(rows), k, rows });
  }
  return {
    writes,
    root: { format: CATALOG_PAGED_FORMAT, active: opts.active, pageCount, pages: refs, total: list.length, order: split.order, folders: split.folders, ...(opts.migratedFrom ? { migratedFrom: opts.migratedFrom } : {}), rev: opts.rev ?? 1, updatedAt: opts.now },
  };
}

/** A WHOLE-LIST write onto an existing root: only the pages whose content changed are written; the root carries the rest. */
export async function planPagedWrite(list: readonly unknown[], root: CatalogRoot, now: number): Promise<PagedWrite> {
  const split = splitCatalog(list, root.pageCount);
  const refs: CatalogPageRef[] = [];
  const writes: PagedWrite['writes'] = [];
  for (let k = 0; k < root.pageCount; k++) {
    const rows = split.pages[k]!;
    const hash = await pageHash(rows);
    const before = root.pages.find((p) => p.k === k);
    refs.push({ k, count: rows.length, hash });
    if (!before || before.hash !== hash || before.count !== rows.length) writes.push({ recordType: catalogPageRecord(k), data: compactCatalog(rows), k, rows });
  }
  return { writes, root: { ...root, pages: refs, total: list.length, order: split.order, folders: split.folders, rev: (root.rev ?? 0) + 1, updatedAt: now } };
}

/** Bring a bucket's symbols in `order` to the rows it actually holds (a torn write): extra symbols go, missing ones are appended. */
function fitBucket(order: string[], sym: string, rows: number): void {
  let have = 0;
  for (const s of order) if (s === sym) have++;
  for (let i = order.length - 1; have > rows && i >= 0; i--) if (order[i] === sym) { order.splice(i, 1); have--; }
  for (; have < rows; have++) order.push(sym);
}
const nthOf = (order: readonly string[], sym: string, n: number): number => { let seen = 0; for (let i = 0; i < order.length; i++) if (order[i] === sym && seen++ === n) return i; return -1; };
const countBefore = (order: readonly string[], sym: string, end: number): number => { let c = 0; for (let i = 0; i < end; i++) if (order[i] === sym) c++; return c; };

/**
 * A PAGE-LOCAL EDIT: each upsert replaces the FIRST row with its id (where it would sit in the assembled list — the
 * legacy `findIndex` rule) in place, or is appended at the end when no row has that id. A row whose bucket changes (a
 * document re-saved as a folder) moves buckets and keeps its position. Only the pages touched are loaded and written.
 */
export async function applyCatalogEdit(root: CatalogRoot, loadPage: (k: number) => Promise<unknown[]>, upserts: readonly unknown[], now: number): Promise<PagedWrite> {
  const P = root.pageCount;
  const order = root.order.split('');
  const folders = root.folders.slice();
  fitBucket(order, CATALOG_ROOT_BUCKET, folders.length);
  const loaded = new Map<number, unknown[]>();
  const page = async (k: number): Promise<unknown[]> => {
    let rows = loaded.get(k);
    if (!rows) { rows = (await loadPage(k)).slice(); fitBucket(order, symbolOf(k), rows.length); loaded.set(k, rows); }
    return rows;
  };
  const touched = new Set<number>();
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
    const tRows = target < 0 ? folders : await page(target);
    if (target >= 0) touched.add(target);
    if (!at.length) { tRows.push(u); order.push(tSym); continue; }
    const first = at.sort((a, b) => a.pos - b.pos)[0]!;
    if (first.k === target) { tRows[first.j] = u; continue; }
    (first.k < 0 ? folders : rows).splice(first.j, 1);
    if (first.k >= 0) touched.add(first.k);
    order[first.pos] = tSym;
    tRows.splice(countBefore(order, tSym, first.pos), 0, u);
  }
  const refs = root.pages.map((p) => ({ ...p }));
  const writes: PagedWrite['writes'] = [];
  for (const k of [...touched].sort((a, b) => a - b)) {
    const rows = loaded.get(k)!;
    const hash = await pageHash(rows);
    const ref = refs.find((p) => p.k === k);
    if (ref) { ref.count = rows.length; ref.hash = hash; } else refs.push({ k, count: rows.length, hash });
    writes.push({ recordType: catalogPageRecord(k), data: compactCatalog(rows), k, rows });
  }
  refs.sort((a, b) => a.k - b.k);
  const total = folders.length + refs.reduce((n, p) => n + (loaded.get(p.k)?.length ?? p.count), 0);
  return { writes, root: { ...root, pages: refs, total, order: order.join(''), folders, rev: (root.rev ?? 0) + 1, updatedAt: now } };
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
