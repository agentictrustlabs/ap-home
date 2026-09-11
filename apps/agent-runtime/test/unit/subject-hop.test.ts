// A ROUTED ASK ACROSS DEPLOYMENTS — spec 366 R4, sender and receiver through the real standard server.
//
// The estate has one deployment today, so the network hop cannot be proved live between two Homes; this
// proves the WIRE: the sender resolves the card, sends one A2A 1.0 `SendMessage` carrying the profile,
// the receiver's mounted executor maps it onto its own `/harness/ask`, and the envelope rides back as
// the `subject-answer` artifact — read by the same `readSubjectReply` the in-process hop uses.
import { describe, expect, it } from 'vitest';
import { subjectAsk, AP_SUBJECT_ASK_EXTENSION_URI } from '@agenticprimitives/a2a';
import type { AgentCardV1 } from '@agenticprimitives/a2a/standard';
import { standardServerFor } from '../../src/standard-a2a.js';
import { sendSubjectAskOverWire, a2aEndpointOf, subjectAskOf, subjectAskMessage } from '@agenticprimitives/a2a';
import { readSubjectReply } from '../../src/harness-run.js';

const ALICE = '0xb0d11ce19b756a682e78b4904cd8d832303b3d11' as const;
const CHURCH = '0x3b99f2b452766de5df0dbcdfc676f27257151333' as const;
const HOST = 'alice-home-church-impact.other-home.example';
const card: AgentCardV1 = {
  name: 'alice-home-church.impact', description: 'a church on another Home', version: '1',
  supportedInterfaces: [{ url: `https://${HOST}/api/a2a`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
  capabilities: {}, defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'], skills: [],
};
const profile = subjectAsk({
  request: { capability: 'organization.membership.list', args: { org: CHURCH }, goal: 'who are the members of alice-home-church.impact' },
  asker: { agent: ALICE, credential: { kind: 'home-session', token: 'sess-alice' } },
  correlation: { operationId: 'op-1', runRef: 'run-a', stepRef: 's0', intentDigest: '0xabc' },
});

/** The receiver: the real mount, its harness stubbed to answer with a subject-answer envelope. */
function receiver(envelope: Record<string, unknown>, opts: { seen?: Array<Record<string, unknown>> } = {}) {
  const server = standardServerFor(CHURCH, card, HOST, {
    env: { A2A_INTERNAL_MARKER: 'test-marker-0123456789abcdef0123456789abcdef' } as never,
    appFetch: async (req) => {
      const body = (await req.json()) as Record<string, unknown>;
      opts.seen?.push(body);
      return new Response(JSON.stringify(envelope), { headers: { 'content-type': 'application/json' } });
    },
    verifySession: async (token) => (token === 'sess-alice' ? { ok: true, sa: ALICE } : { ok: false, status: 401, error: 'no' }),
  });
  // One fetch for both legs: the card by GET, the endpoint by POST, anything else is unreachable.
  const fetchFn = async (url: string, init: RequestInit): Promise<Response> => {
    if (url === `https://${HOST}/.well-known/agent-card.json`) return new Response(JSON.stringify(card), { headers: { 'content-type': 'application/json' } });
    if (url === `https://${HOST}/api/a2a`) return server.handle(new Request(url, init));
    throw new Error(`unreachable ${url}`);
  };
  return { server, fetchFn };
}

const answerEnvelope = {
  ok: true,
  reply: { kind: 'answer', runRef: 'run-b', results: [{ toolId: 'organization.membership.list', result: { count: 2, members: [{ agent: ALICE }] } }], text: 'two members' },
  subjectAnswer: { extension: AP_SUBJECT_ASK_EXTENSION_URI, version: 1, agent: CHURCH, inResponseTo: { operationId: 'op-1', runRef: 'run-a', stepRef: 's0' }, outcome: 'answer', result: { count: 2, members: [{ agent: ALICE }] }, said: 'two members', run: { runRef: 'run-b', receipts: [{ stepRef: 's0', status: 'ok' }] } },
};

describe('the wire shape', () => {
  it('the card names the endpoint; a card without a 1.0 JSON-RPC interface names none', () => {
    expect(a2aEndpointOf(card)).toBe(`https://${HOST}/api/a2a`);
    expect(a2aEndpointOf({ supportedInterfaces: [{ url: 'https://x/grpc', protocolBinding: 'GRPC', protocolVersion: '1.0' }] })).toBeNull();
    expect(a2aEndpointOf({ supportedInterfaces: [{ url: 'http://x/api', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }] })).toBeNull();
    // A released card says the version once, at the top (missio-nexus.org's, live): the interface inherits it.
    expect(a2aEndpointOf({ protocolVersion: '1.0', supportedInterfaces: [{ url: 'https://edge.example/api/a2a/x.org', protocolBinding: 'JSONRPC' } as never] })).toBe('https://edge.example/api/a2a/x.org');
    expect(a2aEndpointOf({ protocolVersion: '0.3', supportedInterfaces: [{ url: 'https://edge.example/api/a2a/x.org', protocolBinding: 'JSONRPC' } as never] })).toBeNull();
  });
  it('the message carries the profile as metadata and declares the extension; it reads back validated', () => {
    const m = subjectAskMessage(profile);
    expect(m.messageId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(m.extensions).toEqual([AP_SUBJECT_ASK_EXTENSION_URI]);
    const back = subjectAskOf(m);
    expect(back && 'ask' in back ? back.ask.request.capability : null).toBe('organization.membership.list');
    expect(subjectAskOf({ metadata: {} })).toBeNull();
    const bad = subjectAskOf({ metadata: { [AP_SUBJECT_ASK_EXTENSION_URI]: { version: 1 } } });
    expect(bad && 'errors' in bad).toBe(true);
  });
});

describe('sender → receiver over one SendMessage', () => {
  it('answers: the receiver ran the SAME /harness/ask body the in-process hop sends, and the envelope came back verbatim', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const { fetchFn } = receiver(answerEnvelope, { seen });
    const hop = await sendSubjectAskOverWire({ cardUrl: `https://${HOST}/.well-known/agent-card.json`, profile, session: 'sess-alice', fetch: fetchFn });
    expect(hop.ok).toBe(true);
    if (!hop.ok) return;
    expect(hop.endpoint).toBe(`https://${HOST}/api/a2a`);
    expect(hop.task.status.state).toBe('TASK_STATE_COMPLETED');
    expect(seen[0]).toMatchObject({ session: 'sess-alice', addressee: CHURCH, message: profile.request.goal, plan: { steps: [{ toolId: 'organization.membership.list', args: { org: CHURCH } }] } });
    expect((seen[0]?.subjectAsk as { correlation: { operationId: string } }).correlation.operationId).toBe('op-1');
    const read = readSubjectReply(hop.envelope as never, 'organization.membership.list', 'alice-home-church.impact', 200);
    expect(read).toMatchObject({ ok: true, result: { count: 2 }, runRef: 'run-b' });
    expect(read.receipts?.length).toBe(1);
  });

  it('refused by standing: the task is REJECTED in the receiver’s words and the sender relays them — nothing read locally', async () => {
    const refusedEnvelope = { ...answerEnvelope, reply: { kind: 'refused', text: 'only someone who belongs there can see the roster' }, subjectAnswer: { ...answerEnvelope.subjectAnswer, outcome: 'refused', result: undefined, said: 'only someone who belongs there can see the roster' } };
    const { fetchFn } = receiver(refusedEnvelope);
    const hop = await sendSubjectAskOverWire({ cardUrl: `https://${HOST}/.well-known/agent-card.json`, profile, session: 'sess-alice', fetch: fetchFn });
    expect(hop.ok).toBe(true);
    if (!hop.ok) return;
    expect(hop.task.status.state).toBe('TASK_STATE_REJECTED');
    const read = readSubjectReply(hop.envelope as never, 'organization.membership.list', 'alice-home-church.impact', 200);
    expect(read.ok).toBe(false);
    expect(read.refused).toMatch(/refused only someone who belongs/);
  });

  it('no session at the door: the receiver admits nobody (401), and the sender says so', async () => {
    const { fetchFn } = receiver(answerEnvelope);
    const hop = await sendSubjectAskOverWire({ cardUrl: `https://${HOST}/.well-known/agent-card.json`, profile, session: 'sess-stranger', fetch: fetchFn });
    expect(hop.ok).toBe(false);
    if (hop.ok) return;
    expect(hop.refused).toMatch(/401|unauthor/i);
  });

  it('unreachable card ⇒ said so; a card with no 1.0 endpoint ⇒ said so — never a local read', async () => {
    const dead = await sendSubjectAskOverWire({ cardUrl: 'https://nowhere.example/.well-known/agent-card.json', profile, session: 'sess-alice', fetch: async () => { throw new Error('ENOTFOUND'); } });
    expect(dead.ok).toBe(false);
    if (!dead.ok) expect(dead.refused).toMatch(/could not be read: ENOTFOUND/);
    const noWire = await sendSubjectAskOverWire({ cardUrl: 'https://x/.well-known/agent-card.json', profile, session: 'sess-alice', fetch: async () => new Response(JSON.stringify({ ...card, supportedInterfaces: [] })) });
    expect(noWire.ok).toBe(false);
    if (!noWire.ok) expect(noWire.refused).toMatch(/no A2A 1\.0 endpoint/);
  });
});

// ── Spec 374 §4 — THE DEBTOR'S ANSWER, delivered to the creditor's agent ──────────────────────────────
import { subjectAnswerMessage, subjectAnswerOf } from '@agenticprimitives/a2a';
import { subjectAnswer } from '@agenticprimitives/a2a';

const MARKER = 'test-marker-0123456789abcdef0123456789abcdef';
const delivered = subjectAnswer({
  agent: CHURCH, inResponseTo: { operationId: 'run-bob:s0', runRef: 'run-bob', stepRef: 's0' }, outcome: 'answer',
  result: { invited: ALICE }, said: 'Invited.', run: { runRef: 'run-church', receipts: [{ stepRef: 's0', status: 'executed' }] },
});

describe('the delivered answer', () => {
  it('rides the same extension URI and is told apart from an ask by shape', () => {
    const m = subjectAnswerMessage(delivered);
    expect(m.role).toBe('ROLE_AGENT');
    const back = subjectAnswerOf(m);
    expect(back && 'answer' in back ? back.answer.inResponseTo.operationId : null).toBe('run-bob:s0');
    expect(subjectAskOf(m)).not.toBeNull(); // the ask reader sees the key…
    expect(subjectAskOf(m) && 'errors' in subjectAskOf(m)!).toBe(true); // …and refuses the shape — a receiver checks the answer reader FIRST
    expect(subjectAnswerOf(subjectAskMessage(profile))).toBeNull(); // an ask is not an answer
  });

  it('an in-Worker agent caller resumes exactly the run that waited; a stranger to the marker is not admitted', async () => {
    const calls: Array<{ debtor: string; id: string }> = [];
    const server = standardServerFor(ALICE, { ...card, name: 'bob.me' }, 'bob.faithnet.ai', {
      env: { A2A_INTERNAL_MARKER: MARKER } as never,
      appFetch: async () => new Response('{}'),
      verifySession: async () => ({ ok: false, status: 401, error: 'no' }),
      resumeFromCommitment: async ({ debtor, answer }) => {
        calls.push({ debtor, id: answer.inResponseTo.operationId });
        return answer.inResponseTo.operationId === 'run-bob:s0' ? { ok: true, runRef: 'run-bob', said: 'The invitation went out.' } : { ok: false, reason: 'no run waits on that' };
      },
    });
    const send = (answer: unknown, headers: Record<string, string>) => server.handle(new Request('https://bob.faithnet.ai/api/a2a', {
      method: 'POST', headers: { 'content-type': 'application/json', 'a2a-version': '1.0', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'SendMessage', params: { message: subjectAnswerMessage(answer as never) } }),
    })).then((r) => r.json() as Promise<{ result?: { task?: { status: { state: string; message?: { parts: Array<{ text?: string }> } } } }; error?: { code: number } }>);

    // The debtor, through the marker: the run resumes.
    const ok = await send(delivered, { 'x-ap-internal': MARKER, 'x-ap-internal-agent': CHURCH });
    expect(ok.result?.task?.status.state).toBe('TASK_STATE_COMPLETED');
    expect(calls).toEqual([{ debtor: CHURCH, id: 'run-bob:s0' }]);

    // An answer nothing waits on: rejected, in words that do not say whether a run exists.
    const none = await send({ ...delivered, inResponseTo: { ...delivered.inResponseTo, operationId: 'run-other:s0' } }, { 'x-ap-internal': MARKER, 'x-ap-internal-agent': CHURCH });
    expect(none.result?.task?.status.state).toBe('TASK_STATE_REJECTED');
    expect(none.result?.task?.status.message?.parts[0]?.text).toMatch(/nothing this agent is waiting on/);

    // Naming an agent WITHOUT the marker is nobody: the door stays shut before any method runs.
    const shut = await send(delivered, { 'x-ap-internal-agent': CHURCH });
    expect(shut.error?.code ?? 0).not.toBe(0);
    expect(calls.length).toBe(2);
  });
});
