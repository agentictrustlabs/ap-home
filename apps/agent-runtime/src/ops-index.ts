// SPEC 406 W1 — THE OPERATOR VIEW'S INDEX. One row per finished run in a D1 database (`OPS`): numbers and ids only —
// when, agent, asker, outcome, the first act's capability and every tool, provider and model, duration, steps, receipts,
// the bill, the failure class (the nightly trend's fixed table, never a model), routed, canceled, playbook, surface.
// Written beside the run record (`putRecord`), so an operator query is one indexed range read; REBUILT from the agent's
// records on request — a projection over the evidence, never the evidence (the record, the receipts, the PROV bundle
// are). No words, no arguments, no results: an operator screen may count what an agent did, not read what it was about.
import type { Address } from 'viem';
import type { RunRecordV1 } from '@agenticprimitives/orchestration';

export interface OpsEnv { OPS?: D1Database }

export interface OpsRowV1 {
  run_ref: string; at: number; day: string; agent: string; asker: string | null;
  outcome: string; kind: string; capability: string | null; tools: string;
  provider: string | null; model: string | null; planner_kind: string | null;
  duration_ms: number | null; steps: number; ok_steps: number; receipts: number;
  vault_calls: number; do_requests: number;
  failure_class: string | null; error: string | null;
  routed: number; canceled: number; playbook: string | null; surface: string | null;
}

export const OPS_SCHEMA = `CREATE TABLE IF NOT EXISTS runs (
  run_ref TEXT PRIMARY KEY, at INTEGER NOT NULL, day TEXT NOT NULL, agent TEXT NOT NULL, asker TEXT,
  outcome TEXT NOT NULL, kind TEXT NOT NULL, capability TEXT, tools TEXT NOT NULL,
  provider TEXT, model TEXT, planner_kind TEXT,
  duration_ms INTEGER, steps INTEGER NOT NULL, ok_steps INTEGER NOT NULL, receipts INTEGER NOT NULL,
  vault_calls INTEGER NOT NULL, do_requests INTEGER NOT NULL,
  failure_class TEXT, error TEXT, routed INTEGER NOT NULL, canceled INTEGER NOT NULL, playbook TEXT, surface TEXT
);
CREATE INDEX IF NOT EXISTS runs_agent_at ON runs(agent, at);
CREATE INDEX IF NOT EXISTS runs_at ON runs(at);`;

/** The failure classes — the same fixed table `scripts/live-gates-trend.mts` keeps; first match wins. */
const CLASSES: Array<{ id: string; test: RegExp }> = [
  { id: 'vault-throttle', test: /auth failed — mcp|rate-limited|throttled|vault budget|budget for today/i },
  { id: 'playbook-drift', test: /unknown_tool|not exposed by this agent|assignment digest mismatch/i },
  { id: 'model-credit', test: /credit_balance|insufficient credit|out of credit|quota|TPM/i },
  { id: 'infra', test: /D1_ERROR|Network connection lost|fetch failed|ECONNRESET|ETIMEDOUT|\b50[234]\b/i },
  { id: 'grant-scope', test: /record_scope_denied|re-issue/i },
  { id: 'authority-refused', test: /\b403\b|not a declared approver|steward standing|only the organization|not yours to|requires a mandate|refused/i },
  { id: 'conflict', test: /\b409\b|already/i },
];
export const failureClassOf = (text: string | null | undefined): string | null => (text ? CLASSES.find((c) => c.test.test(text))?.id ?? 'unclassified' : null);

/** The kind an operator groups by — the run's outcome said the way a reply says it. */
const kindOf = (r: RunRecordV1): string => r.canceled ? 'canceled' : r.outcome === 'completed' ? 'answer' : r.outcome === 'authority-required' ? 'authority_required' : r.outcome === 'suspended' ? 'prompt' : r.outcome === 'denied' ? 'refused' : 'error';

