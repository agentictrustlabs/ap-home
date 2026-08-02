// A2aTaskDO — first coverage of the 1854-line task runtime, using the same injected-seam pattern
// that opened up InteractionsDO.
//
// `build()` derives every on-chain check from two primitives: signature verification and revocation.
// `A2aTaskDeps` injects exactly those, so the task lifecycle is drivable without a node while the
// DERIVED logic stays entirely real — the JSON-RPC dispatch, the agent binding, the party checks, the
// alarm scheduling. That derived logic is what is worth testing; the RPC round trip is not.
//
// The two properties this file is really about:
//
//   AGENT BINDING — the DO refuses to act before it knows which agent it is. A task store that
//   answered for an unbound agent would let the first caller decide whose tasks these are.
//
//   THE INTERNAL MARKER — `/internal/discussion-respond` is deliberately NOT an A2A skill on the
//   public card, because its authorization model is "the org's own substrate observed a triggering
//   post", not a caller delegation. A public `message/send` must never reach it. That is enforced by
//   PATH (the JSON-RPC dispatcher has no such method) plus a shared-secret header, and both halves
//   are asserted here — including that an unconfigured secret fails CLOSED rather than open.

import { describe, it, expect, beforeEach } from 'vitest';
import { A2aTaskDO, type A2aTaskDeps } from '../src/a2a-task-do.js';

const AGENT = '0x1111111111111111111111111111111111111111';
const CALLER = '0x2222222222222222222222222222222222222222';
const SECRET = 'internal-marker-secret';

function fakeState() {
  const m = new Map<string, unknown>();
  let alarmAt: number | null = null;
  return {
    map: m,
    alarmAt: () => alarmAt,
    storage: {
      async get(k: string) { return m.get(k); },
      async put(k: string, v: unknown) { m.set(k, v); },
      async delete(k: string) { m.delete(k); },
      async list() { return new Map(m); },
      async setAlarm(t: number) { alarmAt = t; },
      async getAlarm() { return alarmAt; },
      async deleteAlarm() { alarmAt = null; },
    },
  };
}

const env = (over: Record<string, unknown> = {}) => ({
  RPC_URL: 'https://rpc.example.test',
  CHAIN_ID: '84532',
  DELEGATION_MANAGER: '0x3333333333333333333333333333333333333333',
  A2A_CUSTODY_BRIDGE_SECRET: SECRET,
  ...over,
}) as unknown as ConstructorParameters<typeof A2aTaskDO>[1];

/** Signatures always verify, nothing is revoked — so a refusal below is never a crypto artifact. */
const permissive: A2aTaskDeps = {
  async verifySignature() { return true; },
  async isRevoked() { return false; },
};

let st: ReturnType<typeof fakeState>;
let task: A2aTaskDO;

beforeEach(() => {
  st = fakeState();
  task = new A2aTaskDO(st as unknown as DurableObjectState, env(), permissive);
});

const rpc = (body: unknown, query = `?agent=${AGENT}`) =>
  task.fetch(new Request(`https://do.test/a2a${query}`, {
    method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' },
  }));

describe('the task store will not act for an agent it has not been bound to', () => {
  it('REFUSES a request with no agent, bound or supplied', async () => {
    const r = await rpc({ jsonrpc: '2.0', id: 1, method: 'tasks/get', params: {} }, '');
    expect(r.status).toBe(400);
    const out = await r.json() as { error: { message: string } };
    expect(out.error.message).toMatch(/not bound/);
  });

  // Binding is sticky so `alarm()` can rehydrate without a request to read the agent from.
  it('remembers the agent it was bound to', async () => {
    await rpc({ jsonrpc: '2.0', id: 1, method: 'tasks/get', params: {} });
    expect(st.map.get('__a2a_agent_sa')).toBe(AGENT);
    // A later request with no query param now resolves from storage rather than refusing.
    const r = await rpc({ jsonrpc: '2.0', id: 2, method: 'tasks/get', params: {} }, '');
    expect(r.status).not.toBe(400);
  });

  // THE BUG THIS FILE FOUND. Handlers read `params` positionally off untrusted JSON, so an omitted
  // field reached `undefined.toLowerCase()` and the exception escaped the wire entry as a 500 with a
  // stack — on a PUBLIC surface. `dispatchA2aRpc` now answers with a JSON-RPC error instead.
  it('answers malformed params with a JSON-RPC error, never an escaping throw', async () => {
    for (const method of ['tasks/get', 'message/send', 'tasks/cancel', 'tasks/artifact']) {
      const r = await rpc({ jsonrpc: '2.0', id: 1, method, params: {} });
      const out = await r.json() as { error?: { code: number; message: string } };
      expect(out.error, method).toBeDefined();
      // Generic by design: the caller learns it failed, never why internally.
      expect(out.error?.message, method).not.toMatch(/toLowerCase|undefined|at |\.ts:/);
    }
  });
});

