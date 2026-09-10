import { describe, it, expect } from 'vitest';
import { buildFlowTrace, flowIdOf, summarizeOutput } from '../src/flow-trace.js';

describe('spec 387 W2 — the flow trace on the agent\'s task', () => {
  it('echoes only a well-formed flow id from the message metadata', () => {
    expect(flowIdOf({ metadata: { flowId: 'fl-1a2b3c4d' } })).toBe('fl-1a2b3c4d');
    expect(flowIdOf({ metadata: { flowId: 'x' } })).toBeNull();
    expect(flowIdOf({ metadata: { flowId: '<script>' } })).toBeNull();
    expect(flowIdOf(undefined)).toBeNull();
  });
  it('summarizes a result to counts, flags and sources — never the rows', () => {
    const s = summarizeOutput({ count: 20, total: 240, resources: [{ title: 't', url: 'u' }], source: { agent: 'ligonier.svc', tool: 'search_resources', ms: 120 }, interpretation: 'x'.repeat(500) });
    expect(s).toMatchObject({ count: 20, total: 240, resourcesCount: 1, source: { tool: 'search_resources' } });
    expect(s).not.toHaveProperty('resources');
    expect(String(s!.interpretation).length).toBe(240);
    expect(summarizeOutput({ refused: 'no catalog' })).toEqual({ refused: 'no catalog' });
    expect(summarizeOutput('plain')).toEqual({ text: 'plain' });
  });
  it('orders the run\'s steps from its events, joining each with the plan\'s args and the result summary', () => {
    const trace = buildFlowTrace({
      flowId: 'fl-test0001', runRef: 'svc-1', agent: '0xabc', asker: '0xdef', startedAt: Date.now() - 50, artifacts: ['results', 'trace'],
      reply: {
        kind: 'answer', text: '# Six-Week Study', results: [{ toolId: 'catalog.resource.search', result: { count: 20, total: 240, resources: [{}], source: { tool: 'search_resources', ms: 90 } } }],
        plannerTrace: { planner: 'groq', model: 'openai/gpt-oss-120b', toolsExposed: ['catalog.resource.search', 'catalog.topic.list'], plan: [{ toolId: 'catalog.resource.search', args: { topic: 'justification', limit: 20 } }], playbook: { archetypeId: 'content-catalog', archetypeVersion: '1', digest: '0x1' } },
      },
      events: [
        { type: 'RunStarted', runRef: 'svc-1', intent: { goal: 'g' } as never, presentedRef: null },
        { type: 'PlanCreated', runRef: 'svc-1', steps: 1 },
        { type: 'StepProposed', runRef: 'svc-1', stepRef: 's0', toolId: 'catalog.resource.search', risk: 'informational' as never },
        { type: 'ToolInvoked', runRef: 'svc-1', stepRef: 's0', toolId: 'catalog.resource.search', ok: true },
        { type: 'RunCompleted', runRef: 'svc-1' },
      ],
    });
    expect(trace).toMatchObject({ kind: 'ap.flow-trace.v1', hop: 'agent', flowId: 'fl-test0001', playbook: { archetypeId: 'content-catalog' }, planner: { kind: 'groq', model: 'openai/gpt-oss-120b', toolsExposed: ['catalog.resource.search', 'catalog.topic.list'] }, reply: { kind: 'answer', chars: 16, artifacts: ['results', 'trace'] } });
    expect(trace.steps).toEqual([{ stepRef: 's0', toolId: 'catalog.resource.search', ok: true, args: { topic: 'justification', limit: 20 }, output: { count: 20, total: 240, resourcesCount: 1, source: { tool: 'search_resources', ms: 90 } } }]);
    expect(trace.events.map((e) => e.type)).toEqual(['RunStarted', 'PlanCreated', 'StepProposed', 'ToolInvoked', 'RunCompleted']);
    expect(trace.ms).toBeGreaterThanOrEqual(50);
  });
});
