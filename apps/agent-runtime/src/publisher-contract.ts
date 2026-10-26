// THE PERSON AS A PUBLISHER — the publisher contract (the scripture-indexed publishing spec) answered by the owner's
// agent over the owner's Library: `publisher.describe`, `works`, `items`, `at-verse`, `near`, `changes`. The same
// envelope the scripture publisher and a content publishing server answer with — item, scripture references,
// location, publisher, release, access, licence — so a reader merges what a person holds with what publishers hold
// without a shape of its own for each.
//
// TWO LANES, ONE READ. The public lane (a stranger, no credential) sees only what the owner marked public — the shelf
// (spec 412), exactly as `library.public.*` serves it: unknown and not-public are one answer. The private lane (the
// owner's own agent, under her session or the ask-as-me wire an app holds for her) reads the whole Library: her
// highlights, notes, bookmarks and saved places are hers to see, and hers alone.
//
// WHAT IS INDEXED is any JSON-LD document that carries scripture references or a location, read as the document
// says it, never by what app wrote it: a `@graph` of records with `aboutPassage` (a Seed reader's chapter bucket —
// seed:Highlight, seed:Annotation, seed:Bookmark, seed:Save), a GeoJSON FeatureCollection whose features carry
// `references` (the `features` work type every publisher shares), or one record with `references`. A reference the
// person made is method `person`, confidence 1 — her word about her own note. Bounded: a Library past the document
// cap is indexed to the cap and says so.
import type { ToolSpec } from '@agenticprimitives/orchestration';
import { decodeLibraryText, effectiveAccessPolicy, rawCatalogOf, type LibraryEntry, type LibraryToolDeps } from './library-tools.js';

export const PUBLISHER_DESCRIBE = 'publisher.describe' as const;
export const PUBLISHER_WORKS = 'publisher.works' as const;
export const PUBLISHER_ITEMS = 'publisher.items' as const;
export const PUBLISHER_AT_VERSE = 'publisher.at-verse' as const;
export const PUBLISHER_NEAR = 'publisher.near' as const;
export const PUBLISHER_CHANGES = 'publisher.changes' as const;
export const PUBLISHER_READ_SKILLS = [PUBLISHER_DESCRIBE, PUBLISHER_WORKS, PUBLISHER_ITEMS, PUBLISHER_AT_VERSE, PUBLISHER_NEAR, PUBLISHER_CHANGES] as const;
export type PublisherSkillId = (typeof PUBLISHER_READ_SKILLS)[number];
export const isPublisherSkill = (id: unknown): id is PublisherSkillId => (PUBLISHER_READ_SKILLS as readonly string[]).includes(String(id));

export type Lane = 'public' | 'private';

/** How many documents one Library index reads; past it the index says `truncated`. */
export const INDEX_DOCS_MAX = 300;
/** One document's text, at most, as read into the index. */
const DOC_TEXT_MAX = 400_000;
/** A verse range expands to at most this many verses. */
const RANGE_MAX = 200;
const MAX_PAGE = 200;
/** An index is kept this long per owner and lane while the catalog is unchanged. */
const INDEX_TTL_MS = 60_000;