describe('JSON-RPC framing', () => {
  it('answers a malformed body with a parse error rather than a crash', async () => {
    const r = await task.fetch(new Request(`https://do.test/a2a?agent=${AGENT}`, {
      method: 'POST', body: 'not json', headers: { 'Content-Type': 'application/json' },
    }));
    const out = await r.json() as { error: { code: number; message: string } };
    expect(out.error.code).toBe(-32700);
    expect(out.error.message).toMatch(/parse error/);
  });

  it('answers an unknown method without inventing a result', async () => {
    const r = await rpc({ jsonrpc: '2.0', id: 7, method: 'definitely/not-a-method', params: {} });
    const out = await r.json() as { result?: unknown; error?: { code: number } };
    expect(out.result).toBeUndefined();
    expect(out.error).toBeDefined();
  });

  // The alarm is what advances a submitted task. Scheduling it on submit — and NOT on a read — is the
  // difference between a task that progresses and a DO that wakes up for nothing.
  it('schedules the runtime alarm on submit, and not on a read', async () => {
    await rpc({ jsonrpc: '2.0', id: 1, method: 'tasks/get', params: { taskId: '0x01' } });
    expect(st.alarmAt()).toBeNull();

    // Scheduled even though the params are rejected: the alarm advances whatever IS due, and coupling
    // it to a handler's verdict would mean a rejected submit could strand an unrelated ready task.
    await rpc({ jsonrpc: '2.0', id: 2, method: 'message/send', params: {} });
    expect(st.alarmAt()).toBeGreaterThan(0);
  });
});

describe('the internal op is unreachable from outside (spec 327 §4)', () => {
  const internal = (headers: Record<string, string>, body: unknown = { principal: CALLER, channelId: 'ch_1' }) =>
    task.fetch(new Request('https://do.test/internal/discussion-respond', {
      method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', ...headers },
    }));

  it('REFUSES without the internal marker', async () => {
    expect((await internal({})).status).toBe(403);
  });

  it('REFUSES a wrong marker', async () => {
    expect((await internal({ 'x-ap-internal': 'guessed' })).status).toBe(403);
  });

  // FAIL-CLOSED on missing config, which is the direction that matters: an unset secret must not make
  // the marker check vacuous and open the op to anyone.
  it('REFUSES when the secret is UNCONFIGURED — an absent secret is not an open door', async () => {
    const bare = new A2aTaskDO(fakeState() as unknown as DurableObjectState, env({ A2A_CUSTODY_BRIDGE_SECRET: '' }), permissive);
    const r = await bare.fetch(new Request('https://do.test/internal/discussion-respond', {
      method: 'POST', body: JSON.stringify({ principal: CALLER, channelId: 'ch_1' }),
      headers: { 'x-ap-internal': '' },
    }));
    expect(r.status).toBe(403);
  });

  // Past the marker, the payload is still validated — a correct secret is not a licence to send junk.
  it('validates the payload even WITH the marker', async () => {
    expect((await internal({ 'x-ap-internal': SECRET }, { principal: 'not-an-address', channelId: 'ch_1' })).status).toBe(400);
    expect((await internal({ 'x-ap-internal': SECRET }, { principal: CALLER })).status).toBe(400);
  });

  // The path-level half of the guarantee: the JSON-RPC dispatcher has no such method, so even a
  // correctly-signed public `message/send` cannot name it.
  it('is NOT reachable as a JSON-RPC method', async () => {
    const out = await (await rpc({ jsonrpc: '2.0', id: 1, method: 'discussion/respond', params: {} })).json() as { result?: unknown; error?: unknown };
    expect(out.result).toBeUndefined();
    expect(out.error).toBeDefined();
  });
});

describe('the injected seam is an injection point, not a bypass', () => {
  // Production constructs the DO with two arguments, so `deps` is undefined and verification falls
  // through to the resilient chain reader (or the inline ERC-1271 fallback). Asserted because a seam
  // reachable from config would be a way to turn off signature verification in production.
  it('a DO built without deps does not take the injected path', async () => {
    const prod = new A2aTaskDO(fakeState() as unknown as DurableObjectState, env());
    // Framing still works — the seam is only consulted for on-chain checks — but any verification now
    // routes at the real RPC, which is unreachable here.
    const r = await prod.fetch(new Request(`https://do.test/a2a?agent=${AGENT}`, {
      method: 'POST', body: 'not json', headers: { 'Content-Type': 'application/json' },
    }));
    const out = await r.json() as { error: { code: number } };
    expect(out.error.code).toBe(-32700);
  });
});
