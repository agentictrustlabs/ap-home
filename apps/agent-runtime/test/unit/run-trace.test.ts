// Spec 414 A1b — the trace from the door, as this deployment fills it: the A2A ids, a body-named door believed only
// on an in-process hop, the model calls from the planner's trace (no estimated tokens), the variant from the knobs —
// and a record built that way projects a graph that names its door and its variant.
import { describe, expect, it } from 'vitest';
import type { RunRecordV1 } from '@agenticprimitives/orchestration';
import { a2aDoor, doorFromBody, modelCallsOf, plannerKindOf, variantOf } from '../../src/run-trace.js';
import { provenanceGraphOf } from '../../src/run-export.js';

const trace = {
  planner: 'groq', model: 'openai/gpt-oss-120b', toolsExposed: [], playbook: { archetypeId: 'skill:x/y', archetypeVersion: '1.0.0', digest: '0x' + '33'.repeat(32) },
  promptDigest: '0x' + 'ee'.repeat(32), examplesRendered: 2, promptBudget: { tokens: 6000, estimated: 5400, trimmed: [] },
  route: { policy: 'budget', planner: { provider: 'groq', because: 'fits the minute', considered: [] }, composer: { provider: 'anthropic', because: 'groq minute spent', considered: [] }, structured: [{ provider: 'groq', because: 'kb chooser', considered: [] }] },
} as never;

describe('doors', () => {
  it('an A2A message door carries message, context and task ids', () => {
    expect(a2aDoor({ messageId: 'm', contextId: 'c' }, { id: 't', contextId: 'c2' })).toEqual({ kind: 'a2a-message', messageId: 'm', contextId: 'c', taskId: 't' });
    expect(a2aDoor({ messageId: 'm' }, { id: 't', contextId: 'c2' })).toEqual({ kind: 'a2a-message', messageId: 'm', contextId: 'c2', taskId: 't' });
  });
  it('a door named in a body is believed only on the in-Worker hop, and only as an A2A door with bounded ids', () => {
    const body = { door: { kind: 'a2a-message', messageId: 'm', contextId: 'x'.repeat(200) } };
    expect(doorFromBody(body, false)).toBeNull();
    expect(doorFromBody(body, true)).toEqual({ kind: 'a2a-message', messageId: 'm' });
    expect(doorFromBody({ door: { kind: 'trigger' } }, true)).toBeNull();
  });
});

describe('model calls and the variant', () => {
  it('the plan, the composer and each structured call — with no estimated token count', () => {
    const calls = modelCallsOf(trace, [{ name: 'reply:compose', startMs: 10, endMs: 20 }]);
    expect(calls).toEqual([
      { role: 'plan', model: 'openai/gpt-oss-120b', provider: 'groq', promptDigest: '0x' + 'ee'.repeat(32), routeReason: 'fits the minute' },
      { role: 'compose', provider: 'anthropic', routeReason: 'groq minute spent', startMs: 10, endMs: 20 },
      { role: 'structured', provider: 'groq', routeReason: 'kb chooser' },
    ]);
    expect(JSON.stringify(calls)).not.toContain('5400');
  });
  it('a supplied or compiled plan made no plan call', () => {
    expect(modelCallsOf({ ...(trace as object), planner: 'compiled', route: undefined } as never)).toEqual([]);
    expect([plannerKindOf('supplied'), plannerKindOf('compiled'), plannerKindOf('anthropic')]).toEqual(['supplied', 'compiled', 'model']);
  });
  it('the variant: playbook, planner kind, route policy, build, toggles', () => {
    expect(variantOf({ KB_RETRIEVAL: 'playbook', HARNESS_BUILD: 'v-9' }, trace)).toEqual({ playbook: '0x' + '33'.repeat(32), plannerKind: 'model', routePolicy: 'budget', build: 'v-9', toggles: { 'retrieval/kb': 'playbook' } });
    expect(variantOf({}, undefined)).toEqual({});
  });
});

describe('a record built at an entrance projects its door and its variant', () => {
  it('the graph names both', async () => {
    const ALICE = '0xb0d11ce19b756a682e78b4904cd8d832303b3d11';
    const record: RunRecordV1 = {
      type: 'ap.run-record.v1', runRef: 'run-e', at: 1_788_920_800_000,
      intent: { goal: 'who is in missio nexus', context: { addressee: ALICE, asker: ALICE } },
      plan: { steps: [] }, steps: [], receipts: [], events: [], outcome: 'completed',
      door: a2aDoor({ messageId: 'm-1' }, { id: 't-1', contextId: 'c-1' }), modelCalls: modelCallsOf(trace), variant: variantOf({}, trace),
    };
    const doc = await provenanceGraphOf({ CHAIN_ID: '34348' }, ALICE, record) as { graph: Array<Record<string, unknown>> };
    const run = doc.graph.find((n) => n['id'] === 'urn:ap:prov:act:run-e')!;
    expect(run['arrivedBy']).toBe('urn:ap:prov:door:run-e');
    expect(String(run['underVariant'])).toMatch(/^urn:ap:prov:variant:sha256:[0-9a-f]{64}$/);
    expect(run['hasModelInvocation']).toHaveLength(3);
    expect(doc.graph.find((n) => n['id'] === 'urn:ap:prov:door:run-e')).toMatchObject({ doorKind: 'a2a-message', a2aMessageId: 'm-1', a2aTaskId: 't-1', a2aContextId: 'c-1' });
    expect(JSON.stringify(doc)).not.toContain('missio nexus');
  });
});

describe('engagedFromTrace — what only the planner trace can see', () => {
  it('standing instructions and confirmation memory that supplied a binding; an admission that changed nothing', async () => {
    const { engagedFromTrace } = await import('../../src/run-trace.js');
    const t = { bindings: [{ arg: 'payee', raw: 'x', agent: '0x1', source: 'standing' }, { arg: 'from', raw: 'y', agent: '0x2', source: 'memory' }], admission: [{ refused: [], replanned: false }] } as never;
    expect(engagedFromTrace(t)).toEqual([{ capability: 'standing-instructions', effect: 'changed-plan' }, { capability: 'confirmation-memory', effect: 'changed-plan' }, { capability: 'plan-admission', effect: 'no-change' }]);
    expect(engagedFromTrace({ bindings: [], admission: [{ refused: [{ code: 'x', message: 'y' }], replanned: true }] } as never)).toEqual([]);
    expect(engagedFromTrace(undefined)).toEqual([]);
  });
});
