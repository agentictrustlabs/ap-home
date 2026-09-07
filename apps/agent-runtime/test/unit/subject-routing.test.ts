// Spec 366 R1 — WHICH AGENT ANSWERS A STEP. A tool that declares a `subject` argument is answered by the
// agent it names; the person's own agent routes there instead of reading that agent's records itself.
import { describe, it, expect } from 'vitest';
import { routedSubjectFor } from '../../src/harness-run.js';
import { MEMBERSHIP_LIST_TOOL } from '@agenticprimitives/context';
import type { Address } from '@agenticprimitives/types';

const ALICE = '0x00000000000000000000000000000000000000a1' as Address;
const ORG = '0x00000000000000000000000000000000000000c1' as Address;

describe('routedSubjectFor', () => {
  it('routes a roster question about ANOTHER organization to that organization', () => {
    expect(routedSubjectFor(MEMBERSHIP_LIST_TOOL, { org: ORG }, ALICE)).toBe(ORG);
  });
  it('runs locally when the subject IS the agent addressed (the org answering for itself)', () => {
    expect(routedSubjectFor(MEMBERSHIP_LIST_TOOL, { org: ORG }, ORG)).toBeNull();
  });
  it('runs locally when no subject was named (the addressee is meant)', () => {
    expect(routedSubjectFor(MEMBERSHIP_LIST_TOOL, {}, ALICE)).toBeNull();
  });
  it('never routes on an UNRESOLVED name — resolution is the resolver’s, and a name is not an agent', () => {
    expect(routedSubjectFor(MEMBERSHIP_LIST_TOOL, { org: 'missio nexus' }, ALICE)).toBeNull();
  });
  it('a tool that declares no subject is always answered by the addressee', () => {
    expect(routedSubjectFor({ id: 'x' } as never, { org: ORG }, ALICE)).toBeNull();
  });
});

import { readSubjectReply } from '../../src/harness-run.js';

describe('readSubjectReply — the subject agent’s /harness/ask envelope', () => {
  const LIVE = { ok: true, addressee: ORG, runRef: 'run-1', reply: { kind: 'answer', runRef: 'run-1', text: 'Missio Nexus has 4 members', results: [{ toolId: 'organization.membership.list', result: { count: 4, members: [] } }] } };
  it('an answer is the routed tool’s result — read from the NESTED reply, not the envelope', () => {
    const r = readSubjectReply(LIVE, 'organization.membership.list', 'missio-nexus.org', 200);
    expect(r.ok).toBe(true);
    expect((r.result as { count: number }).count).toBe(4);
    expect(r.runRef).toBe('run-1');
  });
  it('a prompt the subject raised is relayed in its words, never answered for it', () => {
    const r = readSubjectReply({ ok: true, reply: { kind: 'prompt', prompt: { kind: 'data', prompt: 'Which team?', fields: [{ name: 'org' }] } } }, 'organization.membership.list', 'x.org', 200);
    expect(r.ok).toBe(false);
    expect(r.refused).toContain('Which team?');
    expect(r.refused).toContain('org');
  });
  it('an envelope-level refusal is a refusal', () => {
    expect(readSubjectReply({ ok: false, error: 'this run belongs to someone else' }, 't', 'x.org', 403).refused).toContain('belongs to someone else');
    expect(readSubjectReply(null, 't', 'x.org', 502).ok).toBe(false);
  });
});

import { commandFieldsFor } from '../../src/harness-run.js';
describe('commandFieldsFor — one command, two ways of filling it (spec 367 §7)', () => {
  it('derives typed fields from the tool schema: parties are agent fields with their allowed types, usdc is an amount', () => {
    const fields = commandFieldsFor(null);
    const pay = fields['treasury.payment.execute']!;
    const payee = pay.find((f) => f.name === 'payee')!;
    expect(payee.kind).toBe('agent');
    expect(payee.types).toContain('treasury');
    expect(pay.find((f) => f.name === 'usdc')!.kind).toBe('amount');
    const invite = fields['organization.membership.invite']!;
    expect(invite.find((f) => f.name === 'invitee')!.kind).toBe('agent');
  });
});
