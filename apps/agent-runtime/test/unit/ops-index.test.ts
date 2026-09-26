import { describe, it, expect } from 'vitest';
import { rowOf, failureClassOf, queryOps, indexRun, OPS_SCHEMA } from '../../src/ops-index.js';

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
});
