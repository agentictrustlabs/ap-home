// Spec 400 W1c — the wake path in the Worker, with no network: a wake for a URL host is one POST /wake carrying the
// member, thread and message id and NOTHING else; what the host reports becomes the receipt on the member's object;
// an unreachable host is a receipt saying so, not a retry storm; a malformed queue message is acked and dropped;
// the host declaration parses strictly (a wake target is config, and a bad one is refused, not guessed).
import { describe, it, expect } from 'vitest';
import { parseRuntimeHost, deliverRuntimeWake, consumeRuntimeWakes, enqueueRuntimeWake, type WakeMessageV1, type WakeReceiptV1 } from '../src/runtime-wake.js';
import type { Env } from '../src/index.js';

const MEMBER = '0x00000000000000000000000000000000000000aa';

function fakeEnv(sent: unknown[], receipts: Array<{ member: string; receipt: WakeReceiptV1 }>): Env {
  return {
    A2A_INTERNAL_MARKER: 'marker-for-tests-0123456789abcdef',
    RUNTIME_WAKE: { send: async (m: unknown) => { sent.push(m); } },
    INTERACTIONS: {
      idFromName: (n: string) => n,
      get: (id: string) => ({ fetch: async (req: Request) => { const b = await req.json() as { receipt: WakeReceiptV1 }; receipts.push({ member: id, receipt: b.receipt }); return new Response(JSON.stringify({ ok: true })); } }),
    },
  } as unknown as Env;
}

describe('runtime wake (W1c)', () => {
  it('parses a host declaration strictly', () => {
    expect(parseRuntimeHost({ v: 1, kind: 'container' })).toEqual({ v: 1, kind: 'container' });
    expect(parseRuntimeHost({ v: 1, kind: 'url', url: 'https://runtime.example/' })).toEqual({ v: 1, kind: 'url', url: 'https://runtime.example' });
    expect(parseRuntimeHost({ v: 1, kind: 'url', url: 'ftp://x' })).toBeNull();
    expect(parseRuntimeHost({ v: 2, kind: 'container' })).toBeNull();
    expect(parseRuntimeHost('container')).toBeNull();
    expect(parseRuntimeHost(null)).toBeNull();
  });

  it('enqueues one wake with the member, the thread and the message id — no content, no authority', async () => {
    const sent: unknown[] = [];
    const env = fakeEnv(sent, []);
    const ok = await enqueueRuntimeWake(env, { member: MEMBER, memberName: 'goose-1.svc', conversationId: 'dm:alice', messageId: 'm1', host: { v: 1, kind: 'url', url: 'https://runtime.example' } });
    expect(ok).toBe(true);
    expect(sent).toHaveLength(1);
    const m = sent[0] as WakeMessageV1;
    expect(m).toMatchObject({ v: 1, member: MEMBER, memberName: 'goose-1.svc', conversationId: 'dm:alice', messageId: 'm1', host: { kind: 'url' } });
    expect(Object.keys(m).sort()).toEqual(['at', 'conversationId', 'host', 'member', 'memberName', 'messageId', 'v']);
    const { RUNTIME_WAKE: _q, ...unbound } = env as unknown as Record<string, unknown>;
    expect(await enqueueRuntimeWake(unbound as unknown as Env, { member: MEMBER, memberName: null, conversationId: 'c', messageId: 'm', host: { v: 1, kind: 'container' } })).toBe(false);
  });

  it('delivers a wake to a URL host and keeps what the host reported as the receipt on the member', async () => {
    const receipts: Array<{ member: string; receipt: WakeReceiptV1 }> = [];
    const env = fakeEnv([], receipts);
    const posts: Array<{ url: string; body: unknown }> = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      posts.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ ok: true, member: 'goose-1.svc', cursor: 'm1', turns: [{ messageId: 'm1', from: '0xbb', fromName: 'alice.me', conversationId: 'dm:alice', answer: 'the plan, in brief', reply: 'parked: run run-7 waits for the steward\'s signature', parkedRunRef: 'run-7' }] }));
    };
    const wake: WakeMessageV1 = { v: 1, member: MEMBER, memberName: 'goose-1.svc', conversationId: 'dm:alice', messageId: 'm1', host: { v: 1, kind: 'url', url: 'https://runtime.example' }, at: '2026-09-13T10:00:00Z' };
    const r = await deliverRuntimeWake(env, wake, fetchImpl);
    expect(posts).toEqual([{ url: 'https://runtime.example/wake', body: { v: 1, member: 'goose-1.svc', conversationId: 'dm:alice', messageId: 'm1' } }]);
    expect(r.outcome).toBe('woken');
    expect(r.turns[0]!.parkedRunRef).toBe('run-7');
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.member).toBe(MEMBER);
    expect(receipts[0]!.receipt).toMatchObject({ v: 1, messageId: 'm1', outcome: 'woken', status: 200, enqueuedAt: '2026-09-13T10:00:00Z' });
  });

  it('an unreachable host is a receipt that says so; a container host with no binding likewise', async () => {
    const receipts: Array<{ member: string; receipt: WakeReceiptV1 }> = [];
    const env = fakeEnv([], receipts);
    const down: typeof fetch = async () => { throw new Error('connect ECONNREFUSED'); };
    const r = await deliverRuntimeWake(env, { v: 1, member: MEMBER, memberName: null, conversationId: 'c', messageId: 'm2', host: { v: 1, kind: 'url', url: 'https://runtime.example' }, at: 'now' }, down);
    expect(r).toMatchObject({ outcome: 'unreachable', status: null, error: 'connect ECONNREFUSED', turns: [] });
    const c = await deliverRuntimeWake(env, { v: 1, member: MEMBER, memberName: null, conversationId: 'c', messageId: 'm3', host: { v: 1, kind: 'container' }, at: 'now' });
    expect(c.outcome).toBe('unreachable');
    expect(c.error).toMatch(/RUNTIME .*unbound/);
    expect(receipts.map((x) => x.receipt.messageId)).toEqual(['m2', 'm3']);
  });

  it('the consumer acks every message — a malformed one is dropped, never retried', async () => {
    const env = fakeEnv([], []);
    const acked: string[] = [];
    const batch = { queue: 'runtime-wake', messages: [
      { id: 'a', body: { nope: true }, ack: () => acked.push('a'), retry: () => { throw new Error('retried'); } },
      { id: 'b', body: { v: 1, member: MEMBER, memberName: null, conversationId: 'c', messageId: 'm9', host: { v: 1, kind: 'url', url: 'not a url' }, at: 'now' }, ack: () => acked.push('b'), retry: () => { throw new Error('retried'); } },
    ] } as unknown as MessageBatch<unknown>;
    await consumeRuntimeWakes(batch, env);
    expect(acked).toEqual(['a', 'b']);
  });
});