/** The record → its row. Pure; tested. */
export function rowOf(record: RunRecordV1, addressee: Address): OpsRowV1 {
  const steps = record.steps ?? [];
  const firstAct = steps.find((s) => !s.skipped && /\.(create|send|post|execute|fund|open|merge|delete|invite|revoke|declare|remember|forget|set|attach|promote|run)$/.test(s.toolId)) ?? steps[0];
  const error = steps.find((s) => s.error)?.error ?? (record as { error?: string }).error ?? null;
  const ctx = (record.intent as { context?: Record<string, unknown> }).context ?? {};
  const at = Number(record.at ?? Date.now());
  const started = typeof record.receivedAt === 'number' && record.receivedAt > 0 ? record.receivedAt : null;
  return {
    run_ref: record.runRef, at, day: new Date(at).toISOString().slice(0, 10), agent: addressee.toLowerCase(),
    asker: typeof ctx.asker === 'string' ? String(ctx.asker).toLowerCase() : null,
    outcome: String(record.outcome), kind: kindOf(record), capability: firstAct?.toolId ?? null, tools: JSON.stringify([...new Set(steps.map((s) => s.toolId))]),
    provider: record.planner?.provider ?? null, model: record.planner?.model ?? null, planner_kind: record.planner?.kind ?? null,
    duration_ms: started ? Math.max(0, at - started) : null, steps: steps.length, ok_steps: steps.filter((s) => s.ok).length, receipts: Array.isArray(record.receipts) ? record.receipts.length : Number((record as { receipts?: unknown }).receipts ?? 0),
    vault_calls: Number(record.bill?.vaultCalls ?? 0), do_requests: Number(record.bill?.doRequests ?? 0),
    failure_class: record.outcome === 'completed' ? null : failureClassOf(error ?? String(record.outcome)), error: error ? String(error).slice(0, 200) : null,
    routed: steps.some((s) => (s.result as { routed?: unknown } | undefined)?.routed !== undefined) || typeof ctx.route === 'object' ? 1 : 0, canceled: record.canceled ? 1 : 0,
    playbook: typeof ctx.playbook === 'string' ? ctx.playbook : null, surface: typeof (ctx.surface as { realm?: string } | undefined)?.realm === 'string' ? String((ctx.surface as { realm: string }).realm) : null,
  };
}

let ready: Promise<void> | null = null;
async function ensure(db: D1Database): Promise<void> {
  ready ??= (async () => { for (const stmt of OPS_SCHEMA.split(';').map((s) => s.trim()).filter(Boolean)) await db.prepare(stmt).run(); })().catch((e) => { ready = null; throw e; });
  return ready;
}

/** Index one record (an upsert — the export writes the record twice). Never throws into the caller's path. */
export async function indexRun(env: OpsEnv, addressee: Address, record: RunRecordV1): Promise<boolean> {
  if (!env.OPS) return false;
  try {
    await ensure(env.OPS);
    const r = rowOf(record, addressee);
    const cols = Object.keys(r) as Array<keyof OpsRowV1>;
    await env.OPS.prepare(`INSERT OR REPLACE INTO runs (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).bind(...cols.map((c) => r[c])).run();
    return true;
  } catch (e) { console.warn('[ops-index] not indexed:', e instanceof Error ? e.message : String(e)); return false; }
}

/** Index many records in D1 batches (the rebuild). */
export async function indexRuns(env: OpsEnv, addressee: Address, records: RunRecordV1[]): Promise<number> {
  if (!env.OPS || !records.length) return 0;
  try {
    await ensure(env.OPS);
    let n = 0;
    // Ten at a time: one prepared upsert per record (a batch of many bound statements met an opaque D1 refusal).
    for (let i = 0; i < records.length; i += 10) {
      const done = await Promise.all(records.slice(i, i + 10).map(async (rec) => {
        try { const r = rowOf(rec, addressee); const cols = Object.keys(r) as Array<keyof OpsRowV1>; await env.OPS!.prepare(`INSERT OR REPLACE INTO runs (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).bind(...cols.map((c) => r[c])).run(); return 1; }
        catch (e) { console.warn('[ops-index] row not indexed:', rec.runRef, e instanceof Error ? `${e.name}: ${e.message}` : JSON.stringify(e)); return 0; }
      }));
      n += done.reduce<number>((a, b) => a + b, 0);
    }
    return n;
  } catch (e) { console.warn('[ops-index] rebuild failed:', e instanceof Error ? `${e.name}: ${e.message}` : JSON.stringify(e)); return 0; }
}

