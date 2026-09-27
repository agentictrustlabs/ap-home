import { describe, it, expect } from 'vitest';
import { rowOf, failureClassOf, queryOps, indexRun, OPS_SCHEMA, stagePercentilesOf, selectionSummaryOf, conversationsOf, OPS_MAX_STAGES, type OpsRowV1 } from '../../src/ops-index.js';

const AGENT = '0x' + 'a'.repeat(40);
const record = (over: Record<string, unknown> = {}) => ({
  type: 'ap.run-record.v1', runRef: 'run-1', at: 1_700_000_100_000, receivedAt: 1_700_000_098_000, intent: { goal: 'pay bob', context: { asker: '0x' + 'b'.repeat(40), surface: { realm: 'org' } } }, plan: { steps: [] },
  steps: [{ stepRef: 's0', toolId: 'treasury.balance.read', args: {}, ok: true }, { stepRef: 's1', toolId: 'treasury.payment.execute', args: { usdc: '5' }, ok: true, result: { txHash: '0x1' } }],
  receipts: [{}, {}], events: [], outcome: 'completed', variant: { plannerKind: 'model' }, modelCalls: [{ role: 'plan', provider: 'xai', model: 'grok' }], bill: { vaultCalls: 7, doRequests: 3, byStep: {} }, ...over,
}) as never;

