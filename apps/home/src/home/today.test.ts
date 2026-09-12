// Spec 398 §4.2 — Today's assembly is a pure function with a fixed order; the table says what lands where.
import { describe, it, expect } from 'vitest';
import { assembleToday, type TodayInputs } from './today';
import type { OrgWorkBundle } from '../components/portal/work/useWork';

const NOW = Date.UTC(2026, 8, 12, 12);
const day = 86_400_000;
const base = (): TodayInputs => ({ now: NOW, parked: [], bundles: [], artifacts: [], triggers: [], vocabulary: [] });

const bundle = (): OrgWorkBundle => ({
  org: 'eip155:34348:0x1111111111111111111111111111111111111111', orgName: 'Missio Nexus', allocations: [],
  entries: [
    { type: 'ap.home.contribution-entry.v1' as const, endeavorId: 'e1', endeavorTitle: 'Prepare the retreat', managingPrincipal: 'eip155:34348:0x1111111111111111111111111111111111111111' as never, participant: 'eip155:34348:0x2222222222222222222222222222222222222222' as never, stepIds: ['s1', 's2'], planRef: { planId: 'p', revision: 1, hash: '0x00' as never }, status: 'allocated' as const, allocationId: 'a1', updatedAt: new Date(NOW - day).toISOString() },
    { type: 'ap.home.contribution-entry.v1' as const, endeavorId: 'e2', endeavorTitle: 'Write the newsletter', managingPrincipal: 'eip155:34348:0x1111111111111111111111111111111111111111' as never, participant: 'eip155:34348:0x2222222222222222222222222222222222222222' as never, stepIds: ['s1'], planRef: { planId: 'p', revision: 1, hash: '0x00' as never }, status: 'committed' as const, commitmentId: 'c1', updatedAt: new Date(NOW - 2 * day).toISOString() },
  ],
  decisions: [{ type: 'ap.home.decision-card.v1' as const, decisionId: 'd1', endeavorId: 'e3', managingPrincipal: 'eip155:34348:0x1111111111111111111111111111111111111111' as never, approver: 'eip155:34348:0x2222222222222222222222222222222222222222' as never, decisionKind: 'plan-adoption', title: 'Adopt the plan for the food drive', requestedAt: new Date(NOW - 3600_000).toISOString(), allowedActions: [] }],
  myRequests: [],
  endeavors: [{ endeavorId: 'e2', title: 'Write the newsletter', lifecycle: 'active' as const }],
});

describe('Today (398 §4.2)', () => {
  it('a parked run waiting for a signature is a decision; one waiting for an answer is an active goal', () => {
    const t = assembleToday({ ...base(), parked: [
      { runRef: 'r1', message: 'send the treasury 10 dollars', awaiting: { kind: 'signature', prompt: 'sign the mandate', stepRef: 's0' }, updatedAt: NOW - 1000, state: 'awaiting-approval' },
      { runRef: 'r2', message: 'which David?', awaiting: { kind: 'data', prompt: 'which David did you mean', stepRef: 's0' }, updatedAt: NOW - 2000, state: 'awaiting-input' },
      { runRef: 'r3', message: 'old', awaiting: null, updatedAt: NOW - 9000, state: 'expired' },
    ] });
    expect(t.decisions.map((d) => d.id)).toEqual(['run:r1']);
    expect(t.active.map((d) => d.id)).toEqual(['run:r2']);
    expect(t.decisions[0]!.state?.state).toBe('awaiting-approval');
    expect(t.decisions[0]!.askSeed).toBe('send the treasury 10 dollars');
  });

  it('a 393 decision and an allocation waiting for my commitment are decisions; a commitment is an active goal with its endeavor state', () => {
    const t = assembleToday({ ...base(), bundles: [bundle()] });
    expect(t.decisions.map((d) => d.id)).toEqual(['decision:d1', 'allocation:a1']);   // newest first
    expect(t.decisions[0]!.href).toBe('/org/0x1111111111111111111111111111111111111111/work/e3');
    expect(t.active.map((d) => d.id)).toEqual(['commitment:c1']);
    expect(t.active[0]!.state?.state).toBe('running');
    expect(t.active[0]!.native).toBe('active');
  });

  it('artifacts: the last N days, newest first, capped; nothing from the future', () => {
    const t = assembleToday({ ...base(), recentDays: 7, artifacts: [
      { id: 'a', name: 'old', createdAt: NOW - 10 * day },
      { id: 'b', name: 'yesterday', createdAt: NOW - day, kind: 'md', version: 2 },
      { id: 'c', name: 'today', createdAt: NOW - 3600_000 },
      { id: 'd', name: 'future', createdAt: NOW + day },
    ] });
    expect(t.artifacts.map((a) => a.title)).toEqual(['today', 'yesterday']);
    expect(t.artifacts[1]!.detail).toBe('md · v2');
  });

  it('a failed routine is an exception; a parked routine is a decision', () => {
    const t = assembleToday({ ...base(), triggers: [
      { triggerId: 't1', ask: 'send the weekly digest', lastOutcome: 'failed', lastAt: NOW - day, lastSaid: 'planner_failed' },
      { triggerId: 't2', ask: 'pay the rent', lastOutcome: 'parked', lastAt: NOW - 2 * day },
      { triggerId: 't3', ask: 'ping', lastOutcome: 'answered', lastAt: NOW - 3 * day },
    ] });
    expect(t.exceptions.map((e) => e.id)).toEqual(['trigger:t1']);
    expect(t.exceptions[0]!.state?.state).toBe('failed');
    expect(t.decisions.map((e) => e.id)).toEqual(['trigger-parked:t2']);
  });

  it('one next act, from the vocabulary, lowest risk first, never something already parked', () => {
    const t = assembleToday({ ...base(),
      parked: [{ runRef: 'r', message: 'Who is on my team', awaiting: null, updatedAt: NOW, state: 'running' }],
      vocabulary: [
        { id: 'treasury.pay', label: 'Pay someone', riskTier: 'high', ceremonies: [] },
        { id: 'team.list', label: 'Who is on my team', riskTier: 'informational', ceremonies: [] },
        { id: 'profile.read', label: 'Show my profile', riskTier: 'informational', ceremonies: [], description: 'your contact record' },
        { id: 'zz.nolabel', riskTier: 'informational', ceremonies: [] },
      ] });
    expect(t.next?.id).toBe('next:profile.read');
    expect(t.next?.askSeed).toBe('Show my profile');
    expect(assembleToday(base()).next).toBeNull();
  });
});
