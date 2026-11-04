// Spec 427 §5 — which role packs a playbook should hold. The organization offers; the person equips; a pack whose
// membership ended is dropped; and an organization that could not be asked decides nothing.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { definitionDigest, type AgentHarnessDefinitionV1 } from '@agenticprimitives/capability-claims';
import { planRolePacks, mergeRolesReads, packHeading, recomposePlaybook, type ComposedFrom, type ComposedPack, type HeldRole } from './role-playbook';

const WELD = '0x1111111111111111111111111111111111111111';
const ORG = '0x5555555555555555555555555555555555555555';
const ME = '0x2222222222222222222222222222222222222222';
const lead = { context: 'field-operations', archetype: 'role-team-lead' };
const worker = { context: 'field-operations', archetype: 'role-field-worker' };
const coord = { context: 'field-operations', archetype: 'role-coordinator' };
const pack = (org: string, ref: { context: string; archetype: string }, roleName: string): ComposedPack => ({ ...ref, version: '1.0.0', digest: '0xabc', organization: org, organizationName: 'Weld Corridor Team', roleDefinitionId: `roledef:${ORG}:${ref.archetype.replace('role-', '')}@1`, roleName, equippedAt: '2026-10-05T00:00:00.000Z', equippedBy: ME, equippedAs: 'self' });
const role = (org: string, refs: Array<{ context: string; archetype: string }>, over: Partial<HeldRole> = {}): HeldRole => ({ org, name: 'x', assignedRole: 'team-lead', roleName: 'Team lead', roleDefinitionId: `roledef:${ORG}:team-lead@1`, skillPackRefs: refs, ended: false, ...over });
const composed = (packs: ComposedPack[]): ComposedFrom => ({ base: { context: 'agentic-trust', archetype: 'person-steward', version: '1.0.0', digest: '0xbase' }, packs });

describe('planRolePacks', () => {
  it('a held role\'s pack is OFFERED, never planned in', () => {
    const plan = planRolePacks(null, { roles: [role(WELD, [lead])], asked: [WELD], unread: [] });
    expect(plan.offers).toEqual([{ role: role(WELD, [lead]), pack: lead }]);
    expect(plan.equipped).toEqual([]);
    expect(plan.drop).toEqual([]);
  });

  it('an equipped pack whose role still offers it is held, and is not offered again', () => {
    const plan = planRolePacks(composed([pack(WELD, lead, 'Team lead')]), { roles: [role(WELD, [lead])], asked: [WELD], unread: [] });
    expect(plan.equipped.map((e) => e.state)).toEqual(['held']);
    expect(plan.offers).toEqual([]);
    expect(plan.drop).toEqual([]);
  });

  it('a membership that ENDED drops its pack', () => {
    const ended = planRolePacks(composed([pack(WELD, lead, 'Team lead')]), { roles: [role(WELD, [lead], { ended: true })], asked: [WELD], unread: [] });
    expect(ended.equipped[0]!.state).toBe('ended');
    expect(ended.drop).toHaveLength(1);
    expect(ended.offers).toEqual([]);
    // …and so does an organization that answered with no membership of them at all.
    const gone = planRolePacks(composed([pack(WELD, lead, 'Team lead')]), { roles: [], asked: [WELD], unread: [] });
    expect(gone.equipped[0]!.state).toBe('ended');
  });

  it('a role that CHANGED drops the old pack and offers the new one', () => {
    const plan = planRolePacks(composed([pack(WELD, worker, 'Field worker')]), { roles: [role(WELD, [lead])], asked: [WELD], unread: [] });
    expect(plan.equipped[0]!.state).toBe('changed');
    expect(plan.drop.map((p) => p.archetype)).toEqual(['role-field-worker']);
    expect(plan.offers.map((o) => o.pack.archetype)).toEqual(['role-team-lead']);
  });

  it('an organization that could not be asked decides NOTHING — its pack stays', () => {
    const unread = planRolePacks(composed([pack(WELD, lead, 'Team lead')]), { roles: [], asked: [WELD], unread: [WELD] });
    expect(unread.equipped[0]!.state).toBe('unknown');
    expect(unread.drop).toEqual([]);
    const notAsked = planRolePacks(composed([pack(WELD, lead, 'Team lead')]), { roles: [], asked: [], unread: [] });
    expect(notAsked.drop).toEqual([]);
    const noRead = planRolePacks(composed([pack(WELD, lead, 'Team lead')]), null);
    expect(noRead.equipped[0]!.state).toBe('unknown');
    expect(noRead.drop).toEqual([]);
  });

  it('the same pack from two organizations is two packs — losing one membership keeps the other', () => {
    const plan = planRolePacks(composed([pack(WELD, lead, 'Team lead'), pack(ORG, lead, 'Team lead')]), { roles: [role(ORG, [lead])], asked: [WELD, ORG], unread: [] });
    expect(plan.equipped.map((e) => [e.pack.organization, e.state])).toEqual([[WELD, 'ended'], [ORG, 'held']]);
    expect(plan.drop.map((p) => p.organization)).toEqual([WELD]);
  });

  it('a plain member is offered nothing', () => {
    expect(planRolePacks(null, { roles: [role(WELD, [], { assignedRole: 'member', roleName: undefined })], asked: [WELD], unread: [] }).offers).toEqual([]);
  });
});