describe('the operator index (spec 406 W1) — numbers and ids, never words', () => {
  it('projects a record to a row: the first ACT is the capability, tools deduped, the bill, the duration, no arguments or results', () => {
    const r = rowOf(record(), AGENT);
    expect(r).toMatchObject({ run_ref: 'run-1', agent: AGENT, asker: '0x' + 'b'.repeat(40), kind: 'answer', outcome: 'completed', capability: 'treasury.payment.execute', provider: 'xai', model: 'grok', duration_ms: 2000, steps: 2, ok_steps: 2, receipts: 2, vault_calls: 7, do_requests: 3, failure_class: null, surface: 'org' });
    expect(JSON.parse(r.tools)).toEqual(['treasury.balance.read', 'treasury.payment.execute']);
    expect(JSON.stringify(r)).not.toContain('pay bob'); expect(JSON.stringify(r)).not.toContain('"usdc"'); expect(JSON.stringify(r)).not.toContain('0x1"');
  });
  it('kinds follow the outcome; a failure is classified by the fixed table, never guessed', () => {
    expect(rowOf(record({ outcome: 'authority-required', steps: [] }), AGENT).kind).toBe('authority_required');
    expect(rowOf(record({ canceled: { at: 1, by: 'x', afterSteps: 0 } }), AGENT).kind).toBe('canceled');
    const failed = rowOf(record({ outcome: 'failed', steps: [{ stepRef: 's0', toolId: 'x', args: {}, ok: false, error: 'record_scope_denied: build.run' }] }), AGENT);
    expect(failed).toMatchObject({ kind: 'error', failure_class: 'grant-scope', capability: 'x' });
    expect(failureClassOf('something new')).toBe('unclassified'); expect(failureClassOf(null)).toBeNull();
  });
  it('aggregates a window: totals, percentiles, by day / capability / provider / agent / failure; a query with no OPS is null', async () => {
    const rows: Array<Record<string, unknown>> = [];
    const db = {
      prepare: (sql: string) => ({
        run: async () => ({}),
        bind: (...args: unknown[]) => ({ run: async () => { const cols = /INSERT OR REPLACE INTO runs \((.*)\) VALUES/.exec(sql)![1]!.split(', '); const row = Object.fromEntries(cols.map((c, i) => [c, args[i]])); const at = rows.findIndex((r) => r.run_ref === row.run_ref); if (at >= 0) rows[at] = row; else rows.push(row); return {}; }, all: async () => ({ results: rows.filter((r) => Number(r.at) >= Number(args[args.length - 3])) }) }),
      }),
    } as unknown as D1Database;
    expect(OPS_SCHEMA).toContain('CREATE TABLE IF NOT EXISTS runs');
    await indexRun({ OPS: db }, AGENT, record());
    await indexRun({ OPS: db }, AGENT, record({ runRef: 'run-2', outcome: 'failed', at: 1_700_000_200_000, receivedAt: 1_700_000_190_000, steps: [{ stepRef: 's0', toolId: 'web.search', args: {}, ok: false, error: 'quota exceeded' }], bill: { vaultCalls: 1, doRequests: 1, byStep: {} } }));
    await indexRun({ OPS: db }, AGENT, record({ runRef: 'run-1' })); // the export writes the record twice — an upsert
    const s = (await queryOps({ OPS: db }, { agents: [AGENT], since: 0 }))!;
    expect(s.totals).toMatchObject({ runs: 2, answered: 1, errored: 1, vaultCalls: 8 });
    expect(s.byCapability.map((c) => [c.capability, c.runs])).toEqual([['treasury.payment.execute', 1], ['web.search', 1]]);
    expect(s.byFailure).toEqual([{ failureClass: 'model-credit', runs: 1, sample: 'quota exceeded' }]);
    expect(s.byProvider[0]).toMatchObject({ provider: 'xai', runs: 2 });
    expect(await queryOps({}, { agents: [AGENT], since: 0 })).toBeNull();
  });

  it('spec 418 §3 — the operational columns: stages bounded, the selection, the conversation, model calls and tokens; absent is null', () => {
    const stages = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`read:s${i}`, i]));
    const r = rowOf(record({
      operational: { stages: { ...stages, 'phase:run': 900.4 }, selectionMs: 310.6, selection: { approach: 'outcome', chose: 'org.members.list', chain: ['a', 'org.members.list'], confidence: 0.8 }, turn: { contextId: 'ctx-1', recalledTurns: 2 } },
      modelCalls: [{ role: 'plan', provider: 'xai', model: 'grok', tokensIn: 100, tokensOut: 20 }, { role: 'structured', stepRef: 's0', provider: 'gemini', model: 'flash', tokensIn: 50 }],
    }), AGENT);
    const st = JSON.parse(r.stages!) as Record<string, number>;
    expect(Object.keys(st)).toHaveLength(OPS_MAX_STAGES); expect(st['phase:run']).toBe(900); expect(st['read:s0']).toBeUndefined();
    expect(r).toMatchObject({ selection_approach: 'outcome', selection_chose: 'org.members.list', selection_hold: null, selection_ms: 311, conversation: 'ctx-1', model_calls: 2, tokens_in: 150, tokens_out: 20 });
    const bare = rowOf(record({ modelCalls: [{ role: 'plan', provider: 'xai' }], door: { kind: 'a2a-message', contextId: 'ctx-door' } }), AGENT);
    expect(bare).toMatchObject({ stages: null, selection_approach: null, selection_ms: null, conversation: 'ctx-door', model_calls: 1, tokens_in: null, tokens_out: null });
  });
  it('spec 418 §3 — stage percentiles, the selection summary and the conversation axis', () => {
    const row = (o: Partial<OpsRowV1>): OpsRowV1 => ({ ...rowOf(record(), AGENT), stages: null, selection_approach: null, selection_chose: null, selection_hold: null, selection_ms: null, conversation: null, model_calls: 0, tokens_in: null, tokens_out: null, ...o });
    const rows = [
      row({ run_ref: 'a', at: 10, duration_ms: 1000, stages: JSON.stringify({ 'phase:run': 800, 'read:runs': 40 }), selection_approach: 'outcome', selection_chose: 'x', selection_ms: 100, conversation: 'c1', tokens_in: 100, tokens_out: 10 }),
      row({ run_ref: 'b', at: 20, duration_ms: 3000, stages: JSON.stringify({ 'phase:run': 2000, 'read:runs': 60 }), selection_approach: 'outcome', selection_hold: 'below-floor', selection_ms: 300, conversation: 'c1', tokens_in: 200, tokens_out: 30 }),
      row({ run_ref: 'c', at: 30, duration_ms: 500, selection_approach: 'judgment', selection_chose: 'y', conversation: 'c2' }),
      row({ run_ref: 'd', at: 40, duration_ms: 700 }),
    ];
    const byStage = stagePercentilesOf(rows);
    expect(byStage[0]).toEqual({ stage: 'phase:run', runs: 2, p50Ms: 800, p95Ms: 800 });
    expect(byStage.find((s) => s.stage === 'read:runs')).toMatchObject({ runs: 2, p50Ms: 40 });
    const sel = selectionSummaryOf(rows);
    expect(sel).toMatchObject({ recorded: 3, held: 1, p50Ms: 100, byHold: [{ hold: 'below-floor', runs: 1 }] });
    expect(sel.holdRate).toBeCloseTo(1 / 3);
    expect(sel.byApproach[0]).toMatchObject({ approach: 'outcome', runs: 2, held: 1, chose: 1 });
    const conv = conversationsOf(rows);
    expect(conv).toMatchObject({ conversations: 2, turns: 3 });
    expect(conv.rows[0]).toMatchObject({ conversation: 'c2', turns: 1, tokens: null, tokensPerTurn: null });
    expect(conv.rows[1]).toMatchObject({ conversation: 'c1', turns: 2, totalMs: 4000, tokens: 340, tokensPerTurn: 170 });
    expect(selectionSummaryOf([]).holdRate).toBeNull();
  });
});
