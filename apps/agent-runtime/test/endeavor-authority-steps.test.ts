// Spec 350 W3 / 334 §6 — a plan step that needs authority is work waiting on a person, not a paragraph.
import { describe, expect, it } from 'vitest';
import {
  authorityCapabilityOf, askForStep, checkpointForStep, claimableBy, awaitingAuthorityNote, receiptEvidence,
  AUTHORITY_BEARING_CAPABILITIES, checkpointForCommittedStep, committedStepNote, type WorkStep,
} from '../src/endeavor-authority-steps.js';

const PRINCIPAL = '0x3b99f2b452766de5df0dbcdfc676f27257151333' as const;
const STEWARD = '0xb0d11ce19b756a682e78b4904cd8d832303b3d11' as const;
const OTHER = '0x8c5cddca27c088a65e58e94403acdc9bc3eb7fe3' as const;
const step = (over: Partial<WorkStep> = {}): WorkStep => ({ stepId: 'step_1', kind: 'produce', description: 'Charter the corridor team under the workspace', ...over });

describe('recognising a step that needs authority', () => {
  it('names the capability, from a bare id or an ap capability IRI', () => {
    expect(authorityCapabilityOf(step({ capabilityRequirements: [{ capabilityIri: 'organization.team.create' }] }))).toBe('organization.team.create');
    expect(authorityCapabilityOf(step({ capabilityRequirements: [{ capabilityIri: 'urn:ap:cap:treasury.payment.execute' }] }))).toBe('treasury.payment.execute');
  });

  it('leaves ordinary work alone — including a SPECIALIST roster entry, which is a different routing', () => {
    expect(authorityCapabilityOf(step())).toBeNull();
    expect(authorityCapabilityOf(step({ capabilityRequirements: [{ capabilityIri: 'none' }] }))).toBeNull();
    expect(authorityCapabilityOf(step({ capabilityRequirements: [{ capabilityIri: 'urn:skills:cap:field:survey' }] }))).toBeNull();
  });

  it('does not treat an unknown capability as authority-bearing — this substrate names what it can do', () => {
    expect(authorityCapabilityOf(step({ capabilityRequirements: [{ capabilityIri: 'treasury.liquidate.everything' }] }))).toBeNull();
  });
});

describe('the run a waiting step becomes', () => {
  const cp = checkpointForStep({ runRef: 'run-1', principal: PRINCIPAL, endeavorId: 'end_x', step: step(), goal: 'stand up the corridor', now: 5 });

  it("asks the step's OWN words, plus the capability it was adopted as", () => {
    expect(cp.message).toContain('Charter the corridor team under the workspace');
    expect(askForStep(step({ description: 'do it' }), 'stand up the corridor')).toBe('do it (for: stand up the corridor)');
  });

  it('names the capability and the principal — prose alone made the harness ANSWER instead of act', () => {
    const withCap = checkpointForStep({
      runRef: 'run-2', principal: PRINCIPAL, endeavorId: 'end_x', goal: 'g', now: 5,
      step: step({ capabilityRequirements: [{ capabilityIri: 'urn:ap:cap:organization.team.create' }] }),
    });
    expect(withCap.message).toContain('organization.team.create');
    expect(withCap.message).toContain(PRINCIPAL);
  });

  it('belongs to nobody yet, and remembers the step it exists to satisfy', () => {
    expect(cp).toMatchObject({ asker: PRINCIPAL, openToStewards: true, presented: [], supplied: [], origin: { endeavorId: 'end_x', stepId: 'step_1', principal: PRINCIPAL } });
  });

  it('is claimable by any steward while unanswered, and becomes theirs once they answer', () => {
    expect(claimableBy(cp, STEWARD)).toBe(true);
    expect(claimableBy(cp, OTHER)).toBe(true);
    const started = { ...cp, asker: STEWARD, supplied: [{ stepRef: 's0', data: { label: 'corridor' } }] };
    expect(claimableBy(started, STEWARD)).toBe(true);
    expect(claimableBy(started, OTHER)).toBe(false);
  });

  it('a person\'s own run is never claimable by someone else, answered or not', () => {
    expect(claimableBy({ ...cp, asker: STEWARD, openToStewards: false }, OTHER)).toBe(false);
  });

  it('tells the endeavor what is owed, to whom, and how to unblock it', () => {
    const note = awaitingAuthorityNote({ capability: 'organization.team.create', principal: PRINCIPAL, runRef: 'run-1', step: step() });
    expect(note).toContain('organization.team.create');
    expect(note).toContain(PRINCIPAL);
    expect(note).toContain('run-1');
    expect(note).toMatch(/must not report it done/);
  });
});

describe('the evidence a satisfied step carries', () => {
  it('is the receipt — the run, the mandate and the transaction — not a claim that it happened', () => {
    const ev = receiptEvidence({ capability: 'organization.team.create', runRef: 'run-1', mandateRef: `0x${'ab'.repeat(32)}`, txHash: `0x${'cd'.repeat(32)}`, summary: 'corridor.team (0xabc)' });
    expect(ev.refs).toEqual([`urn:ap:receipt:run:run-1`, `urn:ap:receipt:mandate:0x${'ab'.repeat(32)}`, `urn:ap:receipt:tx:0x${'cd'.repeat(32)}`]);
    expect(ev.note).toContain('corridor.team');
    expect(ev.note).toContain('Authorized: organization.team.create');
  });

  it('omits what did not happen — an off-chain capability has no transaction to point at', () => {
    const ev = receiptEvidence({ capability: 'organization.membership.invite', runRef: 'run-2', mandateRef: null, txHash: null, summary: 'Invited 0x8c5c.' });
    expect(ev.refs).toEqual(['urn:ap:receipt:run:run-2']);
    expect(ev.note).not.toContain('on chain');
  });
});