export const PUBLISHER_TOOLS: ToolSpec[] = [
  {
    id: PUBLISHER_DESCRIBE,
    answers: ['what do I publish', 'describe me as a publisher', 'what works do I hold'],
    description: 'DESCRIBES the addressee as a publisher under the publisher contract: the kinds of works in their Library that carry scripture references or a location, the reference relations indexed, how many items are located and their bounds, and the lanes (public: what the owner marked public; private: all of it, the owner only). Args: none.',
    inputSchema: { type: 'object', properties: {} },
    establishes: 'lookup',
  },
  {
    id: PUBLISHER_WORKS,
    answers: ['list my works', 'what have I written about Scripture', 'my scripture notes as works'],
    description: 'LISTS the addressee\'s works under the publisher contract: each collection of marks (highlights, notes, bookmarks, saves) and each document with scripture references or a location, with its kind, item count, lane and release. `kind` narrows. Args: kind.',
    inputSchema: { type: 'object', properties: { kind: { type: 'string' } } },
    establishes: 'lookup',
  },
  {
    id: PUBLISHER_ITEMS,
    answers: ['the items of my work', 'everything in my highlights'],
    description: 'READS a work\'s items in the contract envelope (item, scripture references, location, publisher, release, access, licence), paged. Args: work, cursor, limit (≤ 200).',
    inputSchema: { type: 'object', properties: { work: { type: 'string' }, cursor: { type: 'string' }, limit: { type: 'integer' } }, required: ['work'] },
    establishes: 'lookup',
  },
  {
    id: PUBLISHER_AT_VERSE,
    answers: ['what did I note at this verse', 'my highlights in this chapter', 'what do I hold at John 3:16'],
    description: 'EVERYTHING the addressee holds at a verse (`verse`: John.3.16, JHN.3.16 or John 3:16) or across a chapter (`span`: John.3), each with its scripture reference (relation, confidence, method); narrow by `relation` (annotates, locates, …) or `kind` (highlight, note, bookmark, save, feature). Paged. Args: verse or span; relation, kind, cursor, limit.',
    inputSchema: { type: 'object', properties: { verse: { type: 'string' }, span: { type: 'string' }, relation: { type: 'string' }, kind: { type: 'string' }, cursor: { type: 'string' }, limit: { type: 'integer' } } },
    establishes: 'lookup',
  },
  {
    id: PUBLISHER_NEAR,
    answers: ['my places near here', 'what did I save around Jerusalem'],
    description: 'The addressee\'s located items inside `bbox` [west, south, east, north] or within `radiusKm` of `point` [lon, lat]. Args: bbox, or point + radiusKm; limit.',
    inputSchema: { type: 'object', properties: { bbox: { type: 'array', items: { type: 'number' } }, point: { type: 'array', items: { type: 'number' } }, radiusKm: { type: 'number' }, limit: { type: 'integer' } } },
    establishes: 'lookup',
  },
  {
    id: PUBLISHER_CHANGES,
    answers: ['what changed in my works', 'what did I publish lately'],
    description: 'The addressee\'s works saved or released since `since` (ms since the epoch), oldest first, with the next `cursor` — for a registry or a cache that follows this publisher. Args: since, limit.',
    inputSchema: { type: 'object', properties: { since: { type: 'number' }, limit: { type: 'integer' } } },
    establishes: 'lookup',
  },
];

// ── scripture references ────────────────────────────────────────────────────────────────────────────────────────────
/** OSIS book codes in canon order, and the USFM code each Seed reader record names the same book by. */
const OSIS = ['Gen', 'Exod', 'Lev', 'Num', 'Deut', 'Josh', 'Judg', 'Ruth', '1Sam', '2Sam', '1Kgs', '2Kgs', '1Chr', '2Chr', 'Ezra', 'Neh', 'Esth', 'Job', 'Ps', 'Prov', 'Eccl', 'Song', 'Isa', 'Jer', 'Lam', 'Ezek', 'Dan', 'Hos', 'Joel', 'Amos', 'Obad', 'Jonah', 'Mic', 'Nah', 'Hab', 'Zeph', 'Hag', 'Zech', 'Mal', 'Matt', 'Mark', 'Luke', 'John', 'Acts', 'Rom', '1Cor', '2Cor', 'Gal', 'Eph', 'Phil', 'Col', '1Thess', '2Thess', '1Tim', '2Tim', 'Titus', 'Phlm', 'Heb', 'Jas', '1Pet', '2Pet', '1John', '2John', '3John', 'Jude', 'Rev'];
const USFM = ['GEN', 'EXO', 'LEV', 'NUM', 'DEU', 'JOS', 'JDG', 'RUT', '1SA', '2SA', '1KI', '2KI', '1CH', '2CH', 'EZR', 'NEH', 'EST', 'JOB', 'PSA', 'PRO', 'ECC', 'SNG', 'ISA', 'JER', 'LAM', 'EZK', 'DAN', 'HOS', 'JOL', 'AMO', 'OBA', 'JON', 'MIC', 'NAM', 'HAB', 'ZEP', 'HAG', 'ZEC', 'MAL', 'MAT', 'MRK', 'LUK', 'JHN', 'ACT', 'ROM', '1CO', '2CO', 'GAL', 'EPH', 'PHP', 'COL', '1TH', '2TH', '1TI', '2TI', 'TIT', 'PHM', 'HEB', 'JAS', '1PE', '2PE', '1JN', '2JN', '3JN', 'JUD', 'REV'];
const BOOK_BY_TOKEN = new Map<string, string>();
OSIS.forEach((o, i) => { BOOK_BY_TOKEN.set(o.toLowerCase(), o); BOOK_BY_TOKEN.set(USFM[i]!.toLowerCase(), o); });

