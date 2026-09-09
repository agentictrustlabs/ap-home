// FAN-OUT CONSULT — spec 380. The sentence compiles to one shape; a member without an opt-in is skipped
// with a result that says so; an answered consult carries its source; a declined one is a result too.
import { describe, expect, it } from 'vitest';
import { consultAskOf, memberConsultInvoker, MEMBER_CONSULT_TOOL } from '../../src/member-consult.js';

const ORG = '0x3b99f2b452766de5df0dbcdfc676f27257151333';
const BOB = '0x8c5cddca27c088a65e58e94403acdc9bc3eb7fe3';
const wire = { delegator: ORG, delegate: '0xa6ed7ed019081ad70c6acb5a315027c392d3c495', authority: '0x' + '0'.repeat(64), caveats: [], salt: '1', signature: '0x00' };

describe('consultAskOf — the sentence to its parts', () => {
  it('reads the organization phrase and the question clause', () => {
    expect(consultAskOf('ask each member of Missio Nexus whether they are available on Saturday')).toEqual({ org: 'Missio Nexus', question: 'whether they are available on Saturday' });
    expect(consultAskOf('Ask every member of calvary.org: what should we bring?')).toEqual({ org: 'calvary.org', question: 'what should we bring' });
    expect(consultAskOf('poll all the members if they can meet Tuesday')).toEqual({ question: 'if they can meet Tuesday' });
    expect(consultAskOf('consult the members of the team about the budget')).toEqual({ question: 'about the budget' });
  });
  it('is not a roster read, a payment, or a single ask', () => {
    expect(consultAskOf('who are the members of missio nexus')).toBeNull();
    expect(consultAskOf('pay every member 1 usdc')).toBeNull();
    expect(consultAskOf('ask bob whether he is free')).toBeNull();
  });
  it('the tool has no capability, claims its verbs, and the organization answers for it', () => {
    expect(MEMBER_CONSULT_TOOL.capability).toBeUndefined();
    expect(MEMBER_CONSULT_TOOL.verbs).toContain('ask each');
    expect(MEMBER_CONSULT_TOOL.subject).toBe('org');
  });
});

/** An in-memory Worker: the org's interactions object answers the two consult ops; the member's task
 *  object takes a message/send and answers tasks/get; the artifact door serves the answer. */
function fakeEnv(opts: { grant: boolean; orgWire?: boolean; answer?: { answer?: string; declined?: true; declineReason?: string }; failSend?: boolean }) {
  const calls: string[] = [];
  const interactions = { fetch: async (req: Request) => {
    const op = new URL(req.url).pathname.split('/').pop();
    calls.push(`ix:${op}`);
    if (op === 'internal.consult.grant') return Response.json({ ok: true, wire: opts.grant ? wire : null });
    if (op === 'internal.consult.orgWire') return Response.json({ ok: true, wire: opts.orgWire === false ? null : wire });
    return Response.json({ ok: false, error: `unexpected ${op}` }, { status: 400 });
  } };
  const tasks = { fetch: async (req: Request) => {
    const url = new URL(req.url);
    const body = await req.json() as { rpc?: { method?: string; params?: { message?: { extensions?: string[] } } }; principal?: { agent?: string }; taskId?: string; caller?: string; artifactId?: string };
    const method = body.rpc?.method;
    calls.push(`task:${method ?? url.pathname}`);
    if (method === 'SendMessage') {
      // The folded wire: the delegation rides the extension, and the org calls as itself.
      if (!(body.rpc?.params?.message?.extensions ?? []).includes('https://agenticprimitives.org/a2a/delegated-task/v1')) return Response.json({ error: { code: -32602, message: 'no delegated-task extension' } });
      if (body.principal?.agent !== ORG) return Response.json({ error: { code: -32602, message: 'not calling as the org' } });
      return opts.failSend ? Response.json({ error: { code: -32602, message: 'no grant names this org' } }) : Response.json({ result: { task: { id: '0x' + 'ab'.repeat(32), status: { state: 'TASK_STATE_SUBMITTED' } } } });
    }
    if (method === 'GetTask') return Response.json({ result: { id: '0x' + 'ab'.repeat(32), status: { state: 'TASK_STATE_COMPLETED' }, artifacts: [{ artifactId: 'art1' }] } });
    if (method === 'message/send' || method === 'tasks/get') return Response.json({ error: { code: -32601, message: 'Method not found' } });
    if (url.pathname === '/internal/consult-artifact') return Response.json({ ok: true, body: { version: 'ap.consult-answer.v1', questionId: 'q', orgSA: ORG, topicId: 't', question: 'q', actor: `eip155:34348:${BOB}`, ...(opts.answer ?? { answer: 'yes, Saturday works' }) } });
    return Response.json({ error: { message: 'unexpected' } });
  } };
  const ns = (stub: { fetch: (r: Request) => Promise<Response> }) => ({ idFromName: (n: string) => n, get: () => stub });
  const env = { INTERACTIONS: ns(interactions), A2A_TASKS: ns(tasks), CHAIN_ID: '34348', A2A_INTERNAL_MARKER: 'm' } as never;
  return { env, calls };
}