describe('the planner can NAME an authority-bearing step (without it, the binding is inert)', () => {
  it('tells the planner the organization\'s own actions, as ap capability IRIs it may not invent', async () => {
    const { PLAN_CONTRACT } = await import('../src/endeavor-plan-skill.js');
    for (const c of AUTHORITY_BEARING_CAPABILITIES) expect(PLAN_CONTRACT).toContain(`urn:ap:cap:${c}`);
    expect(PLAN_CONTRACT).toMatch(/Never invent an ap capability/);
    expect(PLAN_CONTRACT).toMatch(/WAIT until a steward authorizes/);
  });

  it('and what the planner writes is what the work loop recognises — the two lists cannot drift', () => {
    for (const c of AUTHORITY_BEARING_CAPABILITIES) {
      expect(authorityCapabilityOf({ stepId: 'step_1', kind: 'contribution', description: 'x', capabilityRequirements: [{ capabilityIri: `urn:ap:cap:${c}` }] })).toBe(c);
    }
  });
});

// The coordination side's capability list is deliberately NARROWER than the harness's mandate-bearing
// set. That is a decision; this is the guard that keeps it a decision rather than a drift.
import { NOT_PLAN_STEPS } from '../src/endeavor-authority-steps.js';
import { HARNESS_ACTION_TOOLS } from '../src/harness-run.js';

describe('AUTHORITY_BEARING_CAPABILITIES stays honest about the harness', () => {
  const mandateBearing = new Set(
    HARNESS_ACTION_TOOLS.filter((t) => t.capability && t.risk && t.risk !== 'informational')
      .map((t) => t.capability!.id),
  );

  it('every id is a REAL mandate-bearing capability — no dead strings from a rename', () => {
    for (const id of AUTHORITY_BEARING_CAPABILITIES) {
      expect(mandateBearing.has(id), `${id} is listed as a plan step but no harness tool exercises it`).toBe(true);
    }
  });

  it('every mandate-bearing capability is either a plan step or a NAMED omission', () => {
    const accounted = new Set([...AUTHORITY_BEARING_CAPABILITIES, ...NOT_PLAN_STEPS]);
    for (const id of mandateBearing) {
      expect(accounted.has(id), `${id} needs a mandate but is neither a plan step nor a named omission — decide which`).toBe(true);
    }
  });

  it('the two lists do not overlap — a capability is one or the other', () => {
    const both = AUTHORITY_BEARING_CAPABILITIES.filter((id) => NOT_PLAN_STEPS.includes(id));
    expect(both).toEqual([]);
  });
});

// Spec 382 (appendix M6 W1) — a COMMITTED step is the participant's run, not the organization's.
describe('the run a committed step becomes, at the participant', () => {
  const cp = checkpointForCommittedStep({
    runRef: 'run-9', participant: OTHER, principal: PRINCIPAL, endeavorId: 'end_x', goal: 'kick off the corridor', now: 5,
    step: step({ description: 'Pay the venue deposit of 1 USDC to nathan.treasury', capabilityRequirements: [{ capabilityIri: 'urn:ap:cap:treasury.payment.execute' }] }),
    commitmentRef: 'commit_b', planHash: '0x' + 'ab'.repeat(32),
  });
  it('is the participant\'s own run: addressed to them, asked by them, open to nobody else', () => {
    expect(cp).toMatchObject({ addressee: OTHER, asker: OTHER, openToStewards: false, presented: [], supplied: [] });
    expect(claimableBy(cp, OTHER)).toBe(true);
    expect(claimableBy(cp, STEWARD)).toBe(false);
  });
  it('exercises the capability AS THE PARTICIPANT, and remembers the commitment and the plan hash it was compiled from', () => {
    expect(cp.message).toContain('treasury.payment.execute');
    expect(cp.message).toContain(`as ${OTHER}`);
    expect(cp.message).not.toContain(PRINCIPAL);
    expect(cp.origin).toEqual({ endeavorId: 'end_x', stepId: 'step_1', principal: PRINCIPAL, commitmentRef: 'commit_b', planHash: '0x' + 'ab'.repeat(32) });
  });
  it('tells the endeavor whose promise it is and that the organization will not run it for them', () => {
    const note = committedStepNote({ participant: OTHER, name: 'bob', runRef: 'run-9', step: step(), commitmentRef: 'commit_b' });
    expect(note).toContain('bob');
    expect(note).toContain('commit_b');
    expect(note).toContain('run-9');
    expect(note).toMatch(/never authority/);
  });
  it('the receipt evidence cites the commitment it fulfilled', () => {
    const ev = receiptEvidence({ capability: 'treasury.payment.execute', runRef: 'run-9', mandateRef: '0x' + '11'.repeat(32), txHash: null, summary: 'Paid.', commitmentRef: 'commit_b' });
    expect(ev.refs).toContain('urn:ap:receipt:commitment:commit_b');
  });
});
