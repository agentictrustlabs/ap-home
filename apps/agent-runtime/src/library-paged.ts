// THE LIBRARY SAVE, ONE PAGE AT A TIME (docs/design/library-paged-catalog.md).
//
// For an owner whose index is PAGED (catalog-pages.ts) a save, a visibility change or a release used to read the whole
// catalog, change one entry and write the whole catalog back — the cost that ran the interactions DO out of memory.
// Here it reads the root (folders, counts, order) and the ONE page that holds the document, runs the same pure rules
// (`upsertEntry`, `findEntries`, `effectiveAccessPolicy`, `releaseCore`) over folders + that page, writes the document's
// record first, and then asks the owner's DO to edit that page (`internal.library.catalogEdit`), which writes the page
// and then the root. The answers, the refusals and the record writes are the ones `libraryWriteHeld` gives.
//
// WHAT STILL WALKS EVERY PAGE (one at a time, holding only the matches, never the whole list):
//   · a save that names no valid id — today's rule lands it on the document already at that path, so every page is
//     looked at for one;
//   · a visibility change or a release named by `name` words rather than `id` (the match tiers are Library-wide);
//   · a release of a bundle FOLDER (its bundle root covers every document in it) and the indexer hint after a change to
//     a folder (it names up to 50 documents under it).
import type { ToolInvoker } from '@agenticprimitives/orchestration';
import { requirePersonsTurn } from './persons-turn.js';
import {
  ANNOUNCE_MAX, ID_RE, PUBLISHABLE, RECORD_WRITE_CONCURRENCY, LIBRARY_FILE_PUBLISH, LIBRARY_FILE_SAVE, LIBRARY_FILE_VISIBILITY,
  catalogView, effectiveAccessPolicy, findEntries, indexOnly, isEntry, pathOf, recordOf, releaseCore, upsertEntry,
  type LibraryAccessPolicy, type LibraryEntry, type LibraryRelease, type LibraryToolDeps,
} from './library-tools.js';
import { CATALOG_ROOT_RECORD, activeCatalogRoot, pageOf, pageRecordOf, pageRows, positionsOf, type CatalogRoot } from './catalog-pages.js';

/** How many documents a PAGED Library indexes. The legacy single record stays at CATALOG_MAX (its size is the limit). */
export const PAGED_CATALOG_MAX = 10_000;

/** The paged index as the runtime reaches it: a status-bearing read of the root or a page, and the DO's page edit. */
export interface CatalogStore {
  read(owner: string, recordType: string): Promise<{ ok: boolean; data: unknown; error?: string }>;
  edit(owner: string, upserts: LibraryEntry[], operationId?: string): Promise<{ ok: boolean; error?: string }>;
}

/** The owner's ACTIVE root, or null (legacy). A root read that FAILED is an error — never "not paged". */
export async function pagedRootOf(deps: Pick<LibraryToolDeps, 'catalogStore' | 'readSubjectRecordStatus' | 'readSubjectRecord'>, owner: string): Promise<CatalogRoot | null> {
  if (deps.catalogStore) {
    const r = await deps.catalogStore.read(owner, CATALOG_ROOT_RECORD);
    if (!r.ok) throw new Error(`the Library index could not be read (${r.error ?? 'the read failed'}) — nothing was saved; try again`);
    return activeCatalogRoot(r.data);
  }
  if (deps.readSubjectRecordStatus) {
    const r = await deps.readSubjectRecordStatus(owner, CATALOG_ROOT_RECORD);
    if (!r.ok) throw new Error(`the Library index could not be read (${r.error ?? 'the read failed'}) — nothing was saved; try again`);
    return activeCatalogRoot(r.data);
  }
  return activeCatalogRoot(await deps.readSubjectRecord(owner, CATALOG_ROOT_RECORD).catch(() => null));
}

/** A row with where it sits in the assembled list. */
interface Placed { e: LibraryEntry; pos: number }

