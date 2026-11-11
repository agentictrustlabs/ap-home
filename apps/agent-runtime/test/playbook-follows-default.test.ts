// An agent on the default playbook runs the current default without its person going back to their Home; a playbook
// they chose stands, and a registry that cannot be trusted or reached changes nothing.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { definitionDigest, type AgentHarnessDefinitionV1 } from '@agenticprimitives/capability-claims';
// Spec 445 RUN-14: fixtures are not in agentic.lock.json — the deployment's approval set is stood in for here.
vi.mock('../src/playbook-approval', () => ({ isPinnedDigest: () => true, isApproved: () => true }));
import { loadPlaybook } from '../src/playbook-aliases';
import { clearPlaybookMemo, withCurrentDefault } from '../src/playbook-follows-default';

const AGENT = '0x' + 'a'.repeat(40);
const ID = 'skill:archetypes/person-steward';
const def = (tools: string[], archetypeId = ID): AgentHarnessDefinitionV1 => ({
  type: 'ap.agent-harness-definition.v1', archetypeId, archetypeVersion: '1.0.0', applicableAgentTypes: ['person'], instructions: 'You are a Person Steward.',
  tools: tools.map((id) => ({ id, description: id, capability: { id, action: 'read' }, risk: 'low' })),
  requiredMandateTypes: [], approvalPolicyRefs: [], retrievalQueries: ['Person'], evidenceRequirements: [], sourceCommitments: { x: 'id:x' },
});
const OLD = def(['person.profile.get']);
const NOW = def(['person.profile.get', 'person.church.home.save']);
const compiled = (d: AgentHarnessDefinitionV1) => ({ definition: d, digest: definitionDigest(d) });
const stored = (d: AgentHarnessDefinitionV1, over: object = {}) => ({ type: 'ap.archetype-assignment.v1', archetypeId: d.archetypeId, archetypeVersion: d.archetypeVersion, definitionDigest: definitionDigest(d), definition: d, ...over });
const registry = (compose?: (packs: Array<{ archetype: string }>) => Response) => vi.fn(async (url: string, init?: RequestInit) => {
  if (url.endsWith('/context/compose')) return compose ? compose(JSON.parse(String(init?.body)).packs) : new Response('{}', { status: 500 });
  return Response.json(compiled(NOW));
}) as unknown as typeof fetch;
const toolsOf = (r: unknown) => (r as { definition: AgentHarnessDefinitionV1 }).definition.tools.map((t) => t.id);

beforeEach(() => clearPlaybookMemo());
afterEach(() => vi.unstubAllGlobals());

describe('the default playbook follows the corpus', () => {
  it('an agent on an old default offers what the current default offers, with no write to the vault', async () => {
    vi.stubGlobal('fetch', registry());
    const read = vi.fn(async () => stored(OLD));
    const pb = await loadPlaybook(read as never, AGENT);
    expect(pb?.capabilityIds.has('person.church.home.save')).toBe(true);
    expect(pb?.digest).toBe(definitionDigest(NOW));
  });

  it('a playbook the person chose stands as pinned', async () => {
    const chosen = stored(def(['x.y'], 'skill:archetypes/gap-steward'));
    expect(await withCurrentDefault(chosen, AGENT, undefined, registry())).toBe(chosen);
    const otherBase = stored(def(['x.y'], 'a+b'), { composedFrom: { base: { context: 'gc', archetype: 'gap-steward', digest: '0x1' }, packs: [] } });
    expect(await withCurrentDefault(otherBase, AGENT, undefined, registry())).toBe(otherBase);
  });

  it('role packs stay: a composed playbook is recomposed on the current base', async () => {
    const composed = def(['person.profile.get', 'person.church.home.save', 'gap.read'], `${ID}+gap`);
    const f = registry(() => Response.json(compiled(composed)));
    const rec = stored(def(['person.profile.get', 'gap.read'], `${ID}+gap`), { composedFrom: { base: { ...{ context: 'agentic-trust', archetype: 'person-steward' }, digest: '0xold' }, packs: [{ context: 'gc', archetype: 'gap', roleName: 'Gap' }] } });
    expect(toolsOf(await withCurrentDefault(rec, AGENT, undefined, f))).toEqual(['person.profile.get', 'person.church.home.save', 'gap.read']);
  });

  it('a pack the registry no longer lets in is left out rather than holding the agent back', async () => {
    const f = registry((packs) => packs.length
      ? Response.json({ error: 'agentic-trust/people-group-catalog is for service agents and cannot be added to a person playbook' }, { status: 400 })
      : Response.json(compiled(NOW)));
    const rec = stored(OLD, { composedFrom: { base: { context: 'agentic-trust', archetype: 'person-steward', digest: '0xold' }, packs: [{ context: 'agentic-trust', archetype: 'people-group-catalog', roleName: 'Catalog' }] } });
    expect(toolsOf(await withCurrentDefault(rec, AGENT, undefined, f))).toContain('person.church.home.save');
  });

  it.each([
    ['unreachable', vi.fn(async () => { throw new Error('down'); })],
    ['answers that do not hash', vi.fn(async () => Response.json({ definition: NOW, digest: '0xbad' }))],
    ['answers an invalid definition', vi.fn(async () => { const bad = { ...NOW, sourceCommitments: {} }; return Response.json({ definition: bad, digest: definitionDigest(bad) }); })],
  ])('a registry that %s leaves the snapshot standing', async (_n, f) => {
    const rec = stored(OLD);
    expect(await withCurrentDefault(rec, AGENT, undefined, f as unknown as typeof fetch)).toBe(rec);
  });

  it('asks the registry once in a while, not on every run', async () => {
    const f = registry();
    await withCurrentDefault(stored(OLD), AGENT, undefined, f, 1000);
    await withCurrentDefault(stored(OLD), AGENT, undefined, f, 2000);
    expect(f).toHaveBeenCalledTimes(1);
    await withCurrentDefault(stored(OLD), AGENT, undefined, f, 1000 + 6 * 60_000);
    expect(f).toHaveBeenCalledTimes(2);
  });
});
