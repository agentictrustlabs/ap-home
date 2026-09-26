// Spec 415 A3 — the run tree (door → run → model calls → steps with skill and authority → child runs) and the run list's
// facets and threads, from the record the agent's vault keeps. Ids and verdicts only.
import { describe, expect, it } from 'vitest';
import { traceTreeOf, flattenTree, facetsOf, applyFacets, threadsOf, capabilityWord, skillWord, type TraceRecordView, type RunRowFacts } from './run-trace-view';

const EX = 'https://agenticprimitives.dev/ns/execution#';
const rec: TraceRecordView = {
  runRef: 'run-abc', agent: '0x1111111111111111111111111111111111111111', outcome: 'completed',
  door: { kind: 'a2a-message', messageId: 'm-1', contextId: 'ctx-1', taskId: 't-1' },
  variant: { digest: 'sha256:' + 'ab'.repeat(32), plannerKind: 'model', routePolicy: 'budget', toggles: { 'retrieval/kb': 'off' } },
  modelCalls: [{ role: 'plan', provider: 'gemini', model: 'gemini-flash', routeReason: 'fits the minute', startedAt: '2026-09-26T10:00:00.000Z', endedAt: '2026-09-26T10:00:02.500Z' }, { role: 'compose', provider: 'groq', tokensIn: 900, tokensOut: 120 }],
  engagements: [{ capability: `${EX}hc-skillSelectionModel`, effect: `${EX}ee-changedPlan`, offered: ['urn:ap:capability:a', 'urn:ap:capability:b'], chose: ['urn:ap:capability:cic.board.packet'], rejected: ['urn:ap:capability:cic.stakeholder.update'] }],
  steps: [
    { stepRef: 's0', toolId: 'cic.board.packet', status: 'completed', startedAt: '2026-09-26T10:00:03.000Z', endedAt: '2026-09-26T10:00:13.000Z', skill: { id: 'skill:cil-commons/board-agenda-reporting-builder', version: '0.1.2', contractDigest: '0xdd' } },
    { stepRef: 's1', toolId: 'treasury.payment.execute', capability: { id: 'treasury.payment.execute' }, status: 'completed', authority: { decision: 'allow', afterApproval: true, presentedRef: 'mandate-000000000001' }, delegatedTo: '0x2222222222222222222222222222222222222222', delegatedToRun: 'child-run-1' },
  ],
};

describe('the run tree', () => {
  const tree = traceTreeOf(rec);
  const rows = flattenTree(tree);
  it('door → run → model calls, engagements, steps → child run, in that order', () => {
    expect(rows.map((r) => `${'  '.repeat(r.depth)}${r.node.kind}`)).toEqual(['door', '  run', '    model', '    model', '    engagement', '    step', '    step', '      child']);
    expect(tree.label).toBe('A2A message');
    expect(tree.facts).toEqual(['message m-1', 'context ctx-1', 'task t-1']);
  });
  it('the run node carries the variant; a model call its timing, tokens and route', () => {
    expect(rows[1]!.node.facts).toEqual(['completed', 'planner model', 'route budget', 'retrieval/kb=off', 'variant sha256:ababa…bab']);
    expect(rows[2]!.node.label).toBe('plan · gemini / gemini-flash');
    expect(rows[2]!.node.facts).toEqual(['2.5s', 'tokens not reported', 'route: fits the minute']);
    expect(rows[3]!.node.facts).toEqual(['900 → 120 tokens']);
  });
  it('skill selection says what it was offered, chose and rejected', () => {
    expect(rows[4]!.node.label).toBe('skill-selection/model');
    expect(rows[4]!.node.facts).toEqual(['changed-plan', '2 offered', 'chose cic.board.packet', 'rejected cic.stakeholder.update']);
  });
  it('each step says its skill and the authority column says what permitted it', () => {
    expect(rows[5]!.node.facts).toEqual(['10.0s', 'completed', 'skill cil-commons/board-agenda-reporting-builder@0.1.2']);
    expect(rows[5]!.node.authority).toBe('informational — no authority stage');
    expect(rows[6]!.node.authority).toBe('allow after approval under mandate-00…001');
    expect(rows[7]!.node.label).toBe('child run on 0x222222…222');
  });
  it('a run with no door is its own root', () => {
    expect(traceTreeOf({ ...rec, door: undefined }).kind).toBe('run');
  });
});

describe('words', () => {
  it('capability and skill ids read as words', () => {
    expect(capabilityWord(`${EX}hc-skillSelectionModel`)).toBe('skill-selection/model');
    expect(capabilityWord(`${EX}hc-retrievalKb`)).toBe('retrieval/kb');
    expect(capabilityWord(`${EX}hc-standingInstructions`)).toBe('standing-instructions');
    expect(skillWord('urn:ap:prov:skill-contract:skill:cil-commons/ai-governance-assessor@0.1.2#0xabc')).toBe('cil-commons/ai-governance-assessor');
  });
});

describe('the run list: facets and threads', () => {
  const rows: RunRowFacts[] = [
    { runRef: 'r1', at: 1, outcome: 'completed', door: { kind: 'a2a-message', contextId: 'c1' }, variant: { plannerKind: 'model' }, modelCalls: [{ role: 'plan', provider: 'gemini', model: 'gemini-flash' }], skills: ['skill:cil-commons/a'], tools: ['cic.a'] },
    { runRef: 'r2', at: 5, outcome: 'completed', door: { kind: 'a2a-message', contextId: 'c1' }, variant: { plannerKind: 'declared' }, skills: ['skill:cil-commons/b'], tools: ['cic.b'] },
    { runRef: 'r3', at: 3, outcome: 'failed', door: { kind: 'harness-ask' }, variant: { plannerKind: 'model' }, tools: ['ask.unsupported'] },
  ];
  it('counts every facet value', () => {
    const f = facetsOf(rows);
    expect(f.planner).toEqual([{ value: 'model', count: 2 }, { value: 'declared', count: 1 }]);
    expect(f.skill).toEqual([{ value: 'cil-commons/a', count: 1 }, { value: 'cil-commons/b', count: 1 }]);
    expect(f.door).toEqual([{ value: 'a2a-message', count: 2 }, { value: 'harness-ask', count: 1 }]);
    expect(f.model).toEqual([{ value: 'gemini-flash', count: 1 }]);
  });
  it('filters by every selected value', () => {
    expect(applyFacets(rows, { planner: 'model' }).map((r) => r.runRef)).toEqual(['r1', 'r3']);
    expect(applyFacets(rows, { planner: 'model', door: 'harness-ask' }).map((r) => r.runRef)).toEqual(['r3']);
    expect(applyFacets(rows, {}).length).toBe(3);
  });
  it('groups a conversation into one thread by its A2A contextId, newest first', () => {
    const t = threadsOf(rows);
    expect(t.map((x) => [x.id, x.runs.map((r) => r.runRef)])).toEqual([['ctx:c1', ['r1', 'r2']], ['run:r3', ['r3']]]);
  });
});
