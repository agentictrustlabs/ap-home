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
  /** Spec 418 §3 — the turn's operations: ms per stage (JSON, stage name → ms, bounded), the selection (approach, the
   *  chosen skill id or null, the hold code), the time spent choosing, the conversation (A2A context id) the turn belongs
   *  to, and the model calls with their reported tokens. Names, ids and numbers — never words. */
  stages: string | null; selection_approach: string | null; selection_chose: string | null; selection_hold: string | null;
  selection_ms: number | null; conversation: string | null; model_calls: number; tokens_in: number | null; tokens_out: number | null;
}

export const OPS_SCHEMA = `CREATE TABLE IF NOT EXISTS runs (
  run_ref TEXT PRIMARY KEY, at INTEGER NOT NULL, day TEXT NOT NULL, agent TEXT NOT NULL, asker TEXT,
  outcome TEXT NOT NULL, kind TEXT NOT NULL, capability TEXT, tools TEXT NOT NULL,
  provider TEXT, model TEXT, planner_kind TEXT,
  duration_ms INTEGER, steps INTEGER NOT NULL, ok_steps INTEGER NOT NULL, receipts INTEGER NOT NULL,
  vault_calls INTEGER NOT NULL, do_requests INTEGER NOT NULL,
  failure_class TEXT, error TEXT, routed INTEGER NOT NULL, canceled INTEGER NOT NULL, playbook TEXT, surface TEXT,
  stages TEXT, selection_approach TEXT, selection_chose TEXT, selection_hold TEXT, selection_ms INTEGER, conversation TEXT,
  model_calls INTEGER NOT NULL DEFAULT 0, tokens_in INTEGER, tokens_out INTEGER
);
CREATE INDEX IF NOT EXISTS runs_agent_at ON runs(agent, at);
CREATE INDEX IF NOT EXISTS runs_at ON runs(at);`;

/** Spec 418 §3 — columns added after the table first shipped: an existing index gains them in place (a derived
 *  projection — old rows read as "not recorded" until a rebuild re-projects them). */
export const OPS_ADDED_COLUMNS: ReadonlyArray<[string, string]> = [
  ['stages', 'TEXT'], ['selection_approach', 'TEXT'], ['selection_chose', 'TEXT'], ['selection_hold', 'TEXT'], ['selection_ms', 'INTEGER'],
  ['conversation', 'TEXT'], ['model_calls', 'INTEGER NOT NULL DEFAULT 0'], ['tokens_in', 'INTEGER'], ['tokens_out', 'INTEGER'],
];
/** The most stage names one row keeps (the largest by ms) — the index stays bounded whatever a turn marks. */
export const OPS_MAX_STAGES = 32;

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
    // Spec 414 A1e — the plan call and the variant (the planner summary is retired).
    provider: record.modelCalls?.find((m) => m.role === 'plan')?.provider ?? null, model: record.modelCalls?.find((m) => m.role === 'plan')?.model ?? null, planner_kind: record.variant?.plannerKind ?? null,
    duration_ms: started ? Math.max(0, at - started) : null, steps: steps.length, ok_steps: steps.filter((s) => s.ok).length, receipts: Array.isArray(record.receipts) ? record.receipts.length : Number((record as { receipts?: unknown }).receipts ?? 0),
    vault_calls: Number(record.bill?.vaultCalls ?? 0), do_requests: Number(record.bill?.doRequests ?? 0),
    failure_class: record.outcome === 'completed' ? null : failureClassOf(error ?? String(record.outcome)), error: error ? String(error).slice(0, 200) : null,
    routed: steps.some((s) => (s.result as { routed?: unknown } | undefined)?.routed !== undefined) || typeof ctx.route === 'object' ? 1 : 0, canceled: record.canceled ? 1 : 0,
    playbook: typeof ctx.playbook === 'string' ? ctx.playbook : null, surface: typeof (ctx.surface as { realm?: string } | undefined)?.realm === 'string' ? String((ctx.surface as { realm: string }).realm) : null,
    ...operationalColumnsOf(record),
  };
}

/** Spec 418 §3 — the operational columns of a row, from `record.operational` and `record.modelCalls`. Absent facts are
 *  null (not recorded), never zero: a turn that recorded no stages is not a turn whose stages took no time. */
