// SPEC 400 W2 (B5) — SEARCH OVER YOUR OWN WORK. "auth refresh from six months ago": one box over the person's own tier —
// their messages, the topics of the organizations they steward, their runs — answered from a DO-SIDE INVERTED INDEX
// that is a REBUILDABLE PROJECTION (ADR-0055: wiped = rebuilt from the records, never a bereavement). No engine ever
// holds a decrypted copy of a vault (spec 356): the index keeps tokens, ids and a short snippet, built at the moment
// each record is admitted or written by the object that owns it, and a result CITES the record (a message id, a
// topic post, a run ref) — the reader opens the record where it lives.
//
// What the index is NOT: a search over anything the asker may not read. It lives on the asker's own object and on
// the objects of organizations they steward; a member's search reads only those. Never authority.
export interface SearchDocV1 {
  /** `message` (a DM, mine or theirs) · `topic` (a post in an organization's topic) · `run` (a harness run). */
  kind: 'message' | 'topic' | 'run';
  /** When it happened (ISO). */
  at: string;
  /** A short clip of the text, for the result line. */
  snippet: string;
  /** Where it lives — what a result cites. */
  ref: { conversationId?: string; messageId?: string; org?: string; channelId?: string; runRef?: string; from?: string; fromName?: string; title?: string };
}

export interface SearchIndexV1 {
  v: 1;
  docs: Record<string, SearchDocV1>;
  postings: Record<string, string[]>;
  /** Insertion order, oldest first — what eviction walks. */
  order: string[];
}

export const SEARCH_INDEX_KEY = 'search.index';
export const SEARCH_MAX_DOCS = 4000;
export const SEARCH_MAX_TOKENS_PER_DOC = 80;
export const SEARCH_SNIPPET = 160;

const STOP = new Set(['the', 'and', 'for', 'that', 'this', 'with', 'you', 'are', 'was', 'not', 'but', 'have', 'has', 'from', 'your', 'our', 'its', 'can', 'will', 'what', 'who', 'how', 'when', 'where', 'why', 'did', 'does', 'is', 'it', 'to', 'of', 'in', 'on', 'at', 'by', 'an', 'a', 'be', 'as', 'or', 'we', 'me', 'my', 'i']);

/** Lower-cased word tokens, ≥ 2 chars, stop words dropped, each once, bounded. */
export function tokenize(text: string, max = SEARCH_MAX_TOKENS_PER_DOC): string[] {
  const out: string[] = []; const seen = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    const t = raw.trim();
    if (t.length < 2 || STOP.has(t) || seen.has(t)) continue;
    seen.add(t); out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

export const emptyIndex = (): SearchIndexV1 => ({ v: 1, docs: {}, postings: {}, order: [] });

/** Add (or replace) one document. Bounded: the oldest documents leave when the index is full. */
export function indexDoc(idx: SearchIndexV1, id: string, doc: SearchDocV1, text: string): SearchIndexV1 {
  if (idx.docs[id]) removeDoc(idx, id);
  const tokens = tokenize(`${doc.ref.title ?? ''} ${doc.ref.fromName ?? ''} ${text}`);
  idx.docs[id] = { ...doc, snippet: text.replace(/\s+/g, ' ').trim().slice(0, SEARCH_SNIPPET) };
  idx.order.push(id);
  for (const t of tokens) (idx.postings[t] ??= []).push(id);
  while (idx.order.length > SEARCH_MAX_DOCS) removeDoc(idx, idx.order[0]!);
  return idx;
}

export function removeDoc(idx: SearchIndexV1, id: string): void {
  if (!idx.docs[id]) return;
  delete idx.docs[id];
  idx.order = idx.order.filter((x) => x !== id);
  for (const t of Object.keys(idx.postings)) {
    const rest = idx.postings[t]!.filter((x) => x !== id);
    if (rest.length) idx.postings[t] = rest; else delete idx.postings[t];
  }
}

export interface SearchHit { id: string; score: number; doc: SearchDocV1 }

/** Every query token must match (a token matches a posting equal to it, or one it is a prefix of); newer wins ties. */
export function searchIndex(idx: SearchIndexV1, query: string, opts: { kinds?: SearchDocV1['kind'][]; since?: string; limit?: number } = {}): SearchHit[] {
  const q = tokenize(query, 12);
  if (!q.length) return [];
  const postingKeys = Object.keys(idx.postings);
  const perToken = q.map((t) => {
    const ids = new Map<string, number>();
    for (const k of postingKeys) {
      if (k === t) for (const id of idx.postings[k]!) ids.set(id, (ids.get(id) ?? 0) + 2);
      else if (k.startsWith(t) && t.length >= 3) for (const id of idx.postings[k]!) ids.set(id, (ids.get(id) ?? 0) + 1);
    }
    return ids;
  });
  const first = perToken[0]!;
  const hits: SearchHit[] = [];
  for (const [id, s0] of first) {
    let score = s0; let all = true;
    for (let i = 1; i < perToken.length; i++) { const s = perToken[i]!.get(id); if (!s) { all = false; break; } score += s; }
    if (!all) continue;
    const doc = idx.docs[id]; if (!doc) continue;
    if (opts.kinds?.length && !opts.kinds.includes(doc.kind)) continue;
    if (opts.since && doc.at < opts.since) continue;
    hits.push({ id, score, doc });
  }
  hits.sort((a, b) => b.score - a.score || (b.doc.at > a.doc.at ? 1 : b.doc.at < a.doc.at ? -1 : 0));
  return hits.slice(0, Math.min(Math.max(opts.limit ?? 20, 1), 100));
}
