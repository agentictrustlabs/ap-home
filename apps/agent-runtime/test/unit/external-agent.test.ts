// AN OUTSIDE AGENT AS A STEP — spec 379. The standard client against a real standard server (in memory),
// the tool's observation with its source and pinned card, and the admission rule that lets an outside
// executor answer and never act.
import { describe, expect, it } from 'vitest';
import { createStandardA2aServer, createMemoryTaskStore, createStandardA2aClient, resolveAgentCard, type AgentCardV1 } from '@agenticprimitives/a2a/standard';
import { externalExecutorsReadOnly, type ToolSpec } from '@agenticprimitives/orchestration';
import { externalAgentInvoker, EXTERNAL_AGENT_TOOL } from '../../src/external-agent.js';

const card: AgentCardV1 = { name: 'clock.external', description: 'tells the time', version: '1', supportedInterfaces: [{ url: 'https://clock.example/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }], capabilities: {}, defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'], skills: [], provider: { organization: 'clock', url: 'https://clock.example' } };
const server = createStandardA2aServer({ card, tasks: createMemoryTaskStore(), executor: { execute: async (ctx) => { const t = ctx.message.parts.map((p) => p.text ?? '').join(' '); await ctx.complete([{ text: `you asked “${t}”; it is noon` }]); } } });
const cardText = JSON.stringify(card);
const fetchImpl = (async (url: string, init?: RequestInit) => {
  if (url === 'https://clock.example/card') return new Response(cardText, { headers: { 'content-type': 'application/json' } });
  if (url === 'https://clock.example/a2a') return server.handle(new Request(url, init));
  return new Response('nope', { status: 404 });
}) as unknown as typeof fetch;

describe('the standard client', () => {
  it('resolves a card, pins its digest, and asks — the answer is the task\'s words', async () => {
    const r = await resolveAgentCard('https://clock.example/card', fetchImpl);
    expect(r.endpoint).toBe('https://clock.example/a2a');
    expect(r.cardDigest).toMatch(/^0x[0-9a-f]{64}$/);
    await expect(resolveAgentCard('https://clock.example/card', fetchImpl, '0xdeadbeef')).rejects.toThrow(/not the one pinned/);
    await expect(resolveAgentCard('http://clock.example/card', fetchImpl)).rejects.toThrow(/https only/);
    const c = createStandardA2aClient({ endpoint: r.endpoint, fetch: fetchImpl });
    const a = await c.ask('what time is it');
    expect(a.text).toMatch(/it is noon/);
    expect(a.task?.status.state).toBe('TASK_STATE_COMPLETED');
  });
});

describe('the tool', () => {
  it('answers with an observation that names its source and pinned card, and refuses anything that is not a card URL', async () => {
    const inv = externalAgentInvoker({ fetch: fetchImpl });
    const out = await inv(EXTERNAL_AGENT_TOOL.id, { agent: 'https://clock.example/card', question: 'what time is it' }, { step: { id: 's0' } } as never) as Record<string, unknown>;
    expect(out.observation).toMatch(/it is noon/);
    expect(out.attributedTo).toBe('https://clock.example');
    expect((out.agent as { cardDigest: string }).cardDigest).toMatch(/^0x/);
    expect(String(out.note)).toMatch(/never authority/);
    const bad = await inv(EXTERNAL_AGENT_TOOL.id, { agent: 'clock.external', question: 'x' }, { step: { id: 's0' } } as never) as { refused?: string };
    expect(bad.refused).toMatch(/card URL/);
    expect(EXTERNAL_AGENT_TOOL.capability).toBeUndefined();
  });
});

describe('admission: an outside executor answers, never acts', () => {
  const tools: ToolSpec[] = [EXTERNAL_AGENT_TOOL, { id: 'treasury.payment.execute', description: 'pay', inputSchema: { type: 'object', properties: {} }, capability: { id: 'treasury.payment.execute', action: 'execute' }, risk: 'high' }];
  const rule = externalExecutorsReadOnly((ex) => /^https:\/\//.test(ex));
  it('REFUSES a value-moving step aimed at an outside agent, and admits a read there', async () => {
    const v = await rule({ intent: { goal: 'pay nathan 1 usdc' }, plan: { steps: [{ toolId: 'treasury.payment.execute', args: { payee: 'nathan.treasury', usdc: '1' }, executor: 'https://clock.example/card' }] }, tools });
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ code: 'EXTERNAL_EXECUTOR_ACT', recovery: 'refuse', field: 'executor' });
    const ok = await rule({ intent: { goal: 'ask the clock' }, plan: { steps: [{ toolId: EXTERNAL_AGENT_TOOL.id, args: { agent: 'https://clock.example/card', question: 'time?' }, executor: 'https://clock.example/card' }] }, tools });
    expect(ok).toEqual([]);
    const local = await rule({ intent: { goal: 'pay' }, plan: { steps: [{ toolId: 'treasury.payment.execute', args: {}, executor: '0x309b2a566e93cc77aabe895d0ec2702c36856ebd' }] }, tools });
    expect(local).toEqual([]);
  });
});