export function operationalColumnsOf(record: RunRecordV1): Pick<OpsRowV1, 'stages' | 'selection_approach' | 'selection_chose' | 'selection_hold' | 'selection_ms' | 'conversation' | 'model_calls' | 'tokens_in' | 'tokens_out'> {
  const op = record.operational;
  const stageEntries = Object.entries(op?.stages ?? {}).filter(([k, v]) => typeof v === 'number' && Number.isFinite(v) && k.length <= 64)
    .sort((a, b) => b[1] - a[1]).slice(0, OPS_MAX_STAGES).map(([k, v]) => [k, Math.round(v)] as const);
  const calls = record.modelCalls ?? [];
  const tin = calls.filter((m) => typeof m.tokensIn === 'number');
  const tout = calls.filter((m) => typeof m.tokensOut === 'number');
  return {
    stages: stageEntries.length ? JSON.stringify(Object.fromEntries(stageEntries)) : null,
    selection_approach: op?.selection?.approach ?? null, selection_chose: op?.selection?.chose ?? null, selection_hold: op?.selection?.hold ?? null,
    selection_ms: typeof op?.selectionMs === 'number' ? Math.round(op.selectionMs) : null,
    conversation: op?.turn?.contextId ?? record.door?.contextId ?? null,
    model_calls: calls.length,
    tokens_in: tin.length ? tin.reduce((a, m) => a + (m.tokensIn ?? 0), 0) : null,
    tokens_out: tout.length ? tout.reduce((a, m) => a + (m.tokensOut ?? 0), 0) : null,
  };
}

let ready: Promise<void> | null = null;
async function ensure(db: D1Database): Promise<void> {
  ready ??= (async () => {
    for (const stmt of OPS_SCHEMA.split(';').map((s) => s.trim()).filter(Boolean)) await db.prepare(stmt).run();
    // An index created before spec 418 gains the operational columns; "duplicate column" means it already has one.
    for (const [col, type] of OPS_ADDED_COLUMNS) {
      try { await db.prepare(`ALTER TABLE runs ADD COLUMN ${col} ${type}`).run(); }
      catch (e) { if (!/duplicate column/i.test(e instanceof Error ? e.message : String(e))) throw e; }
    }
  })().catch((e) => { ready = null; throw e; });
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
  /** Spec 418 §3 — p50/p95 per stage name over the window's runs that recorded it. */
  byStage: StagePercentileV1[];
  /** Spec 418 §3 — how the window's turns chose: share per approach, the hold rate, the median time spent choosing. */
  selection: SelectionSummaryV1;
  /** Spec 418 §3 — the CONVERSATION axis: turns per conversation, time and tokens per turn (newest first, bounded). */
  conversations: ConversationSummaryV1;
}
export interface StagePercentileV1 { stage: string; runs: number; p50Ms: number | null; p95Ms: number | null }
export interface SelectionSummaryV1 {
  /** Turns that recorded a selection (the rest: not recorded, or a plan the model made without an arm). */
  recorded: number; held: number; holdRate: number | null; p50Ms: number | null;
  byApproach: Array<{ approach: string; runs: number; share: number; held: number; chose: number }>;
  byHold: Array<{ hold: string; runs: number }>;
}
export interface ConversationSummaryV1 {
  conversations: number; turns: number; turnsPerConversationP50: number | null; msPerTurnP50: number | null; tokensPerTurnP50: number | null;
  rows: Array<{ conversation: string; turns: number; firstAt: number; lastAt: number; totalMs: number | null; msPerTurnP50: number | null; tokens: number | null; tokensPerTurn: number | null }>;
}
const pct = (xs: number[], p: number): number | null => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))] ?? null; };
function group<K extends string>(rows: OpsRowV1[], key: (r: OpsRowV1) => K | null): Map<K, OpsRowV1[]> { const m = new Map<K, OpsRowV1[]>(); for (const r of rows) { const k = key(r); if (k === null) continue; m.set(k, [...(m.get(k) ?? []), r]); } return m; }
const durations = (rows: OpsRowV1[]) => rows.map((r) => r.duration_ms).filter((d): d is number => typeof d === 'number');
const stagesOfRow = (r: OpsRowV1): Record<string, number> | null => { if (!r.stages) return null; try { const o = JSON.parse(r.stages) as unknown; return o && typeof o === 'object' ? o as Record<string, number> : null; } catch { return null; } };
const tokensOfRow = (r: OpsRowV1): number | null => (r.tokens_in == null && r.tokens_out == null ? null : Number(r.tokens_in ?? 0) + Number(r.tokens_out ?? 0));