// The org signature is the interactions-session key's; in this test it is a stub so the shape, not the
// key, is under test.
const signRaw = async () => ('0x' + '11'.repeat(65)) as `0x${string}`;

describe('memberConsultInvoker — at the organization', () => {
  const ctx = { step: { id: 's1#1', toolId: MEMBER_CONSULT_TOOL.id, args: {} }, index: 1, intent: { goal: 'ask', context: { runRef: 'run-1' } } } as never;
  it('SKIPS a member without an opt-in, says so, asks nothing', async () => {
    const { env, calls } = fakeEnv({ grant: false });
    const out = await memberConsultInvoker(env, { nameOf: async () => 'bob' })(MEMBER_CONSULT_TOOL.id, { org: ORG, respondent: BOB, question: 'free Saturday?' }, ctx) as Record<string, unknown>;
    expect(out).toMatchObject({ consulted: false, skipped: true, member: BOB, name: 'bob' });
    expect(String(out.reason)).toMatch(/not opted in/);
    expect(calls).toEqual(['ix:internal.consult.grant']);
  });
  it('asks an opted-in member and carries the answer with its source', async () => {
    const { env, calls } = fakeEnv({ grant: true });
    const out = await memberConsultInvoker(env, { nameOf: async () => 'bob', deadlineMs: 5000, signRaw })(MEMBER_CONSULT_TOOL.id, { org: ORG, respondent: BOB, question: 'free Saturday?' }, ctx) as Record<string, unknown>;
    expect(out).toMatchObject({ consulted: true, member: BOB, attributedTo: BOB, answer: 'yes, Saturday works' });
    expect(String(out.interpretation)).toMatch(/asked bob/);
    expect(calls.slice(0, 4)).toEqual(['ix:internal.consult.grant', 'ix:internal.consult.orgWire', 'task:SendMessage', 'task:GetTask']);
  });
  it('a decline is a result, not a failure', async () => {
    const { env } = fakeEnv({ grant: true, answer: { declined: true, declineReason: 'ask me directly' } });
    const out = await memberConsultInvoker(env, { deadlineMs: 5000, signRaw })(MEMBER_CONSULT_TOOL.id, { org: ORG, respondent: BOB, question: 'free Saturday?' }, ctx) as Record<string, unknown>;
    expect(out).toMatchObject({ consulted: true, declined: true, reason: 'ask me directly' });
  });
  it("the member's gate refusing is that member's result, and no org wire refuses the whole step", async () => {
    const { env } = fakeEnv({ grant: true, failSend: true });
    const out = await memberConsultInvoker(env, { signRaw })(MEMBER_CONSULT_TOOL.id, { org: ORG, respondent: BOB, question: 'q' }, ctx) as Record<string, unknown>;
    expect(String(out.reason)).toMatch(/did not take the question/); expect(out.refused).toBeUndefined();
    const { env: e2 } = fakeEnv({ grant: true, orgWire: false });
    const out2 = await memberConsultInvoker(e2, { signRaw })(MEMBER_CONSULT_TOOL.id, { org: ORG, respondent: BOB, question: 'q' }, ctx) as Record<string, unknown>;
    expect(String(out2.refused)).toMatch(/member routing/);
  });
});
