// Archetype A2A skills — the properties a caller's authorization depends on.
//
// A2A authorizes by SELECTOR: a grant names the skill ids a caller may invoke. That only bounds
// anything if the body cannot address a different archetype than the skill it arrived on, and if a
// specialist never answers without its own instructions. Both are tested here; the model turn itself
// is not (it is a model).
import { describe, expect, it } from 'vitest';
import {
  ARCHETYPE_CONTRACT,
  OE_ARCHETYPES,
  archetypeBySlug,
  archetypeForCapability,
  archetypeGoal,
  archetypeSkillId,
  capabilityIriFor,
  parseArchetypeWorkInput,
  runArchetypeTurn,
} from '../src/archetype-skill.js';

const body = (extra: Record<string, unknown> = {}) => ({
  version: 'ap.archetype.work.v1', archetype: 'ontologist', stepGoal: 'Author the T-box for Mission & Goal.', ...extra,
});

describe('roster', () => {
  it('derives skill id and capability IRIs from one slug', () => {
    expect(archetypeSkillId('ontologist')).toBe('oe.ontologist');
    expect(capabilityIriFor('tbox-modeling')).toBe('urn:skills:cap:ontology-engineering:tbox-modeling');
  });

  it('includes the six existing archetypes and the three the specs-first flow adds', () => {
    const slugs = OE_ARCHETYPES.map((a) => a.slug);
    for (const s of ['domain-analyst', 'cluster-architect', 'information-architect', 'ontologist', 'taxonomist', 'ontology-reviewer']) {
      expect(slugs, `existing: ${s}`).toContain(s);
    }
    for (const s of ['ontology-creation-planner', 'spec-librarian', 'exemplar-curator']) {
      expect(slugs, `new: ${s}`).toContain(s);
    }
  });

  it('gives every archetype a distinct skill id and at least one capability', () => {
    const ids = OE_ARCHETYPES.map((a) => archetypeSkillId(a.slug));
    expect(new Set(ids).size).toBe(ids.length);
    for (const a of OE_ARCHETYPES) expect(a.capabilities.length, a.slug).toBeGreaterThan(0);
  });

  it('maps a capability to exactly one archetype — routing must not be ambiguous', () => {
    const all = OE_ARCHETYPES.flatMap((a) => a.capabilities);
    expect(new Set(all).size, 'a capability claimed by two archetypes has no routing answer').toBe(all.length);
    expect(archetypeForCapability(capabilityIriFor('tbox-modeling'))?.slug).toBe('ontologist');
    expect(archetypeForCapability(capabilityIriFor('semantic-clustering'))?.slug).toBe('cluster-architect');
    expect(archetypeForCapability('urn:skills:cap:other:thing')).toBeUndefined();
  });
});

describe('parseArchetypeWorkInput', () => {
  it('accepts a well-formed body for the skill it arrived on', () => {
    const r = parseArchetypeWorkInput(body(), 'ontologist');
    expect(r.ok).toBe(true);
  });

  it('REFUSES a body naming a different archetype than the skill — the authorization bypass', () => {
    // A caller granted `oe.ontologist` must not reach the reviewer by relabelling the body.
    const r = parseArchetypeWorkInput(body({ archetype: 'ontology-reviewer' }), 'ontologist');
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(/does not match the skill it was sent to/);
  });

  it('REFUSES an unknown archetype, a wrong version, and a missing step', () => {
    expect(parseArchetypeWorkInput(body({ archetype: 'wizard' }), 'wizard').ok).toBe(false);
    expect(parseArchetypeWorkInput({ ...body(), version: 'v2' }, 'ontologist').ok).toBe(false);
    expect(parseArchetypeWorkInput(body({ stepGoal: '   ' }), 'ontologist').ok).toBe(false);
    expect(parseArchetypeWorkInput(null, 'ontologist').ok).toBe(false);
  });

  it('carries the material through and drops empty optionals', () => {
    const r = parseArchetypeWorkInput(body({
      specDigest: '--- specs/charter.md ---\nmission', specPaths: ['charter.md', ''], currentTurtle: '@prefix x: <y> .',
      capabilityIri: capabilityIriFor('tbox-modeling'), stepId: 'step_1_abcd', endeavorId: 'end_1', extra: '  ',
    }), 'ontologist');
    expect(r.ok).toBe(true);
    const i = (r as { input: Record<string, unknown> }).input;
    expect(i.specPaths).toEqual(['charter.md']);
    expect(i.currentTurtle).toBe('@prefix x: <y> .');
    expect(i.stepId).toBe('step_1_abcd');
    expect(i).not.toHaveProperty('extra');
  });
});

describe('archetypeGoal', () => {
  const parsed = (extra: Record<string, unknown> = {}) => {
    const r = parseArchetypeWorkInput(body(extra), 'ontologist');
    if (!r.ok) throw new Error('fixture did not parse');
    return r.input;
  };

  it('leads with the step and carries specs and current state', () => {
    const g = archetypeGoal(parsed({ specDigest: 'MISSION TEXT', specPaths: ['charter.md'], currentTurtle: '@prefix a: <b> .' }));
    expect(g.indexOf('STEP TO CARRY OUT')).toBe(0);
    expect(g).toContain('specs/charter.md');
    expect(g).toContain('MISSION TEXT');
    expect(g).toContain('extend it, do not restate it');
    expect(g).toContain('@prefix a: <b> .');
  });

  it('says plainly when there is no ontology yet, rather than omitting the section', () => {
    expect(archetypeGoal(parsed())).toContain('no ontology yet');
  });

  it('the contract defers method to the SKILL.md instead of restating it', () => {
    expect(ARCHETYPE_CONTRACT).toMatch(/instructions below define your role, method and standards/i);
    expect(ARCHETYPE_CONTRACT).toMatch(/post_archetype_deliverable exactly once/);
    // If this file started specifying ontology method, it would drift from the archetype's SKILL.md.
    expect(ARCHETYPE_CONTRACT).not.toMatch(/SHACL|T-box|PROV-O/);
  });
});

describe('runArchetypeTurn', () => {
  const input = (() => {
    const r = parseArchetypeWorkInput(body(), 'ontologist');
    if (!r.ok) throw new Error('fixture did not parse');
    return r.input;
  })();

  it('REFUSES to answer as a specialist with no SKILL.md', async () => {
    // Falling back to a default playbook would make this a generic model turn wearing a
    // specialist's name — the exact thing the module exists to prevent.
    await expect(runArchetypeTurn({} as never, { input, readSkillMd: async () => null }))
      .rejects.toThrow(/no SKILL.md for archetype "ontologist"/);
    await expect(runArchetypeTurn({} as never, { input, readSkillMd: async () => '   ' }))
      .rejects.toThrow(/refusing to answer as a specialist/);
  });

  it('DECLINES rather than inventing a deliverable when no model is configured', async () => {
    // Filler that reads like ontology work would be merged; an explicit decline cannot be.
    const out = await runArchetypeTurn({} as never, { input, readSkillMd: async () => '# Ontologist\nGround every class.' });
    expect(out.plannerKind).toBe('rule-based');
    expect(out.deliverable?.declined).toBe(true);
    expect(out.deliverable?.deliverable).toBe('');
    expect(out.deliverable?.declineReason).toMatch(/no model is configured/);
    expect(out.deliverable?.archetype).toBe('ontologist');
  });
});
