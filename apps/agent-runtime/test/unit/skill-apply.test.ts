// Spec 415 A4 — an instruction skill is a tool of its own, answered under its body read by the pinned digest: a body
// that moved is refused, an unpinned source is refused, and the answer names the contract it was applied under.
import { describe, expect, it } from 'vitest';
import { instructionSkillTools, instructionSourcesOf, skillApplyInvoker } from '../../src/skill-apply.js';
import type { DefinitionToolV1 } from '@agenticprimitives/capability-claims';

const SRC = { skillId: 'skill:cil-commons/ai-governance-assessor', version: '0.1.1', contractDigest: 'sha256:' + 'aa'.repeat(32) };
const tools: Record<string, DefinitionToolV1> = {
  'cic.governance.assess': { id: 'cic.governance.assess', description: 'Assess AI governance maturity — the whole posture.', execution: 'instruction', source: SRC, establishes: 'lookup', answer: '{{answer}}', inputSchema: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] } },
  'organization.membership.list': { id: 'organization.membership.list', description: 'List members', source: { skillId: 'skill:x/roster', version: '1', contractDigest: 'sha256:' + 'bb'.repeat(32) } },
  'treasury.payment.execute': { id: 'treasury.payment.execute', description: 'pay', capability: { id: 'treasury.payment.execute', action: 'execute' }, risk: 'high' },
};

describe('instruction skills as tools', () => {
  it('offers only the instruction skills, each under its contract\'s words, informational', () => {
    const offered = instructionSkillTools({ tools });
    expect(offered.map((t) => t.id)).toEqual(['cic.governance.assess']);
    expect(offered[0]).toMatchObject({ description: 'Assess AI governance maturity — the whole posture.', establishes: 'lookup', answer: '{{answer}}' });
    expect(offered[0]!.capability).toBeUndefined();
    expect(instructionSourcesOf({ tools })).toEqual({ 'cic.governance.assess': SRC });
    expect(instructionSkillTools(null)).toEqual([]);
  });
});

describe('skill.apply', () => {
  const calls: Array<{ system: string; user: string }> = [];
  const call = async (input: { system: string; messages: Array<{ content: string }> }) => { calls.push({ system: input.system, user: input.messages[0]!.content }); return { answer: 'Inventory first; the scorecard follows.' }; };
  const readSkill = async (id: string) => (id === SRC.skillId ? { body: '# Assessor\n\nInventory before rubric.', commitment: SRC.contractDigest } : null);
  it('reads the body by the pinned digest, runs the model once under it, and names the contract on the answer', async () => {
    const invoke = skillApplyInvoker({ call, sources: instructionSourcesOf({ tools }), readSkill, agentName: 'cil-commons-1e07.org' });
    const out = await invoke('cic.governance.assess', { question: 'score our AI governance maturity', material: 'we run a dozen tools' }, {} as never) as Record<string, unknown>;
    expect(out).toEqual({ answer: 'Inventory first; the scorecard follows.', skill: { id: SRC.skillId, version: '0.1.1', digest: SRC.contractDigest }, source: 'cil-commons-1e07.org, under skill:cil-commons/ai-governance-assessor' });
    expect(calls[0]!.system).toContain('Inventory before rubric.');
    expect(calls[0]!.user).toBe('score our AI governance maturity\n\nThe situation, in the person\'s words:\nwe run a dozen tools');
  });
  it('refuses a body that moved, an unknown tool, an unpinned source, and a missing model', async () => {
    const moved = skillApplyInvoker({ call, sources: instructionSourcesOf({ tools }), readSkill: async () => ({ body: 'x', commitment: 'sha256:' + 'cc'.repeat(32) }) });
    expect(String(((await moved('cic.governance.assess', { question: 'q' }, {} as never)) as { refused: string }).refused)).toMatch(/has moved/);
    const invoke = skillApplyInvoker({ call, sources: instructionSourcesOf({ tools }), readSkill });
    expect(await invoke('treasury.payment.execute', { question: 'q' }, {} as never)).toEqual({ refused: 'treasury.payment.execute is not an instruction skill of this playbook' });
    const unpinned = skillApplyInvoker({ call, sources: { 'cic.governance.assess': { ...SRC, contractDigest: 'id:skill:cil-commons/ai-governance-assessor' } }, readSkill });
    expect(String(((await unpinned('cic.governance.assess', { question: 'q' }, {} as never)) as { refused: string }).refused)).toMatch(/without a content commitment/);
    const noModel = skillApplyInvoker({ call: undefined, sources: instructionSourcesOf({ tools }), readSkill });
    expect(await noModel('cic.governance.assess', { question: 'q' }, {} as never)).toEqual({ refused: 'no model is available to answer with' });
  });
});
