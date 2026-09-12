import { describe, it, expect } from 'vitest';
import { assembleMemory } from './memory';
const NOW = Date.UTC(2026, 8, 12, 12); const iso = new Date(NOW).toISOString();
const ME = '0x2222222222222222222222222222222222222222', ORG = '0x1111111111111111111111111111111111111111';
describe('three stores, never one label (398 §6.1)', () => {
  it('a personal fact is the person\'s; workspace knowledge is the org\'s; a run\'s context is the acting agent\'s', () => {
    const m = assembleMemory({ self: ME, workspace: ORG,
      confirmations: [{ word: 'david', capability: 'treasury.payment.execute', capabilityWords: 'send money', arg: 'payee', agent: '0x3333333333333333333333333333333333333333', label: 'David Okafor', at: iso }],
      instructions: [{ context: ME, capability: 'treasury.payment.execute', capabilityWords: 'send money', arg: 'payer', value: '0x4444444444444444444444444444444444444444', label: 'my treasury', at: iso }],
      endeavors: [{ endeavorId: 'e1', title: 'Retreat', lifecycle: 'active', updatedAt: iso }],
      artifacts: [{ id: 'a1', name: 'brief.md', createdAt: NOW, releases: 1 }, { id: 'a2', name: 'draft.md', createdAt: NOW - 1 }],
      records: [{ runRef: 'r1', at: NOW, outcome: 'completed', steps: 1, receipts: 1, intent: { goal: 'who is on my team' }, export: { ok: true } }],
      checkpoints: [{ runRef: 'r2', message: 'pay the rent', awaiting: null, updatedAt: NOW, state: 'awaiting-approval' }],
    });
    expect(m.personal.map((x) => [x.kind, x.owner, x.actions.join('+')])).toEqual([['remembered choice', ME, 'forget+correct'], ['standing instruction', ME, 'forget+correct']]);
    expect(m.personal[0]!.title).toBe('“david” means David Okafor');
    expect(m.workspace.map((x) => [x.kind, x.visibility])).toEqual([['endeavor context', 'members of this workspace'], ['Library release', 'published · 1 release'], ['Library artifact', 'owner only']]);
    expect(m.workspace.every((x) => x.owner === ORG)).toBe(true);
    expect(m.run.map((x) => x.kind)).toEqual(['checkpoint', 'run.provenance (in the vault)']);
    expect(m.run[1]!.actions).toContain('promote');
    expect(m.absent.run[0]).toMatch(/not yet an act/);
  });
  it('a choice made in a room keeps its room: distinct from the same word at home, and the forget ref carries it (385 W2)', () => {
    const base = { word: 'thompson', capability: 'organization.membership.invite', capabilityWords: 'invite members', arg: 'org', at: iso };
    const m = assembleMemory({ self: ME, workspace: ORG, confirmations: [{ ...base, agent: '0x3333333333333333333333333333333333333333', label: 'big-thompson-team.org', context: ORG }, { ...base, agent: '0x5555555555555555555555555555555555555555', label: 'thompson.org' }],
      instructions: [], endeavors: [], artifacts: [], records: [], checkpoints: [] });
    expect(m.personal.map((x) => x.id)).toEqual([`confirmation:thompson:organization.membership.invite:org@${ORG}`, 'confirmation:thompson:organization.membership.invite:org']);
    expect(m.personal[0]!.detail).toMatch(/in room 0x11111111/);
    expect(m.personal[1]!.detail).toMatch(/at home$/);
    expect(m.personal[0]!.ref).toEqual({ ...{ word: 'thompson', capability: 'organization.membership.invite', arg: 'org' }, context: ORG });
    expect(m.personal[1]!.ref).not.toHaveProperty('context');
  });
});