/** A book token (OSIS `John`, USFM `JHN`, either case) as OSIS, or null. */
export const osisBook = (token: string): string | null => BOOK_BY_TOKEN.get(token.trim().toLowerCase()) ?? null;

/** One place in Scripture as OSIS: `John.3`, `John.3.16`. */
interface Locus { book: string; chapter: number; verse?: number }
const locusOf = (s: string): Locus | null => {
  const m = /^([1-3]?[A-Za-z]{2,6})[.\s](\d{1,3})(?:[.:](\d{1,3}))?$/.exec(s.trim());
  const book = m ? osisBook(m[1]!) : null;
  if (!m || !book) return null;
  return { book, chapter: Number(m[2]), ...(m[3] ? { verse: Number(m[3]) } : {}) };
};
const osisOf = (l: Locus) => `${l.book}.${l.chapter}${l.verse !== undefined ? `.${l.verse}` : ''}`;

/** A reference as written (`JHN.3.16`, `John.3.16-John.3.18`, `JHN.3`) as the OSIS loci it names, verses of a range
 *  spelled out; a form that is not Scripture names nothing. */
export function lociOf(ref: string): string[] {
  const [a, b] = ref.split('-').map((s) => s.trim());
  const from = a ? locusOf(a) : null;
  if (!from) return [];
  const to = b ? locusOf(b) : null;
  if (!to || to.book !== from.book || from.verse === undefined || to.verse === undefined || to.chapter !== from.chapter || to.verse < from.verse) return [osisOf(from)];
  const out: string[] = [];
  for (let v = from.verse; v <= to.verse && out.length < RANGE_MAX; v++) out.push(osisOf({ book: from.book, chapter: from.chapter, verse: v }));
  return out;
}

export interface Reference { to: string; relation: string; confidence: number; method: string; basis?: string }
export interface Location { geometry: { type: string; coordinates: unknown }; bounds: [number, number, number, number]; identification?: Record<string, unknown> }

