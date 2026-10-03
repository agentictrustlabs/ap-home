import { describe, it, expect } from 'vitest';
import { executorInvokeInvoker, readExecutors, type ExecutorsV1 } from '../../src/executor-invoke.js';
import type { ExecutorInvokeV1 } from '@agenticprimitives/orchestration';

const PRINCIPAL = '0x8482b1963f8435c111ffc57aa3b4754addb1a2a5' as const;
const INVOKE: ExecutorInvokeV1 = { transport: 'a2a.message-send', executor: 'field-circles', intent: 'field.records-save', args: { goal: 'goal', metadata: ['team', 'kind'] } };
const EXECUTORS: ExecutorsV1 = { 'field-circles': { url: 'https://field.example', client: 'field-app' } };

// A fetch that records the one call and answers with `result` (success) or `error` (refusal).
const recorder = (calls: Array<{ url: string; auth?: string; body: Record<string, unknown> }>, answer: { result?: unknown; error?: unknown }, status = 200) =>
  (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), auth: (init?.headers as Record<string, string>)?.authorization, body: JSON.parse(String(init?.body)) });
    return { ok: status < 400, status, json: async () => answer } as unknown as Response;
  }) as typeof fetch;

const ctx = { index: 0, step: { id: 's0' } } as never;

describe('spec 426 — readExecutors (fail-closed operator config)', () => {
  it('parses a valid map and drops malformed entries', () => {
    expect(readExecutors(JSON.stringify({ a: { url: 'https://a', client: 'c' }, bad: { url: 'https://b' } }))).toEqual({ a: { url: 'https://a', client: 'c' } });
  });
  it('absent or malformed config is empty (no guessed host)', () => {
    expect(readExecutors(undefined)).toEqual({});
    expect(readExecutors('not json')).toEqual({});
  });
});

describe('spec 426 — executorInvokeInvoker', () => {
  it('calls the resolved executor as the principal: message/send, metadata.skill, Bearer', async () => {
    const calls: Array<{ url: string; auth?: string; body: Record<string, unknown> }> = [];
    const seen: Array<{ principal: string; client: string }> = [];
    const inv = executorInvokeInvoker({
      executors: EXECUTORS,
      session: async (p, c) => { seen.push({ principal: p, client: c }); return 'idtok'; },
      fetch: recorder(calls, { result: { storedIn: 'vault://x', recordId: 'r1' } }),
    }, INVOKE, PRINCIPAL);
    const r = await inv('field.records-save', { goal: 'baptism today', team: '0xorg', kind: 'activity' }, ctx) as { receipt?: Record<string, unknown>; refused?: string };
    expect(r.refused).toBeUndefined();
    expect(r.receipt).toEqual({ storedIn: 'vault://x', recordId: 'r1' });
    // session minted for the principal, scoped to the executor's client
    expect(seen).toEqual([{ principal: PRINCIPAL, client: 'field-app' }]);
    // the one call: to <url>/a2a, Bearer the session, message/send with the goal as text + metadata.skill = intent
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://field.example/a2a');
    expect(calls[0]!.auth).toBe('Bearer idtok');
    const msg = (calls[0]!.body as { params: { message: { parts: Array<{ text: string }>; metadata: Record<string, unknown> } } }).params.message;
    expect(msg.parts[0]!.text).toBe('baptism today');
    expect(msg.metadata).toEqual({ skill: 'field.records-save', team: '0xorg', kind: 'activity' });
  });

  it('refuses when no executor is configured (fail-closed)', async () => {
    const inv = executorInvokeInvoker({ executors: {}, session: async () => 'idtok' }, INVOKE, PRINCIPAL);
    const r = await inv('field.records-save', { goal: 'x' }, ctx) as { refused?: string };
    expect(r.refused).toMatch(/no executor is configured/);
  });

  it('refuses when the session seam returns null (no silent success)', async () => {
    const inv = executorInvokeInvoker({ executors: EXECUTORS, session: async () => null }, INVOKE, PRINCIPAL);
    const r = await inv('field.records-save', { goal: 'x' }, ctx) as { refused?: string };
    expect(r.refused).toMatch(/could not obtain a session/);
  });

  it('refuses with no principal and with a missing goal', async () => {
    expect((await executorInvokeInvoker({ executors: EXECUTORS, session: async () => 'idtok' }, INVOKE, undefined)('field.records-save', { goal: 'x' }, ctx) as { refused?: string }).refused).toMatch(/no principal/);
    expect((await executorInvokeInvoker({ executors: EXECUTORS, session: async () => 'idtok' }, INVOKE, PRINCIPAL)('field.records-save', {}, ctx) as { refused?: string }).refused).toMatch(/needs goal/);
  });

  it('refuses with the executor\'s own reason on an error (no fallback)', async () => {
    const inv = executorInvokeInvoker({ executors: EXECUTORS, session: async () => 'idtok', fetch: recorder([], { error: { data: { error: 'not a member of that team' } } }, 403) }, INVOKE, PRINCIPAL);
    const r = await inv('field.records-save', { goal: 'x' }, ctx) as { refused?: string };
    expect(r.refused).toBe('not a member of that team');
  });
});