describe('mergeRolesReads', () => {
  it('a narrower ask about one organization rescues it from "unread"', () => {
    const merged = mergeRolesReads([
      { roles: [role(ORG, [coord])], asked: [ORG, WELD], unread: [WELD] },
      { roles: [role(WELD, [lead])], asked: [WELD], unread: [] },
    ]);
    expect(merged.unread).toEqual([]);
    expect(merged.roles.map((r) => r.org).sort()).toEqual([WELD, ORG].sort());
  });
  it('an organization no ask reached stays unread', () => {
    expect(mergeRolesReads([{ roles: [], asked: [WELD], unread: [WELD] }]).unread).toEqual([WELD]);
  });
});

describe('packHeading', () => {
  it('names the role and where it is held', () => {
    expect(packHeading({ roleName: 'Team lead', organizationName: 'Weld Corridor Team', organization: WELD })).toBe('Team lead at Weld Corridor Team');
    expect(packHeading({ roleName: 'Coach', organization: WELD })).toBe('Coach at 0x1111…1111');
  });
});

describe('a pack the person added for themselves (spec 427 §5.5)', () => {
  const self: ComposedPack = { context: 'gc', archetype: 'gap-steward', version: '1.0.0', digest: '0xgc', organization: '', roleDefinitionId: '', roleName: 'Gap Steward', equippedAt: '2026-10-06T00:00:00Z', equippedBy: '0xme', equippedAs: 'self' };
  it('is held whatever the organizations say, and is never on the drop list', () => {
    const composedFrom: ComposedFrom = { base: { context: 'agentic-trust', archetype: 'person-steward', version: '1.0.0', digest: '0xbase' }, packs: [self] };
    const plan = planRolePacks(composedFrom, { roles: [], asked: [], unread: [] });
    expect(plan.equipped).toEqual([{ pack: self, state: 'held' }]);
    expect(plan.drop).toEqual([]);
    expect(plan.offers).toEqual([]);
  });
  it('heads its instructions by its own label', () => {
    expect(packHeading(self)).toBe('Gap Steward (added by you)');
  });
});

// A pack re-scoped to another kind of agent after it was equipped refused the whole composition, so the person's
// playbook could never move forward (a person who had equipped people-group-catalog, 2026-11-04).
describe('recomposing with a pack the registry no longer lets in', () => {
  const AGENT = '0x3333333333333333333333333333333333333333';
  const PGC = { context: 'agentic-trust', archetype: 'people-group-catalog' };
  const def = (tools: string[]): AgentHarnessDefinitionV1 => ({
    type: 'ap.agent-harness-definition.v1', archetypeId: 'skill:archetypes/person-steward', archetypeVersion: '1.0.0',
    applicableAgentTypes: ['person'], instructions: 'You are a Person Steward.',
    tools: tools.map((id) => ({ id, description: id, capability: { id, action: 'read' }, risk: 'low' })),
    requiredMandateTypes: [], approvalPolicyRefs: [], retrievalQueries: ['Person'], evidenceRequirements: [], sourceCommitments: { x: 'id:x' },
  });
  const held = (): Record<string, unknown> => {
    const old = def(['person.profile.get']);
    return { type: 'ap.archetype-assignment.v1', archetypeId: old.archetypeId, archetypeVersion: '1.0.0', definitionDigest: definitionDigest(old), definition: old,
      composedFrom: { base: { context: 'agentic-trust', archetype: 'person-steward', version: '1.0.0', digest: '0xold' }, packs: [pack(ME, PGC, 'People-Group Catalog')] } };
  };
  const registry = (written: unknown[]) => vi.fn(async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    if (url.endsWith('/connect/channels') && body.action === 'archetypeAssignmentGet') return Response.json({ ok: true, record: held() });
    if (url.endsWith('/connect/channels') && body.action === 'archetypeAssignmentPut') { written.push(body.record); return Response.json({ ok: true }); }
    if (url.endsWith('/context/compose')) {
      if (body.packs.length) return Response.json({ error: 'agentic-trust/people-group-catalog is for service agents and cannot be added to a person playbook' }, { status: 400 });
      const d = def(['person.profile.get', 'person.faith.journey.record']);
      return Response.json({ definition: d, digest: definitionDigest(d), parts: [{ ref: 'agentic-trust/person-steward', digest: '0xnew', archetypeId: d.archetypeId, version: '1.0.0' }], warnings: [] });
    }
    return Response.json({}, { status: 404 });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('leaves that pack out, says so, and writes the current base with its new tools', async () => {
    const written: unknown[] = [];
    vi.stubGlobal('fetch', registry(written));
    const out = await recomposePlaybook({ agent: AGENT, token: 't', typeSlug: 'person', actor: AGENT });
    expect(out.removed).toEqual(['agentic-trust/people-group-catalog']);
    expect(out.warnings.join(' ')).toMatch(/people-group-catalog is no longer offered/);
    expect(out.toolsAdded).toContain('person.faith.journey.record');
    expect(written).toHaveLength(1);
    expect((written[0] as { composedFrom: { packs: unknown[] } }).composedFrom.packs).toEqual([]);
  });

  it('still refuses, out loud, a pack the person is equipping now', async () => {
    const written: unknown[] = [];
    vi.stubGlobal('fetch', registry(written));
    await expect(recomposePlaybook({ agent: AGENT, token: 't', typeSlug: 'person', actor: AGENT, remove: [{ organization: ME, ...PGC }], add: [{ role: role(ORG, [PGC]), pack: PGC }] }))
      .rejects.toThrow(/service agents/);
    expect(written).toHaveLength(0);
  });
});
