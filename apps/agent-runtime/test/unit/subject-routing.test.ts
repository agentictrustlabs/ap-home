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

import { resolveStepArgs } from '../../src/harness-run.js';
describe('a context-side party is filled from the realm the person stands in (spec 367 §7)', () => {
  const env = {} as never;
  it('"create an organization" at a person realm takes the person as parent, sourced as context', async () => {
    const seen: Array<{ arg: string; via?: string }> = [];
    const out = await resolveStepArgs({ label: 'Riverside Fellowship' }, env, { onResolved: (r) => seen.push({ arg: r.arg, via: r.via }) }, {
      stepRef: 's0', toolId: 'organization.create', capabilityId: 'organization.create', subject: ALICE, addressee: ALICE, realmKind: 'person', required: [],
    });
    expect(out.parent).toBe(ALICE);
    expect(seen).toContainEqual({ arg: 'parent', via: 'context' });
  });
  it('a realm whose class the role does not admit fills nothing — the person is asked, never guessed', async () => {
    // A team's parent is a workspace or an organization; a PERSON realm admits nothing for it.
    const out = await resolveStepArgs({ label: 'Weld' }, env, {}, {
      stepRef: 's0', toolId: 'organization.team.create', capabilityId: 'organization.team.create', subject: ALICE, addressee: ALICE, realmKind: 'person', required: [],
    });
    expect(out.parent).toBeUndefined();
  });
  it('a supplied parent is never overwritten by the realm', async () => {
    const out = await resolveStepArgs({ label: 'x', parent: ORG }, env, {}, {
      stepRef: 's0', toolId: 'organization.create', capabilityId: 'organization.create', subject: ALICE, addressee: ALICE, realmKind: 'person', required: [],
    });
    expect(out.parent).toBe(ORG);
  });
});

import { InputRequired } from '@agenticprimitives/orchestration';
describe('a required usdc is satisfied by the amount it became (caught live 2026-09-07)', () => {
  it('does not ask for usdc after reading it into amount', async () => {
    const out = await resolveStepArgs({ payee: ORG, usdc: '1.2' }, {} as never, {}, {
      stepRef: 's0', toolId: 'treasury.payment.execute', capabilityId: 'treasury.payment.execute', subject: ALICE, addressee: ALICE, realmKind: 'person', required: ['payee', 'usdc'],
    }).catch((e: unknown) => (e instanceof InputRequired ? { asked: e.request.prompt } : Promise.reject(e))) as Record<string, unknown>;
    expect(out.asked).toBeUndefined();
    expect(out.amount).toBe('1200000');
  });
});

describe('"us" at an organization is that organization (act laboratory, 2026-09-28)', () => {
  const env = {} as never;
  const ORG = '0x3b99f2b452766de5df0dbcdfc676f27257151333';
  it('an acting/context party named "us" asked AT the org resolves to the org, cited', async () => {
    const seen: Array<{ arg: string; via?: string; hint?: string }> = [];
    const out = await resolveStepArgs({ org: 'us', invitee: '0x' + '12'.repeat(20) }, env, { onResolved: (r) => seen.push({ arg: r.arg, via: r.via, hint: r.hint }) }, {
      stepRef: 's0', toolId: 'organization.membership.invite', capabilityId: 'organization.membership.invite', subject: ALICE, addressee: ORG, required: ['org', 'invitee'],
    } as never);
    expect(out.org).toBe(ORG);
    expect(seen).toContainEqual({ arg: 'org', via: 'context', hint: 'the agent you are asking' });
  });
  it('"self" (the planner\'s word for the agent asked) is the room too', async () => {
    const out = await resolveStepArgs({ parent: 'self', label: 'youth-outreach' }, env, {}, { stepRef: 's0', toolId: 'organization.team.create', capabilityId: 'organization.team.create', subject: ALICE, addressee: ORG, required: ['parent'] } as never);
    expect(out.parent).toBe(ORG);
  });
  it('never at the asker\'s own agent', async () => {
    await expect(resolveStepArgs({ org: 'us' }, env, {}, { stepRef: 's0', toolId: 'organization.membership.invite', capabilityId: 'organization.membership.invite', subject: ALICE, addressee: ALICE, required: ['org'] } as never)).rejects.toBeTruthy();
  });
});
