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
import { sendSubjectAskOverWire, a2aEndpointOf, subjectAskOf, subjectAskMessage } from '../../src/subject-hop.js';
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