export interface OpsQuery { agents: string[]; since: number; until?: number; limit?: number }
export interface OpsSummary {
  window: { since: number; until: number }; agents: string[];
  totals: { runs: number; answered: number; parked: number; prompted: number; refused: number; errored: number; canceled: number; routed: number; vaultCalls: number; doRequests: number; steps: number; receipts: number; p50Ms: number | null; p95Ms: number | null };
  byDay: Array<{ day: string; runs: number; answered: number; parked: number; errored: number; vaultCalls: number }>;
  byCapability: Array<{ capability: string; runs: number; answered: number; parked: number; errored: number; p50Ms: number | null }>;
  byProvider: Array<{ provider: string; runs: number; p50Ms: number | null; p95Ms: number | null }>;
  byAgent: Array<{ agent: string; runs: number; answered: number; parked: number; errored: number; vaultCalls: number }>;
  byFailure: Array<{ failureClass: string; runs: number; sample: string | null }>;
  recent: Array<Pick<OpsRowV1, 'run_ref' | 'at' | 'agent' | 'kind' | 'capability' | 'provider' | 'duration_ms' | 'vault_calls' | 'failure_class'>>;
}
const pct = (xs: number[], p: number): number | null => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))] ?? null; };
function group<K extends string>(rows: OpsRowV1[], key: (r: OpsRowV1) => K | null): Map<K, OpsRowV1[]> { const m = new Map<K, OpsRowV1[]>(); for (const r of rows) { const k = key(r); if (k === null) continue; m.set(k, [...(m.get(k) ?? []), r]); } return m; }
const durations = (rows: OpsRowV1[]) => rows.map((r) => r.duration_ms).filter((d): d is number => typeof d === 'number');

/** One indexed range read, aggregated here — an operator's window over the agents the caller stewards. */
export async function queryOps(env: OpsEnv, q: OpsQuery): Promise<OpsSummary | null> {
  if (!env.OPS || !q.agents.length) return null;
  await ensure(env.OPS);
  const until = q.until ?? Date.now();
  const agents = q.agents.map((a) => a.toLowerCase());
  const res = await env.OPS.prepare(`SELECT * FROM runs WHERE agent IN (${agents.map(() => '?').join(',')}) AND at >= ? AND at <= ? ORDER BY at DESC LIMIT ?`).bind(...agents, q.since, until, Math.min(q.limit ?? 5000, 20000)).all<OpsRowV1>();
  const rows = res.results ?? [];
  const count = (xs: OpsRowV1[], k: string) => xs.filter((r) => r.kind === k).length;
  const sum = (xs: OpsRowV1[], f: (r: OpsRowV1) => number) => xs.reduce((a, r) => a + f(r), 0);
  const tally = (xs: OpsRowV1[]) => ({ runs: xs.length, answered: count(xs, 'answer'), parked: count(xs, 'authority_required'), errored: count(xs, 'error'), vaultCalls: sum(xs, (r) => r.vault_calls) });
  return {
    window: { since: q.since, until }, agents,
    totals: { ...tally(rows), prompted: count(rows, 'prompt'), refused: count(rows, 'refused'), canceled: count(rows, 'canceled'), routed: rows.filter((r) => r.routed).length, doRequests: sum(rows, (r) => r.do_requests), steps: sum(rows, (r) => r.steps), receipts: sum(rows, (r) => r.receipts), p50Ms: pct(durations(rows), 0.5), p95Ms: pct(durations(rows), 0.95) },
    byDay: [...group(rows, (r) => r.day)].map(([day, xs]) => ({ day, ...tally(xs) })).sort((a, b) => a.day.localeCompare(b.day)),
    byCapability: [...group(rows, (r) => r.capability)].map(([capability, xs]) => ({ capability, runs: xs.length, answered: count(xs, 'answer'), parked: count(xs, 'authority_required'), errored: count(xs, 'error'), p50Ms: pct(durations(xs), 0.5) })).sort((a, b) => b.runs - a.runs),
    byProvider: [...group(rows, (r) => r.provider)].map(([provider, xs]) => ({ provider, runs: xs.length, p50Ms: pct(durations(xs), 0.5), p95Ms: pct(durations(xs), 0.95) })).sort((a, b) => b.runs - a.runs),
    byAgent: [...group(rows, (r) => r.agent)].map(([agent, xs]) => ({ agent, ...tally(xs) })).sort((a, b) => b.runs - a.runs),
    byFailure: [...group(rows, (r) => r.failure_class)].map(([failureClass, xs]) => ({ failureClass, runs: xs.length, sample: xs.find((r) => r.error)?.error ?? null })).sort((a, b) => b.runs - a.runs),
    recent: rows.slice(0, 50).map((r) => ({ run_ref: r.run_ref, at: r.at, agent: r.agent, kind: r.kind, capability: r.capability, provider: r.provider, duration_ms: r.duration_ms, vault_calls: r.vault_calls, failure_class: r.failure_class })),
  };
}