export async function libraryWritePaged(deps: LibraryToolDeps, owner: string, toolId: string, args: Record<string, unknown>, ctx: Parameters<ToolInvoker>[2], root: CatalogRoot): Promise<Record<string, unknown>> {
  const store = deps.catalogStore!;
  const write = deps.writeSubjectRecord!;
  const P = root.pageCount;
  const folders = root.folders.filter(isEntry) as LibraryEntry[];
  const folderPos = positionsOf(root.order, -1);
  const placedFolders: Placed[] = root.folders.map((e, j) => ({ e: e as LibraryEntry, pos: folderPos[j] ?? Number.MAX_SAFE_INTEGER })).filter((x) => isEntry(x.e));
  const page = async (k: number): Promise<LibraryEntry[]> => {
    const name = pageRecordOf(root, k);
    if (!name) return [];
    const r = await store.read(owner, name);
    if (!r.ok) throw new Error(`the Library index page ${k} could not be read (${r.error ?? 'the read failed'}) — nothing was saved; try again`);
    return pageRows(root, k, r.data).filter(isEntry) as LibraryEntry[];
  };
  const placedPage = async (k: number): Promise<Placed[]> => {
    const pos = positionsOf(root.order, k);
    return (await page(k)).map((e, j) => ({ e, pos: pos[j] ?? Number.MAX_SAFE_INTEGER - 1 }));
  };
  /** Every page in turn; `visit` keeps what it needs and the page is let go. */
  const scan = async (visit: (rows: Placed[], k: number) => void): Promise<void> => { for (let k = 0; k < P; k++) visit(await placedPage(k), k); };

  /** Records first (the document's, and any older row in the page still carrying bytes inline), then the page edit. */
  const commit = async (rows: LibraryEntry[], entry: LibraryEntry | undefined, opts: { resave?: boolean; recordForEntry?: boolean } = {}) => {
    const withRecord = (e: LibraryEntry) => !e.isFolder && ((e === entry && opts.recordForEntry !== false) || typeof e.bytesB64 === 'string');
    const carrying = [...(entry && !rows.includes(entry) ? [entry] : []), ...rows].filter(withRecord);
    const upserts = indexOnly([...(entry ? [entry] : []), ...carrying.filter((e) => e !== entry)]);
    const edit = async () => {
      const out = await store.edit(owner, upserts, ctx.operationId);
      if (!out.ok) throw new Error(out.error ?? 'the Library index could not be written');
    };
    // A RE-SAVE of a document the index already names, with nothing older to migrate: its record and the index side by
    // side, exactly as the whole-list path does it.
    if (entry && opts.resave && carrying.length === 1 && carrying[0] === entry) {
      const [rec] = await Promise.all([write(owner, `content.artifact.${entry.id}`, recordOf(entry), ctx.operationId), edit()]);
      if (!rec.ok) throw new Error(rec.error ?? `the record of ${pathOf(entry)} could not be written`);
      return;
    }
    for (let i = 0; i < carrying.length; i += RECORD_WRITE_CONCURRENCY) {
      await Promise.all(carrying.slice(i, i + RECORD_WRITE_CONCURRENCY).map(async (e) => {
        const rec = await write(owner, `content.artifact.${e.id}`, recordOf(e), ctx.operationId);
        if (!rec.ok) throw new Error(rec.error ?? `the record of ${pathOf(e)} could not be written`);
      }));
    }
    await edit();
  };

  /** The indexer hint: the document, or (a folder) up to ANNOUNCE_MAX documents under it in list order. */
  const announce = async (entry: LibraryEntry): Promise<void> => {
    if (!deps.announce) return;
    let ids = [entry.id];
    if (entry.isFolder) {
      const under: Placed[] = [];
      const path = pathOf(entry);
      await scan((rows) => { for (const r of rows) if ((r.e.folder ?? '') === path || (r.e.folder ?? '').startsWith(`${path}/`)) under.push(r); });
      ids = under.sort((a, b) => a.pos - b.pos).slice(0, ANNOUNCE_MAX).map((r) => r.e.id);
    }
    await Promise.all(ids.map((id) => deps.announce!(owner, id).catch(() => undefined)));
  };

  /** `findEntries` over the whole Library, a page at a time: the best match TIER wins Library-wide, in list order. */
  const find = async (): Promise<{ entry: LibraryEntry; rows: LibraryEntry[] }> => {
    const q = { ...(typeof args.id === 'string' ? { id: args.id } : {}), ...(typeof args.name === 'string' ? { name: args.name } : {}), ...(typeof args.folder === 'string' ? { folder: args.folder } : {}) };
    let matches: Placed[];
    if (q.id) {
      const k = pageOf(q.id, P);
      const placed = [...placedFolders, ...(await placedPage(k))];
      const hit = new Set(findEntries(placed.map((x) => x.e), q));
      matches = placed.filter((x) => hit.has(x.e));
    } else {
      const name = (q.name ?? '').trim().toLowerCase();
      const tierOf = (e: LibraryEntry): number => (e.name.toLowerCase() === name || pathOf(e).toLowerCase() === name ? 0 : e.name.toLowerCase().includes(name) ? 1 : 2);
      let best = 3;
      let kept: Placed[] = [];
      const take = (placed: Placed[]) => {
        const hit = new Set(findEntries(placed.map((x) => x.e), q));
        if (!hit.size) return;
        const got = placed.filter((x) => hit.has(x.e));
        const tier = tierOf(got[0]!.e);
        if (tier < best) { best = tier; kept = got; } else if (tier === best) kept.push(...got);
      };
      take(placedFolders);
      await scan((rows) => take(rows));
      matches = kept;
    }
    matches.sort((a, b) => a.pos - b.pos);
    if (!matches.length) throw new Error(`no document named "${String(args.name ?? args.id ?? '')}" in the Library`);
    if (matches.length > 1) throw new Error(`${matches.length} documents match — which one? ${matches.slice(0, 8).map((m) => pathOf(m.e)).join(' · ')}`);
    const entry = matches[0]!.e;
    // The rows the edit works over: the folders and the matched document's own page, read fresh.
    const rows = entry.isFolder ? [...folders] : [...folders, ...(await page(pageOf(entry.id, P)))];
    const same = rows.find((e) => e.id === entry.id && pathOf(e) === pathOf(entry)) ?? rows.find((e) => e.id === entry.id);
    if (!same) throw new Error(`${pathOf(entry)} changed while it was being saved — try again`);
    return { entry: same, rows };
  };

  const capCheck = (adding: number) => {
    if (root.total + adding > PAGED_CATALOG_MAX) throw new Error(`your Library holds ${root.total + adding} documents, the most it indexes (${PAGED_CATALOG_MAX}) — remove some before saving more`);
  };

  if (toolId === LIBRARY_FILE_SAVE) {
    requirePersonsTurn({ ctx, toolId, what: `save ${String(args.name ?? 'a document')} to the Library` });
    const name = String(args.name ?? '').trim().slice(0, 120);
    if (!name) throw new Error('a document needs a name');
    const folder = typeof args.folder === 'string' ? args.folder.replace(/^\/+|\/+$/g, '').slice(0, 256) : '';
    const isFolder = args.isFolder === true;
    // The id `upsertEntry` will use: the caller's when well-formed, else the document already at that path (the newest;
    // the first in list order among equals), else a fresh one.
    let id: string | undefined = typeof args.id === 'string' && ID_RE.test(args.id) ? args.id : undefined;
    if (!id) {
      const atPath: Placed[] = [];
      const visit = (rows: Placed[]) => { for (const r of rows) if (r.e.name === name && (r.e.folder ?? '') === folder && !!r.e.isFolder === isFolder) atPath.push(r); };
      visit(placedFolders);
      if (!isFolder) await scan(visit);
      id = atPath.sort((x, y) => (y.e.createdAt ?? 0) - (x.e.createdAt ?? 0) || x.pos - y.pos)[0]?.e.id;
    }
    const rows: LibraryEntry[] = [...folders, ...(id ? await page(pageOf(id, P)) : [])];
    const existed = typeof args.id === 'string' && rows.some((e) => e.id === args.id && !e.isFolder);
    const before = id ? rows.some((e) => e.id === id) : false;
    // A found id that is not well-formed (an entry from before the rule) is passed as no id: `upsertEntry` lands on the
    // same document by path, which sits in these rows.
    const entry = await upsertEntry(rows, { ...args, ...(id && ID_RE.test(id) ? { id } : {}) });
    if (!before) capCheck(1); else capCheck(0);
    // A document minted just now has a page of its own to migrate inline bytes from.
    const own = !entry.isFolder && !id ? await page(pageOf(entry.id, P)) : [];
    await commit([...rows.filter((e) => e !== entry), ...own], entry, { resave: existed });
    if (effectiveAccessPolicy(rows, entry) === 'public' || args.accessPolicy !== undefined) await announce(entry);
    return { saved: true, owner, file: catalogView(entry), effectiveAccessPolicy: effectiveAccessPolicy(rows, entry), answer: `Saved ${pathOf(entry)}${entry.isFolder ? ' (a folder)' : ` — version ${entry.version}`}${effectiveAccessPolicy(rows, entry) === 'public' ? ', public' : ''}.` };
  }
  if (toolId === LIBRARY_FILE_VISIBILITY) {
    const policy = args.accessPolicy === 'public' || args.accessPolicy === 'private' ? (args.accessPolicy as LibraryAccessPolicy) : null;
    if (!policy) throw new Error('accessPolicy must be "public" or "private"');
    requirePersonsTurn({ ctx, toolId, what: `make ${String(args.name ?? args.id ?? 'a document')} ${policy}` });
    const { entry, rows } = await find();
    capCheck(0);
    entry.accessPolicy = policy;
    // The document's record is written only when the entry carries its bytes: an index entry has none, and writing
    // `recordOf(entry)` over the record would erase the body it holds.
    await commit(rows.filter((e) => e !== entry), entry, { recordForEntry: typeof entry.bytesB64 === 'string' });
    await announce(entry);
    return { declared: true, owner, file: catalogView(entry), effectiveAccessPolicy: effectiveAccessPolicy(rows, entry), answer: `${pathOf(entry)} is now ${policy}${entry.isFolder ? ' — and so is everything under it that says nothing else' : ''}.` };
  }
  if (toolId === LIBRARY_FILE_PUBLISH) {
    requirePersonsTurn({ ctx, toolId, what: `publish a release of ${String(args.name ?? args.id ?? 'a document')}` });
    const { entry, rows } = await find();
    if (!PUBLISHABLE.has(entry.kind) && !entry.isFolder) throw new Error('only a skill, a page (md, json-ld) or a bundle folder can be published as a release');
    if (!entry.isFolder && !entry.contentCommitment) throw new Error('a page with no content cannot be published — a release names what it serves');
    capCheck(0);
    // A bundle folder's root covers every document directly in it, wherever its page.
    let bundle: LibraryEntry[] = rows;
    if (entry.isFolder) {
      const inFolder: Placed[] = [];
      await scan((placed) => { for (const r of placed) if (r.e.folder === pathOf(entry) && r.e.contentCommitment) inFolder.push(r); });
      bundle = inFolder.sort((a, b) => a.pos - b.pos).map((r) => r.e);
    }
    const core = releaseCore(entry, bundle, owner);
    const signature = deps.signAsOwner ? await deps.signAsOwner(owner, core.releaseId as `0x${string}`).catch(() => null) : null;
    if (!signature) throw new Error('your agent cannot sign as you right now — its session leaf has expired or was never issued. Open your Home once (it refreshes the leaf), then publish again');
    const release: LibraryRelease = { ...core, signature, signed: true, publishedAt: Date.now() };
    entry.releases = [...(entry.releases ?? []), release];
    await commit(rows.filter((e) => e !== entry), entry, { recordForEntry: typeof entry.bytesB64 === 'string' });
    await announce(entry);
    return { published: true, owner, file: catalogView(entry), release, answer: `Released ${pathOf(entry)} ${release.version}, signed as the owner — release ${release.releaseId.slice(0, 14)}…` };
  }
  throw new Error(`${toolId} is not a Library act`);
}