interface Indexed {
  id: string;
  kind: string;
  name: string;
  data: Record<string, unknown>;
  references: Reference[];
  location: Location | null;
  doc: LibraryEntry;
  work: string;
}
interface Index {
  owner: string;
  lane: Lane;
  items: Indexed[];
  docs: LibraryEntry[];
  truncated: boolean;
  builtAt: number;
  fingerprint: string;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const localName = (type: unknown): string => str(Array.isArray(type) ? type[0] : type).replace(/^.*[:#/]/, '').toLowerCase();

/** The reader's mark kinds: the local name of the type, as the reader's own ontology spells it. */
const MARK_KINDS: Record<string, string> = { highlight: 'highlight', annotation: 'note', bookmark: 'bookmark', save: 'save', savedplace: 'feature', readingposition: '', readingevent: '' };

function geometryBounds(g: { type: string; coordinates: unknown }): [number, number, number, number] | null {
  let w = 180, s = 90, e = -180, n = -90, any = false;
  const walk = (c: unknown) => {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === 'number' && typeof c[1] === 'number') { any = true; w = Math.min(w, c[0]); e = Math.max(e, c[0]); s = Math.min(s, c[1]); n = Math.max(n, c[1]); return; }
    for (const x of c) walk(x);
  };
  walk(g.coordinates);
  return any ? [w, s, e, n] : null;
}

function locationOf(rec: Record<string, unknown>): Location | null {
  const g = (rec.geometry ?? rec.placeLocation ?? (rec.location as Record<string, unknown> | undefined)?.geometry) as { type?: unknown; coordinates?: unknown } | undefined;
  if (!g || typeof g.type !== 'string' || g.coordinates === undefined) return null;
  const bounds = geometryBounds(g as { type: string; coordinates: unknown });
  if (!bounds) return null;
  const identification = rec.identification && typeof rec.identification === 'object' ? (rec.identification as Record<string, unknown>) : undefined;
  return { geometry: g as { type: string; coordinates: unknown }, bounds, ...(identification ? { identification } : {}) };
}

/** The references a record names: `references[]` as the contract spells them, and `aboutPassage` as a mark names it. */
function referencesOf(rec: Record<string, unknown>, located: boolean): Reference[] {
  const out: Reference[] = [];
  const listed = Array.isArray(rec.references) ? rec.references : [];
  for (const r of listed) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const relation = str(o.relation) || (located ? 'locates' : 'annotates');
    const confidence = typeof o.confidence === 'number' ? Math.max(0, Math.min(1, o.confidence)) : 1;
    const method = str(o.method) || 'person';
    for (const to of lociOf(str(o.osis) || str(o.to))) out.push({ to, relation, confidence, method, ...(str(o.basis) ? { basis: str(o.basis) } : {}) });
  }
  const about = str(rec.aboutPassage);
  if (about) for (const to of lociOf(about)) out.push({ to, relation: located ? 'locates' : 'annotates', confidence: 1, method: 'person' });
  return out;
}

function nameOf(rec: Record<string, unknown>, kind: string, fallback: string): string {
  const props = rec.properties && typeof rec.properties === 'object' ? (rec.properties as Record<string, unknown>) : {};
  return str(rec.name) || str(props.name) || str(rec.note) || str(rec.bookmarkName) || str(rec.label) || str(rec.title) || (kind === 'highlight' ? str(rec.aboutPassage) : '') || fallback;
}

/** One record (a mark, a feature, a document with references) as an item, or null when it names no verse and no place. */
function itemOf(rec: Record<string, unknown>, doc: LibraryEntry, work: string, ordinal: number): Indexed | null {
  if (rec.deleted === true) return null;
  const props = rec.properties && typeof rec.properties === 'object' ? (rec.properties as Record<string, unknown>) : null;
  const location = locationOf(rec) ?? (props ? locationOf(props) : null);
  const typeName = localName(rec['@type'] ?? rec.type);
  const kind = typeName in MARK_KINDS ? MARK_KINDS[typeName]! : typeName === 'feature' || location ? 'feature' : typeName || 'record';
  if (!kind) return null;
  const references = referencesOf(props ? { ...props, ...rec, references: props.references ?? rec.references } : rec, !!location);
  if (!references.length && !location) return null;
  const id = str(rec['@id']) || str(rec.id) || `${doc.id}#${ordinal}`;
  const { bytesB64: _b, ...data } = rec as Record<string, unknown> & { bytesB64?: unknown };
  return { id, kind, name: nameOf(props ? { ...rec, ...props } : rec, kind, id), data, references, location, doc, work };
}

const pathOf = (e: LibraryEntry) => (e.folder ? `${e.folder}/${e.name}` : e.name);
/** A Seed reader's chapter bucket (`seed-bible/<collection>/<BOOK>/<n>.jsonld`) belongs to its collection's work; any
 *  other document is a work of its own, named by its path. */
const workOf = (owner: string, e: LibraryEntry): string => {
  const m = /^(seed-bible\/[^/]+)\//.exec(e.folder ?? '');
  return `${owner}/${m ? m[1] : pathOf(e)}`;
};
const isJsonLd = (e: LibraryEntry) => !e.isFolder && (e.kind === 'json-ld' || /json/.test(e.contentType ?? '') || /\.(jsonld|json|geojson)$/i.test(e.name));

const indexes = new Map<string, Index>();

/** Every item the owner holds on the lane, read from the Library once per minute while the catalog is unchanged. */
export async function indexOf(deps: LibraryToolDeps, owner: string, lane: Lane): Promise<Index> {
  const all = await rawCatalogOf(deps, owner);
  const docs = all.filter((e) => isJsonLd(e) && (lane === 'private' || effectiveAccessPolicy(all, e) === 'public')).sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  const fingerprint = docs.map((e) => `${e.id}:${e.version ?? 0}:${e.contentCommitment ?? ''}`).join('|');
  const key = `${owner}|${lane}`;
  const kept = indexes.get(key);
  if (kept && kept.fingerprint === fingerprint && Date.now() - kept.builtAt < INDEX_TTL_MS) return kept;
  const read = docs.slice(0, INDEX_DOCS_MAX);
  const items: Indexed[] = [];
  for (const doc of read) {
    const rec = (await deps.readSubjectRecord(owner, `content.artifact.${doc.id}`).catch(() => null)) as LibraryEntry | null;
    const body = rec?.bytesB64 ?? doc.bytesB64;
    if (!body) continue;
    let json: unknown;
    try { json = JSON.parse(decodeLibraryText(body).slice(0, DOC_TEXT_MAX)); } catch { continue; }
    if (!json || typeof json !== 'object') continue;
    const j = json as Record<string, unknown>;
    const work = workOf(owner, doc);
    const records: unknown[] = Array.isArray(j['@graph']) ? j['@graph'] : Array.isArray(j.features) ? j.features : [j];
    records.forEach((r, i) => { if (r && typeof r === 'object') { const it = itemOf(r as Record<string, unknown>, doc, work, i); if (it) items.push(it); } });
  }
  const index: Index = { owner, lane, items, docs: read, truncated: docs.length > read.length, builtAt: Date.now(), fingerprint };
  indexes.set(key, index);
  return index;
}

const releaseOf = (e: LibraryEntry) => e.releases?.[e.releases.length - 1];
const licenseOf = (doc: LibraryEntry, data: Record<string, unknown>): string => str(data.license) || (doc.accessPolicy === 'public' ? 'all-rights-reserved' : 'private');

function envelope(ix: Index, it: Indexed, onlyIn?: (to: string) => boolean) {
  const r = releaseOf(it.doc);
  const access = effectiveAccessPolicy(ix.docs, it.doc) === 'public' ? 'public' : 'private';
  return {
    item: { kind: it.kind, id: it.id, name: it.name, path: pathOf(it.doc), ...it.data },
    references: onlyIn ? it.references.filter((x) => onlyIn(x.to)) : it.references,
    location: it.location,
    publisher: { address: ix.owner, kind: 'person' },
    release: { work: it.work, version: String(it.doc.version ?? 1), ...(r ? { releaseId: r.releaseId, releaseVersion: r.version } : {}), signatureStatus: r?.signed ? 'signed' : 'unsigned' },
    access,
    license: licenseOf(it.doc, it.data),
    attribution: ix.owner,
  };
}

interface WorkView { work: string; title: string; kind: string; items: number; located: number; documents: number; access: Lane; version: string; signatureStatus: string; changedAt: number }

function worksOf(ix: Index): WorkView[] {
  const byWork = new Map<string, WorkView & { kinds: Set<string> }>();
  for (const doc of ix.docs) {
    const work = workOf(ix.owner, doc);
    const w = byWork.get(work) ?? byWork.set(work, { work, title: work.slice(ix.owner.length + 1), kind: 'records', items: 0, located: 0, documents: 0, access: effectiveAccessPolicy(ix.docs, doc) === 'public' ? 'public' : 'private', version: '0', signatureStatus: 'unsigned', changedAt: 0, kinds: new Set() }).get(work)!;
    w.documents++;
    w.changedAt = Math.max(w.changedAt, doc.createdAt ?? 0);
    w.version = String(Math.max(Number(w.version), doc.version ?? 1));
    if (releaseOf(doc)?.signed) w.signatureStatus = 'signed';
  }
  for (const it of ix.items) {
    const w = byWork.get(it.work);
    if (!w) continue;
    w.items++;
    if (it.location) w.located++;
    w.kinds.add(it.kind);
  }
  return [...byWork.values()].filter((w) => w.items > 0).map(({ kinds, ...w }) => ({ ...w, kind: [...kinds].every((k) => k === 'feature') ? 'features' : [...kinds].every((k) => ['highlight', 'note', 'bookmark', 'save'].includes(k)) ? 'marks' : 'records' })).sort((a, b) => b.changedAt - a.changedAt);
}

const page = (args: Record<string, unknown>) => ({
  limit: Math.min(MAX_PAGE, Math.max(1, Number(args.limit ?? 50) || 50)),
  offset: Math.max(0, Number(args.cursor ?? 0) || 0),
});
const paged = <T>(items: T[], args: Record<string, unknown>) => {
  const { limit, offset } = page(args);
  return { items: items.slice(offset, offset + limit), count: items.length, ...(items.length > offset + limit ? { cursor: String(offset + limit) } : {}) };
};

/** A refusal the asker can act on, carried as `refused` (the harness's and the public lane's shape). */
const refused = (why: string) => ({ ok: false, refused: why, answer: why });

/**
 * One contract read over the owner's Library on a lane. Pure of transport: the public lane and the harness call it alike.
 */
export async function publisherRead(deps: LibraryToolDeps, owner: string, lane: Lane, skill: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!isPublisherSkill(skill)) return refused(`${skill} is not a publisher capability`);
  const ix = await indexOf(deps, owner, lane);
  const note = ix.truncated ? { truncated: true, note: `the Library holds more than ${INDEX_DOCS_MAX} documents; the newest ${INDEX_DOCS_MAX} are indexed` } : {};
  switch (skill) {
    case PUBLISHER_DESCRIBE: {
      const works = worksOf(ix);
      const located = ix.items.filter((i) => i.location);
      const bounds = located.reduce<[number, number, number, number]>((a, i) => [Math.min(a[0], i.location!.bounds[0]), Math.min(a[1], i.location!.bounds[1]), Math.max(a[2], i.location!.bounds[2]), Math.max(a[3], i.location!.bounds[3])], [180, 90, -180, -90]);
      const kinds = [...new Set(works.map((w) => w.kind))].map((kind) => ({ kind, works: works.filter((w) => w.kind === kind).length }));
      return {
        ok: true,
        publisher: { address: owner, kind: 'person', profile: 'person-publisher' },
        lane,
        lanes: lane === 'private' ? ['public', 'private'] : ['public'],
        kinds,
        relations: [...new Set(ix.items.flatMap((i) => i.references.map((r) => r.relation)))].sort(),
        located: { items: located.length, ...(located.length ? { bounds } : {}) },
        skills: [...PUBLISHER_READ_SKILLS],
        works,
        ...note,
        answer: works.length ? `${works.length} work(s), ${ix.items.length} item(s) with scripture references, ${located.length} located.` : lane === 'public' ? 'Nothing on the public shelf carries scripture references or a location.' : 'Nothing in the Library carries scripture references or a location yet.',
      };
    }
    case PUBLISHER_WORKS: {
      const kind = str(args.kind);
      const works = worksOf(ix).filter((w) => !kind || w.kind === kind);
      return { ok: true, lane, works, ...note, answer: works.length ? works.map((w) => `${w.title} (${w.kind}, ${w.items} items, ${w.access})`).join('\n') : 'No works.' };
    }
    case PUBLISHER_ITEMS: {
      const work = str(args.work);
      if (!work) return refused('work is required (publisher.works lists them)');
      const full = work.startsWith(`${owner}/`) ? work : `${owner}/${work}`;
      if (!worksOf(ix).some((w) => w.work === full)) return refused(`${work} is not a work of this publisher`);
      const items = ix.items.filter((i) => i.work === full).map((i) => envelope(ix, i));
      return { ok: true, lane, work: full, ...paged(items, args), ...note };
    }
    case PUBLISHER_AT_VERSE: {
      const relation = str(args.relation) || null;
      const kind = str(args.kind) || null;
      const span = str(args.span);
      const verse = str(args.verse ?? args.reference);
      let scope: { span: string } | { verse: string };
      if (span) {
        const l = locusOf(span);
        if (!l || l.verse !== undefined) return refused('span is a whole chapter (John.3 or JHN.3)');
        scope = { span: osisOf(l) };
      } else {
        const l = verse ? locusOf(verse) : null;
        if (!l || l.verse === undefined) return refused('verse (John.3.16, JHN.3.16 or John 3:16) or span (John.3) is required');
        scope = { verse: osisOf(l) };
      }
      // A verse ask matches the verse; a chapter ask matches its verses and marks made on the chapter itself.
      const inScope = 'verse' in scope ? (to: string) => to === scope.verse : (to: string) => to === scope.span || to.startsWith(`${scope.span}.`);
      const hits = ix.items.filter((i) => (!kind || i.kind === kind) && i.references.some((r) => inScope(r.to) && (!relation || r.relation === relation)));
      const items = hits.map((i) => envelope(ix, i, (to) => inScope(to)));
      return { ok: true, lane, ...scope, ...paged(items, args), ...note, answer: items.length ? `${items.length} item(s) at ${'verse' in scope ? scope.verse : scope.span}.` : `Nothing at ${'verse' in scope ? scope.verse : scope.span}.` };
    }
    case PUBLISHER_NEAR: {
      let box: number[] | null = null;
      if (Array.isArray(args.bbox) && args.bbox.length === 4 && args.bbox.every((x) => typeof x === 'number')) box = args.bbox as number[];
      else if (Array.isArray(args.point) && typeof args.radiusKm === 'number') {
        const [lon, lat] = args.point as number[];
        const dLat = args.radiusKm / 111;
        const dLon = dLat / Math.max(0.1, Math.cos(((lat ?? 0) * Math.PI) / 180));
        box = [lon! - dLon, lat! - dLat, lon! + dLon, lat! + dLat];
      }
      if (!box || !(box[0]! <= box[2]! && box[1]! <= box[3]!)) return refused('bbox [west, south, east, north] or point [lon, lat] with radiusKm is required');
      const { limit } = page(args);
      const items = ix.items.filter((i) => i.location && i.location.bounds[2] >= box![0]! && i.location.bounds[0] <= box![2]! && i.location.bounds[3] >= box![1]! && i.location.bounds[1] <= box![3]!).slice(0, limit).map((i) => envelope(ix, i));
      return { ok: true, lane, bbox: box, items, count: items.length, ...note };
    }
    case PUBLISHER_CHANGES: {
      const since = Number(args.since ?? 0) || 0;
      const { limit } = page(args);
      const rows = worksOf(ix).filter((w) => w.changedAt > since).sort((a, b) => a.changedAt - b.changedAt).slice(0, limit);
      return { ok: true, lane, changes: rows.map((w) => ({ work: w.work, title: w.title, kind: w.kind, version: Number(w.version), change: 'published', at: w.changedAt })), cursor: String(rows.length ? rows[rows.length - 1]!.changedAt : since) };
    }
  }
}