/** Spec 418 §3 — p50/p95 per stage name, over the rows that recorded that stage. Pure; tested. */
export function stagePercentilesOf(rows: readonly OpsRowV1[]): StagePercentileV1[] {
  const by = new Map<string, number[]>();
  for (const r of rows) for (const [k, v] of Object.entries(stagesOfRow(r) ?? {})) if (typeof v === 'number') by.set(k, [...(by.get(k) ?? []), v]);
  return [...by].map(([stage, xs]) => ({ stage, runs: xs.length, p50Ms: pct(xs, 0.5), p95Ms: pct(xs, 0.95) }))
    .sort((a, b) => (a.stage.startsWith('phase:') === b.stage.startsWith('phase:') ? (b.p95Ms ?? 0) - (a.p95Ms ?? 0) : a.stage.startsWith('phase:') ? -1 : 1));
}

/** Spec 418 §3 — the selection over a window: share per approach, holds, the median time spent choosing. Pure; tested. */
export function selectionSummaryOf(rows: readonly OpsRowV1[]): SelectionSummaryV1 {
  const sel = rows.filter((r) => r.selection_approach);
  const held = sel.filter((r) => r.selection_hold).length;
  const byApproach = [...group([...sel], (r) => r.selection_approach)].map(([approach, xs]) => ({ approach, runs: xs.length, share: xs.length / sel.length, held: xs.filter((r) => r.selection_hold).length, chose: xs.filter((r) => r.selection_chose).length })).sort((a, b) => b.runs - a.runs);
  const byHold = [...group([...sel], (r) => r.selection_hold)].map(([hold, xs]) => ({ hold, runs: xs.length })).sort((a, b) => b.runs - a.runs);
  const ms = rows.map((r) => r.selection_ms).filter((x): x is number => typeof x === 'number');
  return { recorded: sel.length, held, holdRate: sel.length ? held / sel.length : null, p50Ms: pct(ms, 0.5), byApproach, byHold };
}

/** Spec 418 §3 — THE CONVERSATION AXIS: turns grouped by their conversation (the A2A context id); a turn with none is
 *  not a conversation and is left out. Turns per conversation, ms and tokens per turn; newest conversation first. */
export function conversationsOf(rows: readonly OpsRowV1[], limit = 50): ConversationSummaryV1 {
  const groups = [...group([...rows], (r) => r.conversation)];
  const all = groups.map(([conversation, xs]) => {
    const ds = durations(xs); const ts = xs.map(tokensOfRow).filter((t): t is number => t !== null);
    return { conversation, turns: xs.length, firstAt: Math.min(...xs.map((r) => r.at)), lastAt: Math.max(...xs.map((r) => r.at)),
      totalMs: ds.length ? ds.reduce((a, b) => a + b, 0) : null, msPerTurnP50: pct(ds, 0.5),
      tokens: ts.length ? ts.reduce((a, b) => a + b, 0) : null, tokensPerTurn: ts.length ? Math.round(ts.reduce((a, b) => a + b, 0) / ts.length) : null };
  }).sort((a, b) => b.lastAt - a.lastAt);
  const turns = groups.flatMap(([, xs]) => xs);
  return {
    conversations: all.length, turns: turns.length, turnsPerConversationP50: pct(all.map((c) => c.turns), 0.5),
    msPerTurnP50: pct(durations(turns), 0.5), tokensPerTurnP50: pct(turns.map(tokensOfRow).filter((t): t is number => t !== null), 0.5),
    rows: all.slice(0, limit),
  };
}

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
    byStage: stagePercentilesOf(rows), selection: selectionSummaryOf(rows), conversations: conversationsOf(rows),
  };
}

/** Spec 416 §4f — the tools an asker's runs at this agent used since `sinceMs`, counted (one indexed range read). The
 *  asker's recent skills, for the judge's typed reading — ids and counts only. `null` when no index is bound. */
export async function recentToolsOf(env: OpsEnv, agent: Address, asker: Address, sinceMs: number, limit = 40): Promise<Array<{ id: string; times: number }> | null> {
  if (!env.OPS) return null;
  const rows = await env.OPS.prepare('SELECT tools FROM runs WHERE agent = ? AND asker = ? AND at >= ? ORDER BY at DESC LIMIT ?')
    .bind(agent.toLowerCase(), asker.toLowerCase(), sinceMs, limit).all<{ tools: string }>();
  const counts = new Map<string, number>();
  for (const r of rows.results ?? []) { let ts: unknown = []; try { ts = JSON.parse(r.tools); } catch { /* a row we cannot read is skipped */ } for (const t of Array.isArray(ts) ? ts : []) if (typeof t === 'string') counts.set(t, (counts.get(t) ?? 0) + 1); }
  return [...counts.entries()].map(([id, times]) => ({ id, times })).sort((a, b) => b.times - a.times || a.id.localeCompare(b.id));
}
