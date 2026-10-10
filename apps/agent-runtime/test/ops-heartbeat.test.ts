import { describe, it, expect } from 'vitest';
import { heartbeatOfRows, heartbeatAuthorized, agentsByType, performanceOfRows } from '../src/ops-heartbeat.js';
import { validateEstateHeartbeat } from '@agenticprimitives/harness/heartbeat';
import type { OpsRowV1 } from '../src/ops-index.js';

const row = (p: Partial<OpsRowV1>): OpsRowV1 => ({ run_ref: 'r', at: 1, day: '2026-10-10', agent: '0xa', asker: '0xp', outcome: 'answered', kind: 'answer', capability: null, tools: '', provider: null, model: null, planner_kind: null, duration_ms: 500, steps: 1, ok_steps: 1, receipts: 0, vault_calls: 2, do_requests: 3, failure_class: null, error: null, routed: 0, canceled: 0, playbook: null, surface: null, stages: null, selection_approach: null, selection_chose: null, selection_hold: null, selection_ms: null, conversation: null, model_calls: 1, tokens_in: 100, tokens_out: 10, perf: null, ...p });

describe('estate heartbeat', () => {
  it('counts runs by state, homes active, model calls, tokens, vault and DO calls, and the p95 ask latency — never a name', () => {
    const rows = [row({}), row({ kind: 'authority_required', asker: '0xq', duration_ms: 1200 }), row({ kind: 'error', asker: '0xp', duration_ms: 50 }), row({ kind: 'answer', asker: null, duration_ms: 3000, canceled: 1 })];
    const hb = heartbeatOfRows(rows, { estate: 'faithnet', now: Date.parse('2026-10-10T12:00:00Z'), agents: { person: 3, org: 1, service: 2 }, generation: '1', versions: { runtime: 'abc' } });
    expect(hb).toMatchObject({ type: 'ap.estate-heartbeat.v1', estate: 'faithnet', window: '24h', agents: { person: 3, org: 1, service: 2 }, homesActive24h: 2, runs: { started: 4, completed: 2, parked: 1, failed: 1, canceled: 1 }, parkedForSignature: 1, modelCalls: 4, tokensIn: 400, tokensOut: 40, vaultCalls: 8, doRequests: 12, inferenceMicroUsd: null, askLatencyP95Ms: 3000 });
    expect(JSON.stringify(hb)).not.toContain('0xp');
  });
  it('spec 437 — the performance block rolls up the rows that carry a perf column; none ⇒ no block, never zeros; the heartbeat still validates', () => {
    const perf = (outcome: string, dur: number, provider: string, latency: number) => JSON.stringify({ m: { startMs: 0, endMs: dur, runs: [{ attributes: { 'ap.run.outcome': outcome }, value: 1 }], verdicts: [], stepDuration: [], modelCalls: [], vaultCalls: [{ attributes: { 'ap.capability.id': 'x', 'ap.risk': 'low' }, value: 2 }] }, c: [{ provider, profile: 'planner-fast', startMs: 0, endMs: latency }] });
    const rows = [row({ perf: perf('completed', 800, 'gateway', 300), do_requests: 10 }), row({ perf: perf('failed', 9000, 'gateway', 900), do_requests: 30, failure_class: 'infra', kind: 'error' }), row({ perf: null })];
    const hb = heartbeatOfRows(rows, { estate: 'faithnet', now: 0, agents: null, generation: '1', versions: {} });
    expect(hb.performance).toMatchObject({ type: 'ap.estate-performance.v1', window: '24h', runs: { total: 2, byOutcome: { completed: 1, failed: 1 } }, runDurationMs: { p50: 800, p95: 9000, count: 2 }, doRequestsPerRun: { p50: 10, p95: 30 }, vaultCallsPerRun: { p50: 2 }, failureClasses: [{ failureClass: 'infra', count: 1 }], parkedWaitMs: { count: 0 }, firstTokenMs: null });
    expect(hb.performance!.modelLatencyMs[0]).toMatchObject({ provider: 'gateway', profile: 'planner-fast', quantiles: { p50: 300, p95: 900, count: 2 } });
    expect(validateEstateHeartbeat(hb).ok).toBe(true);
    expect(performanceOfRows([row({})])).toBeUndefined();
    expect(heartbeatOfRows([row({})], { estate: 'e', now: 0, agents: null, generation: '1', versions: {} })).not.toHaveProperty('performance');
  });
  it('without a registry answer the agents are zeros, not a guess', () => {
    const hb = heartbeatOfRows([], { estate: 'e', now: 0, agents: null, generation: '1', versions: {} });
    expect(hb.agents).toEqual({ person: 0, org: 0, service: 0 });
    expect(hb.askLatencyP95Ms).toBeNull();
  });
  it('the town token is compared in constant time; an unset token closes the door with 503', () => {
    expect(heartbeatAuthorized({ TOWN_HEARTBEAT_TOKEN: 'secret-token' }, 'Bearer secret-token')).toEqual({ ok: true });
    expect(heartbeatAuthorized({ TOWN_HEARTBEAT_TOKEN: 'secret-token' }, 'Bearer secret-tokeX')).toMatchObject({ ok: false, status: 401 });
    expect(heartbeatAuthorized({ TOWN_HEARTBEAT_TOKEN: 'secret-token' }, null)).toMatchObject({ ok: false, status: 401 });
    expect(heartbeatAuthorized({}, 'Bearer x')).toMatchObject({ ok: false, status: 503 });
  });
  it('agents by type fold the registry facets down to the three roots', async () => {
    const f = (async () => Response.json({ kinds: [{ value: 'person', count: 7 }, { value: 'org', count: 2 }, { value: 'service', count: 4 }] })) as unknown as typeof fetch;
    expect(await agentsByType('https://registry', f)).toEqual({ person: 7, org: 2, service: 4 });
    expect(await agentsByType(undefined, f)).toBeNull();
  });
});
