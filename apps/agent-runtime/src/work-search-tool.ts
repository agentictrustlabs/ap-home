// SPEC 400 W2 (B5) — `person.work.search`: ONE box over the asker's own tier — their messages, their runs, and the
// topics and runs of every organization they steward (the same "readable vaults" a vault question is bounded by).
// Answered from the rebuildable DO-side indexes (`work-search.ts`), never from an engine over decrypted copies.
// A result CITES where the thing lives — a message id in a conversation, a post in a topic, a run ref — and the
// reader opens it there. Read-only; never authority.
import type { ToolSpec, ToolInvoker } from '@agenticprimitives/orchestration';
import type { SearchHit } from './work-search.js';

export const WORK_SEARCH_CAPABILITY = 'person.work.search' as const;

export const WORK_SEARCH_TOOL: ToolSpec = {
  id: WORK_SEARCH_CAPABILITY,
  answers: ['search my work', 'find where we discussed', 'search for', 'look for', 'where did we talk about', 'find the message about', 'find the run', 'search messages', 'search topics'],
  description:
    'SEARCH THE ASKER\'S OWN WORK — their messages, their runs, and the topics and runs of the organizations they '
    + 'steward — by words ("auth refresh", "retreat plan"). Use it for "search for", "find where we discussed", '
    + '"where did we talk about", "find the message about". Results name what was found and WHERE it lives (a '
    + 'conversation and message id, a topic post, a run ref). Never the public directory. Args: query (the words), '
    + 'kinds (optional: any of message · topic · run), since (optional ISO-8601 moment), limit (optional, default 20).',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The words to search for' },
      kinds: { type: 'array', items: { type: 'string', enum: ['message', 'topic', 'run'] }, description: 'Only these kinds' },
      since: { type: 'string', description: 'Only things after this ISO-8601 moment' },
      limit: { type: 'integer', description: 'At most this many (default 20, max 100)' },
    },
    required: ['query'],
  },
  establishes: 'lookup',
};

export interface WorkSearchWhere { subject: string; name?: string; why: 'self' | 'stewardship' }
export interface WorkSearchResult { id: string; kind: SearchHit['doc']['kind']; at: string; snippet: string; where: WorkSearchWhere; ref: SearchHit['doc']['ref']; score: number }

export interface WorkSearchDeps {
  /** Every vault this asker may read (self + stewardships) — the tier the search is bounded to. */
  readableVaults?: (asker: string) => Promise<WorkSearchWhere[]>;
  /** One object's index: the interactions object (messages, topics) and the task object (runs) of `subject`. */
  searchSubject?: (subject: string, query: string, opts: { kinds?: string[]; since?: string; limit?: number }) => Promise<{ hits: SearchHit[]; indexed: number }>;
}

export function workSearchInvoker(deps: WorkSearchDeps, asker: string | undefined): ToolInvoker {
  return async (_toolId, args) => {
    if (!asker) return { refused: 'a search is over the asker\'s own work, and there is no asker on this run' };
    if (!deps.readableVaults || !deps.searchSubject) return { refused: 'search is not wired on this agent' };
    const query = String(args.query ?? '').trim();
    if (!query) return { refused: 'say what to search for' };
    const kinds = Array.isArray(args.kinds) ? (args.kinds as unknown[]).filter((k): k is string => typeof k === 'string') : undefined;
    const since = typeof args.since === 'string' && !Number.isNaN(Date.parse(args.since)) ? new Date(args.since).toISOString() : undefined;
    const limit = Math.min(Math.max(Number(args.limit ?? 20) || 20, 1), 100);
    const wheres = await deps.readableVaults(asker.toLowerCase());
    const per = await Promise.all(wheres.map(async (w) => {
      const r = await deps.searchSubject!(w.subject, query, { ...(kinds?.length ? { kinds } : {}), ...(since ? { since } : {}), limit }).catch(() => ({ hits: [], indexed: 0 }));
      return { where: w, ...r };
    }));
    const results: WorkSearchResult[] = per.flatMap((p) => p.hits.map((h) => ({ id: h.id, kind: h.doc.kind, at: h.doc.at, snippet: h.doc.snippet, where: p.where, ref: h.doc.ref, score: h.score })));
    results.sort((a, b) => b.score - a.score || (b.at > a.at ? 1 : b.at < a.at ? -1 : 0));
    const top = results.slice(0, limit);
    return {
      query, count: top.length, results: top,
      searched: per.map((p) => ({ subject: p.where.subject, name: p.where.name ?? null, why: p.where.why, indexed: p.indexed })),
      note: top.length ? 'each result cites where it lives — a conversation and message, a topic post, or a run' : 'nothing in your own tier matched every word; try fewer words',
    };
  };
}
