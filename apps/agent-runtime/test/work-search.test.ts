// Spec 400 W2 (B5) — the inverted index as a pure structure: tokens, AND-matching with prefixes, kinds and since
// filters, newest-first ties, bounded size with oldest-first eviction, replace-on-reindex.
import { describe, it, expect } from 'vitest';
import { emptyIndex, indexDoc, searchIndex, tokenize, SEARCH_MAX_DOCS } from '../src/work-search.js';

describe('work search index', () => {
  it('tokenizes words, drops stop words and short tokens, once each', () => {
    expect(tokenize('The auth refresh — the AUTH token refresh! a b cd')).toEqual(['auth', 'refresh', 'token', 'cd']);
  });
  it('finds documents where every query token matches, prefixes included, filtered by kind and since', () => {
    const idx = emptyIndex();
    indexDoc(idx, 'm1', { kind: 'message', at: '2026-03-01T00:00:00Z', snippet: '', ref: { messageId: 'm1', fromName: 'bob.me' } }, 'the auth refresh broke on the retreat plan');
    indexDoc(idx, 'm2', { kind: 'message', at: '2026-09-01T00:00:00Z', snippet: '', ref: { messageId: 'm2' } }, 'authorization refreshed yesterday');
    indexDoc(idx, 't1', { kind: 'topic', at: '2026-09-02T00:00:00Z', snippet: '', ref: { org: '0xcc', channelId: 'c1', title: 'Retreat' } }, 'who is bringing the food');
    indexDoc(idx, 'r1', { kind: 'run', at: '2026-09-03T00:00:00Z', snippet: '', ref: { runRef: 'run-1' } }, 'summarize the retreat plan');
    expect(searchIndex(idx, 'auth refresh').map((h) => h.id)).toEqual(['m1', 'm2']);   // exact scores over prefix
    expect(searchIndex(idx, 'retreat').map((h) => h.id)).toEqual(['r1', 't1', 'm1']);   // title token counts; newest first on ties
    expect(searchIndex(idx, 'retreat', { kinds: ['message'] }).map((h) => h.id)).toEqual(['m1']);
    expect(searchIndex(idx, 'retreat', { since: '2026-09-02T00:00:00Z' }).map((h) => h.id)).toEqual(['r1', 't1']);
    expect(searchIndex(idx, 'food auth')).toEqual([]);
    expect(searchIndex(idx, '')).toEqual([]);
    expect(searchIndex(idx, 'bob').map((h) => h.id)).toEqual(['m1']);   // the sender's name is searchable
    expect(searchIndex(idx, 'auth')[0]!.doc.snippet).toBe('the auth refresh broke on the retreat plan');
  });
  it('is bounded: the oldest documents leave; re-indexing an id replaces it', () => {
    const idx = emptyIndex();
    for (let i = 0; i < SEARCH_MAX_DOCS + 5; i++) indexDoc(idx, `d${i}`, { kind: 'message', at: `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}Z`, snippet: '', ref: {} }, `word${i} common`);
    expect(Object.keys(idx.docs)).toHaveLength(SEARCH_MAX_DOCS);
    expect(idx.docs.d0).toBeUndefined();
    expect(idx.postings.word0).toBeUndefined();
    indexDoc(idx, 'd5000', { kind: 'message', at: '2026-01-01T00:00:00Z', snippet: '', ref: {} }, 'replaced text');
    expect(searchIndex(idx, 'word5000')).toEqual([]);
    expect(searchIndex(idx, 'replaced').map((h) => h.id)).toEqual(['d5000']);
  });
});
