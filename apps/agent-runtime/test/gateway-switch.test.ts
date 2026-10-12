import { describe, it, expect, vi, afterEach } from 'vitest';
import { gatewayOn, selectPlanner, selectComposer, GATEWAY_PROFILE } from '../src/orchestration.js';
import { structuredCallFor, textStreamFor } from '../src/context-wiring.js';

const env = { ORCHESTRATION_GATEWAY: 'on', INFERENCE_URL: 'https://inference.example', INFERENCE_APP_KEY: 'apk_test', ORCHESTRATION_LLM: 'gemini', GEMINI_API_KEY: 'g' } as never;
const receipt = { id: 'rcpt-9', profile: 'planner-fast', profileVersion: '0xv', provider: 'openai-compat', model: 'flash-lite', attempt: 1, policyDecision: { allowed: true }, costMicroUsd: 3, latencyMs: 50, reconciliation: 'settled' };
const answer = (content: string, toolCalls: Array<{ name: string; args: Record<string, unknown> }> = []) => Response.json({ content, toolCalls, stopReason: toolCalls.length ? 'tool' : 'end', usage: { tokensIn: 5, tokensOut: 2 }, receipt });

afterEach(() => vi.unstubAllGlobals());

describe('spec 434 W3 — the gateway switch', () => {
  it('is off unless the flag, the URL and the key are all set', () => {
    expect(gatewayOn({})).toBe(false);
    expect(gatewayOn({ ORCHESTRATION_GATEWAY: 'on', INFERENCE_URL: 'https://x' })).toBe(false);
    expect(gatewayOn(env)).toBe(true);
  });
  it('the planner runs through the gateway by PROFILE and the receipt reaches onReceipt', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown>; auth: string }> = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => { calls.push({ url, body: JSON.parse(String(init.body)), auth: String((init.headers as Record<string, string>).authorization) }); return answer('', [{ name: String((JSON.parse(String(init.body)).tools as Array<{ name: string }>)[0]!.name), args: { q: 'x' } }]); });
    const receipts: string[] = [];
    const sel = selectPlanner({ ...env }, { systemPrompt: 'S', maxTokens: 512, onReceipt: (r) => receipts.push(r.id) });
    expect(sel.kind).toBe('gateway');
    expect(sel.model).toBe(GATEWAY_PROFILE.plan);
    const plan = await sel.planner.plan({ intent: { goal: 'do it' }, tools: [{ id: 'do-it', description: 'd', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } }] } as never);
    expect(plan.steps[0]?.toolId).toBe('do-it');
    expect(calls[0]?.url).toBe('https://inference.example/v1/generate');
    expect(calls[0]?.auth).toBe('Bearer apk_test');
    expect(calls[0]?.body.profile).toBe('planner-fast');
    expect(JSON.stringify(calls[0]?.body)).not.toContain('gemini');
    expect(receipts).toEqual(['rcpt-9']);
  });
  it('the composer, the structured call and the text stream take the gateway too', async () => {
    const seen: string[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => { const b = JSON.parse(String(init.body)); seen.push(b.profile); return b.stream ? new Response('data: {"type":"delta","text":"hi"}\n\ndata: {"type":"done","response":{"content":"hi","toolCalls":[],"stopReason":"end","usage":{"tokensIn":1,"tokensOut":1},"receipt":' + JSON.stringify(receipt) + '}}\n\n', { headers: { 'content-type': 'text/event-stream' } }) : answer(b.tools ? '' : 'composed', b.tools ? [{ name: 'pick', args: { a: 1 } }] : []); });
    const e2 = { ...env };
    const composer = selectComposer(e2, {});
    expect(await composer!.compose({ intent: { goal: 'g' }, observations: [] } as never)).toBe('composed');
    const records: Array<{ provider: string; receiptRef?: string }> = [];
    const structured = structuredCallFor(e2, undefined, { onCall: (c) => records.push(c) });
    expect(await structured!({ system: 's', messages: [{ role: 'user', content: 'u' }], tool: { name: 'pick', description: 'd', input_schema: { type: 'object' } } } as never)).toMatchObject({ a: 1 });
    const stream = textStreamFor(e2, undefined, { onCall: (c) => records.push(c) });
    const deltas: string[] = [];
    expect(await stream!({ system: 's', messages: [{ role: 'user', content: 'u' }], onDelta: (d) => deltas.push(d) } as never)).toBe('hi');
    expect(seen).toEqual([GATEWAY_PROFILE.compose, GATEWAY_PROFILE.structured, GATEWAY_PROFILE.stream]);
    expect(records.map((r) => [r.provider, r.receiptRef])).toEqual([['gateway', 'rcpt-9'], ['gateway', 'rcpt-9']]);
    expect(deltas).toEqual(['hi']);
  });
  it('with the flag off nothing changes: the direct provider is selected', () => {
    const sel = selectPlanner({ ...env, ORCHESTRATION_GATEWAY: 'off' } as never, {});
    expect(sel.kind).toBe('gemini');
  });
});
