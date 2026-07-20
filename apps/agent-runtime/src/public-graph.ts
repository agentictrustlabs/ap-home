// A GENERIC, read-only SPARQL query capability the org agent may compose during a coordination turn
// to reason over PUBLIC reference data (spec 334 §6 gather phase). Domain-agnostic by construction:
// this module knows nothing about any specific ontology or app — the QUERY is authored by the model
// (guided by the org's playbook, which is where domain vocabulary belongs), and the endpoint is
// deploy config (`PUBLIC_GRAPH_URL`). No app-specific code lives here.
//
// The data is public, so the risk is not disclosure but ABUSE of the shared triplestore: an
// LLM-authored query could mutate the store, federate out (SSRF), or exhaust its heap. Every one of
// those is refused or bounded HERE, at the tool boundary, before the endpoint is touched.
import type { ToolSpec } from '@agenticprimitives/orchestration';

/** The env this capability needs — a public SPARQL endpoint and (optionally) its Basic credential.
 *  Absent URL ⇒ the capability is simply not offered (the turn degrades to no reference data). */
export interface PublicGraphEnv {
  PUBLIC_GRAPH_URL?: string;
  PUBLIC_GRAPH_BASIC?: string;
}

export const PUBLIC_GRAPH_MAX_QUERY_CHARS = 4000;
export const PUBLIC_GRAPH_MAX_ROWS = 100;
export const PUBLIC_GRAPH_TIMEOUT_MS = 8000;

/** SPARQL Update / management verbs — a read tool must refuse every one (the endpoint may be
 *  read-only, but the tool never RELIES on that: fail-closed here). Word-bounded so a value like
 *  "?dropRate" or a label containing "load" is not a false positive. */
const MUTATION_VERBS =
  /\b(INSERT|DELETE|DROP|CLEAR|CREATE|LOAD|ADD|MOVE|COPY|WITH)\b/i;
/** Federation — an LLM-authored SERVICE clause is an SSRF vector (the triplestore fetches an
 *  attacker-named URL). Refused outright; public reference reads never need it. */
const FEDERATION = /\bSERVICE\b/i;

export interface SparqlGuardResult {
  ok: boolean;
  error?: string;
}

/** Validate an LLM-authored query BEFORE it reaches the endpoint. SELECT/ASK only, no mutation, no
 *  federation, length-bounded. Returns {ok:false,error} rather than throwing so the invoke layer can
 *  surface the reason back to the planner as an observation (it can then retry with a valid query). */
export function guardSparql(query: string): SparqlGuardResult {
  const q = String(query ?? '').trim();
  if (!q) return { ok: false, error: 'empty query' };
  if (q.length > PUBLIC_GRAPH_MAX_QUERY_CHARS) return { ok: false, error: `query too long (max ${PUBLIC_GRAPH_MAX_QUERY_CHARS} chars)` };
  if (MUTATION_VERBS.test(q)) return { ok: false, error: 'only read-only SELECT/ASK queries are allowed (no INSERT/DELETE/DROP/LOAD/…)' };
  if (FEDERATION.test(q)) return { ok: false, error: 'SERVICE (federation) is not allowed' };
  if (!/\b(SELECT|ASK)\b/i.test(q)) return { ok: false, error: 'query must be a SELECT or ASK' };
  return { ok: true };
}

export interface SparqlRunResult {
  ok: boolean;
  rows?: Array<Record<string, string>>;
  truncated?: boolean;
  error?: string;
}

/** Run a guarded read-only query against the configured public endpoint. Bounded three ways: an
 *  abort-timeout on the request, a server-side `timeout` hint, and a hard row cap on the parsed
 *  result. Never throws — every failure returns {ok:false,error} so a gather turn degrades to "no
 *  reference data", never a crash. */
export async function runPublicSparql(env: PublicGraphEnv, query: string): Promise<SparqlRunResult> {
  const base = String(env.PUBLIC_GRAPH_URL ?? '').trim();
  if (!base) return { ok: false, error: 'public graph not configured' };
  const guard = guardSparql(query);
  if (!guard.ok) return { ok: false, error: guard.error };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PUBLIC_GRAPH_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/sparql-results+json',
    };
    if (env.PUBLIC_GRAPH_BASIC) headers.authorization = `Basic ${env.PUBLIC_GRAPH_BASIC}`;
    const res = await fetch(base, {
      method: 'POST',
      headers,
      // `timeout` is a GraphDB-honoured server-side query budget (seconds) — belt to the abort's
      // braces so a slow query is dropped at the server too, not just the client.
      body: new URLSearchParams({ query, timeout: String(Math.ceil(PUBLIC_GRAPH_TIMEOUT_MS / 1000)) }).toString(),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 200);
      return { ok: false, error: `graph ${res.status}${text ? `: ${text}` : ''}` };
    }
    const j = (await res.json().catch(() => null)) as
      | { boolean?: boolean; results?: { bindings?: Array<Record<string, { value?: string }>> } }
      | null;
    if (j && typeof j.boolean === 'boolean') return { ok: true, rows: [{ result: String(j.boolean) }] };
    const bindings = j?.results?.bindings ?? [];
    const capped = bindings.slice(0, PUBLIC_GRAPH_MAX_ROWS);
    const rows = capped.map((b) => {
      const row: Record<string, string> = {};
      for (const k of Object.keys(b)) row[k] = String(b[k]?.value ?? '');
      return row;
    });
    return { ok: true, rows, truncated: bindings.length > capped.length };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: /abort/i.test(msg) ? `query timed out (>${PUBLIC_GRAPH_TIMEOUT_MS}ms)` : msg };
  } finally {
    clearTimeout(timer);
  }
}

/** The tool the model composes in the gather phase. Deliberately a RAW `query` string: the platform
 *  supplies no ontology — the org's playbook teaches the model the graph's vocabulary, so the domain
 *  knowledge stays in the playbook (data), never here (code). */
export const QUERY_PUBLIC_GRAPH_TOOL: ToolSpec = {
  id: 'query_public_graph',
  description:
    'Query the PUBLIC reference knowledge graph with a read-only SPARQL SELECT (or ASK) to gather ' +
    'facts relevant to the goal. Provide the complete SPARQL in `query` (SELECT/ASK only — no ' +
    'INSERT/DELETE/DROP/LOAD/SERVICE; always include a LIMIT). The graph vocabulary/prefixes are ' +
    'described in your organization guidance above. Returns up to ' + PUBLIC_GRAPH_MAX_ROWS +
    ' result rows. Call it as many times as you need to gather what the goal requires.',
  inputSchema: {
    type: 'object',
    properties: { query: { type: 'string', description: 'A read-only SPARQL SELECT/ASK query with a LIMIT.' } },
    required: ['query'],
  },
};

/** Render captured rows into a compact, prompt-friendly digest for the write turn (bounded so a
 *  large result set can't blow the downstream context budget). */
export function digestRows(label: string, rows: Array<Record<string, string>>, truncated?: boolean): string {
  if (!rows.length) return `${label}: (no rows)`;
  const cols = Object.keys(rows[0]!);
  const head = cols.join(' | ');
  const body = rows
    .slice(0, PUBLIC_GRAPH_MAX_ROWS)
    .map((r) => cols.map((c) => (r[c] ?? '').slice(0, 120)).join(' | '))
    .join('\n');
  return `${label} (${rows.length} row${rows.length === 1 ? '' : 's'}${truncated ? ', truncated' : ''}):\n${head}\n${body}`;
}
