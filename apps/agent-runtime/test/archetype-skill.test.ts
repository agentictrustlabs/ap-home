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
  archetypeMethod,
  archetypeSkillReader,
  capabilityIriFor,
  chooseArchetypeRoute,
  archetypeSlugFromMethod,
  buildArchetypeCatalog,
  composeArchetypePrompt,
  loadArchetypeBundle,
  resolveArchetypeMethod,
  parseArchetypeWorkInput,
  runArchetypeTurn,
} from '../src/archetype-skill.js';

const body = (extra: Record<string, unknown> = {}) => ({
  version: 'ap.archetype.work.v1', archetype: 'ontologist', stepGoal: 'Author the T-box for Mission & Goal.', ...extra,
});

describe('roster', () => {
  it('derives the A2A method and capability IRIs from one slug', () => {
    expect(archetypeMethod('ontologist')).toBe('archetype.ontologist');
    expect(capabilityIriFor('ontology-engineering', 'tbox-modeling')).toBe('urn:skills:cap:ontology-engineering:tbox-modeling');
    // Another domain's context yields its own namespace — the roster is not ontology-only.
    expect(capabilityIriFor('global-mission', 'field-mapping')).toBe('urn:skills:cap:global-mission:field-mapping');
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

  it('gives every archetype a distinct method and at least one capability', () => {
    const ids = OE_ARCHETYPES.map((a) => archetypeMethod(a.slug));
    expect(new Set(ids).size).toBe(ids.length);
    for (const a of OE_ARCHETYPES) expect(a.capabilities.length, a.slug).toBeGreaterThan(0);
  });

  it('maps a capability to exactly one archetype — routing must not be ambiguous', () => {
    const all = OE_ARCHETYPES.flatMap((a) => a.capabilities);
    expect(new Set(all).size, 'a capability claimed by two archetypes has no routing answer').toBe(all.length);
    expect(archetypeForCapability(capabilityIriFor('ontology-engineering', 'tbox-modeling'))?.slug).toBe('ontologist');
    expect(archetypeForCapability(capabilityIriFor('ontology-engineering', 'semantic-clustering'))?.slug).toBe('cluster-architect');
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
    expect((r as { error: string }).error).toMatch(/does not match the method it was sent to/);
  });

  it('accepts an archetype OUTSIDE the ontology roster — existence is the library\'s answer', () => {
    // A global-mission org services whatever archetypes ITS library defines. Hard-coding the
    // ontology-engineering roster here would mean a redeploy of this worker per new domain role.
    expect(parseArchetypeWorkInput(body({ archetype: 'field-coordinator' }), 'field-coordinator').ok).toBe(true);
  });

  it('REFUSES a malformed slug, a wrong version, and a missing step', () => {
    expect(parseArchetypeWorkInput(body({ archetype: 'Not A Slug' }), 'Not A Slug').ok).toBe(false);
    expect(parseArchetypeWorkInput(body({ archetype: '../evil' }), '../evil').ok).toBe(false);
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
    const out = await runArchetypeTurn({} as never, { input, readSkillMd: async () => '---\nname: ontologist\n---\n# Ontologist\nGround every class.' });
    expect(out.plannerKind).toBe('rule-based');
    expect(out.deliverable?.declined).toBe(true);
    expect(out.deliverable?.deliverable).toBe('');
    expect(out.deliverable?.declineReason).toMatch(/no model is configured/);
    expect(out.deliverable?.archetype).toBe('ontologist');
  });
});

describe('archetypeSkillReader', () => {
  const b64 = (s: string) => {
    const bytes = new TextEncoder().encode(s);
    let bin = ''; for (const x of bytes) bin += String.fromCharCode(x);
    return btoa(bin);
  };
  const envWith = (respond: (body: Record<string, unknown>) => Response) => {
    const calls: Record<string, unknown>[] = [];
    return {
      calls,
      env: {
        A2A_INTERNAL_MARKER: 'marker',
        INTERACTIONS: {
          idFromName: (n: string) => n,
          get: () => ({
            fetch: async (req: Request) => {
              const body = (await req.json()) as Record<string, unknown>;
              calls.push({ url: req.url, marker: req.headers.get('x-ap-internal'), ...body });
              return respond(body);
            },
          }),
        },
      } as never,
    };
  };
  const ok = (b: Record<string, unknown>) => new Response(JSON.stringify(b), { status: 200 });

  it('returns the decoded SKILL.md and carries the marker', async () => {
    const { env, calls } = envWith(() => ok({ ok: true, found: true, text: '# Ontologist — ground every class' }));
    const text = await archetypeSkillReader(env, '0xABC')('ontologist');
    expect(text).toBe('# Ontologist — ground every class');
    expect(calls[0]?.marker).toBe('marker');
    expect(calls[0]?.name).toBe('ontologist');
    expect(String(calls[0]?.url)).toContain('internal.library.skillMd');
    // The DO shard is the agent, lowercased — a mixed-case SA must not address a second shard.
    expect(String(calls[0]?.url)).toContain('0xabc');
  });

  it('round-trips UTF-8 — every SKILL.md in this stack has em dashes', () => {
    const s = '# Ontologist — grounding, SHACL — done';
    const bin = atob(b64(s));
    expect(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))).toBe(s);
  });

  it('returns null when the package is absent — the caller turns that into a refusal', async () => {
    const { env } = envWith(() => ok({ ok: true, found: false, text: null }));
    expect(await archetypeSkillReader(env, '0xabc')('spec-librarian')).toBeNull();
  });

  it('THROWS on a failed read rather than reporting it as absent', async () => {
    // "no such package" and "the read failed" need different fixes; collapsing them to null is what
    // made an earlier empty-list bug undiagnosable.
    const { env } = envWith(() => new Response(JSON.stringify({ error: 'no delivery grant' }), { status: 409 }));
    await expect(archetypeSkillReader(env, '0xabc')('ontologist')).rejects.toThrow(/no delivery grant/);
  });

  it('refuses to read without the in-Worker marker', async () => {
    const { env } = envWith(() => ok({ ok: true, found: true, text: 'x' }));
    await expect(archetypeSkillReader({ ...(env as object), A2A_INTERNAL_MARKER: '' } as never, '0xabc')('ontologist'))
      .rejects.toThrow(/A2A_INTERNAL_MARKER/);
  });
});


// AN ARCHETYPE IS A ROLE PLUS A SET OF SKILLS — the general-purpose shape. An org services
// `archetype.<slug>` from whatever ITS library defines, composed from whatever skills ITS library
// holds, with no code change per domain.
describe('loadArchetypeBundle / composeArchetypePrompt', () => {
  const lib: Record<string, string> = {
    ontologist: '---\nname: ontologist\nskills: ontology-grounding, author-tbox-class\n---\n# Ontologist\nYou own grounding.',
    'ontology-grounding': '---\nname: ontology-grounding\ndescription: Anchor a term on an existing upper ontology.\n---\nGround on PROV-O before minting.',
    'author-tbox-class': '---\nname: author-tbox-class\n---\nOne class, one cluster.',
    // A different domain entirely — same mechanism, no ontology vocabulary anywhere.
    'field-coordinator': '---\nname: field-coordinator\nskills: assign-partner\n---\n# Field Coordinator\nYou own field assignment.',
    'assign-partner': '---\nname: assign-partner\n---\nMatch a partner to a field.',
  };
  const read = async (n: string) => lib[n] ?? null;

  it('loads the role and every declared skill, in order', async () => {
    const b = await loadArchetypeBundle(read, 'ontologist');
    expect(b.role).toContain('You own grounding.');
    expect(b.skills.map((s) => s.name)).toEqual(['ontology-grounding', 'author-tbox-class']);
    expect(b.skills[0]?.body).toContain('Ground on PROV-O');
    expect(b.missing).toEqual([]);
  });

  it('works for a NON-ontology domain — the point of the generalization', async () => {
    const b = await loadArchetypeBundle(read, 'field-coordinator');
    expect(b.role).toContain('field assignment');
    expect(b.skills.map((s) => s.name)).toEqual(['assign-partner']);
  });

  it('REPORTS a declared skill that is missing rather than skipping it silently', async () => {
    // An archetype composed from four skills of which two failed to load is a different specialist,
    // and it would answer just as confidently.
    const b = await loadArchetypeBundle(
      async (n) => (n === 'ontologist' ? '---\nname: ontologist\nskills: ontology-grounding, gone-missing\n---\nRole.' : lib[n] ?? null),
      'ontologist',
    );
    expect(b.missing).toEqual(['gone-missing']);
    expect(composeArchetypePrompt(b)).toContain('could not be loaded: gone-missing');
  });

  it('throws when the ARCHETYPE itself is absent', async () => {
    await expect(loadArchetypeBundle(async () => null, 'ontologist')).rejects.toThrow(/refusing to answer as a specialist/);
  });

  it('ignores a self-reference and de-duplicates', async () => {
    const b = await loadArchetypeBundle(
      async (n) => (n === 'ontologist' ? '---\nname: ontologist\nskills: ontologist, ontology-grounding, ontology-grounding\n---\nRole.' : lib[n] ?? null),
      'ontologist',
    );
    expect(b.skills.map((s) => s.name)).toEqual(['ontology-grounding']);
  });

  it('an archetype with no declared skills is valid — the role alone', async () => {
    const b = await loadArchetypeBundle(async () => '---\nname: solo\n---\nJust a role.', 'solo');
    expect(b.skills).toEqual([]);
    expect(composeArchetypePrompt(b)).toBe('Just a role.');
  });

  it('puts the ROLE before the skills — reversed, the method reads as the whole job', async () => {
    const p = composeArchetypePrompt(await loadArchetypeBundle(read, 'ontologist'));
    expect(p.indexOf('You own grounding.')).toBeLessThan(p.indexOf('Skill: ontology-grounding'));
    expect(p).toContain('## Skill: author-tbox-class');
  });

  it('INDEXES the skills before their bodies so the role can choose which to apply', async () => {
    // The intent is addressed to the ROLE, not to a skill — picking is the point, and picking needs
    // a map. The index must precede the full bodies.
    const p = composeArchetypePrompt(await loadArchetypeBundle(read, 'ontologist'));
    expect(p).toContain('**ontology-grounding** — Anchor a term on an existing upper ontology.');
    expect(p).toMatch(/You were given a STEP, not a skill/);
    expect(p.indexOf('**ontology-grounding**')).toBeLessThan(p.indexOf('## Skill: ontology-grounding'));
  });
});

// THE HARNESS — an agent serving an A2A endpoint for a SET of archetypes rather than for itself.
describe('resolveArchetypeMethod', () => {
  const lib: Record<string, string> = {
    ontologist: '---\nname: ontologist\nskills: ontology-grounding\n---\n# Ontologist\nRole.',
    'ontology-grounding': '---\nname: ontology-grounding\n---\nGround first.',
  };
  const env = () => ({
    A2A_INTERNAL_MARKER: 'marker',
    INTERACTIONS: {
      idFromName: (n: string) => n,
      get: () => ({
        fetch: async (req: Request) => {
          const b = (await req.json()) as { name?: string };
          const text = lib[String(b.name)];
          return new Response(JSON.stringify(text ? { ok: true, found: true, text } : { ok: true, found: false, text: null }), { status: 200 });
        },
      }),
    },
  }) as never;

  const ctx = (input: unknown) => {
    const artifacts: Record<string, unknown>[] = [];
    return { artifacts, ctx: { input, emitArtifact: async (a: Record<string, unknown>) => { artifacts.push(a); return '0x1'; } } as never };
  };

  it('resolves an archetype method and ignores everything else', () => {
    const r = resolveArchetypeMethod(env(), '0xabc');
    expect(r('archetype.ontologist')?.skill).toBe('archetype.ontologist');
    // A non-archetype method must fall through to `unknown skill`, not be swallowed by the harness.
    for (const s of ['echo', 'discussion.consult', 'archetype.', 'archetype.Bad Slug', 'notarchetype.x']) {
      expect(r(s), s).toBeUndefined();
    }
  });

  it('parses the slug out of the method', () => {
    expect(archetypeSlugFromMethod('archetype.cluster-architect')).toBe('cluster-architect');
    expect(archetypeSlugFromMethod('archetype.field-coordinator')).toBe('field-coordinator');
    expect(archetypeSlugFromMethod('echo')).toBeNull();
  });

  it('FAILS the task with a reason when this agent does not host that archetype', async () => {
    // Distinct from "unknown skill": "we do not host archetypes" and "we do not host THAT one" need
    // different fixes, so the second must not masquerade as the first.
    const h = resolveArchetypeMethod(env(), '0xabc')('archetype.missing-role');
    const { ctx: c } = ctx({ version: 'ap.archetype.work.v1', archetype: 'missing-role', stepGoal: 'do it' });
    const out = await h!.handle(c);
    expect(out.state).toBe('failed');
    expect(String(out.error)).toMatch(/no SKILL.md for archetype "missing-role"/);
  });

  it('REFUSES a body addressed to a different archetype than the skill', async () => {
    const h = resolveArchetypeMethod(env(), '0xabc')('archetype.ontologist');
    const { ctx: c } = ctx({ version: 'ap.archetype.work.v1', archetype: 'ontology-reviewer', stepGoal: 'do it' });
    const out = await h!.handle(c);
    expect(out.state).toBe('failed');
    expect(String(out.error)).toMatch(/does not match the method it was sent to/);
  });

  it('emits the deliverable as an artifact — a decline is still a result, not a crash', async () => {
    const h = resolveArchetypeMethod(env(), '0xabc')('archetype.ontologist');
    const { ctx: c, artifacts } = ctx({ version: 'ap.archetype.work.v1', archetype: 'ontologist', stepGoal: 'Author the T-box' });
    const out = await h!.handle(c);
    expect(out.state).toBe('completed');
    expect(artifacts[0]?.artifactKind).toBe('archetype.deliverable');
    // No model configured in this test env ⇒ the specialist declines rather than inventing.
    expect((artifacts[0]?.body as { declined?: boolean })?.declined).toBe(true);
  });
});

// ROUTING FOLLOWS AUTHORITY. Candidate hosts are exactly those that granted us the archetype, so an
// unroutable step is knowable before anything is sent — rather than failing at the host's gate with
// a message about credentials when the real problem was routing.
describe('chooseArchetypeRoute', () => {
  const OE = '0xaaa';
  const hosts = [{ host: OE, archetypes: ['ontologist', 'ontology-reviewer'] }];
  const cap = (slug: string) => ({ capabilityIri: capabilityIriFor('ontology-engineering', slug) });

  it('routes a capability to the host that granted the archetype answering it', () => {
    const r = chooseArchetypeRoute([cap('tbox-modeling')], hosts);
    expect(r.route).toEqual({ host: OE, archetype: 'ontologist', capabilityIri: cap('tbox-modeling').capabilityIri });
  });

  it('tries every declared capability before giving up', () => {
    const r = chooseArchetypeRoute([cap('vocabulary-curation'), cap('ontology-review')], hosts);
    // Taxonomist is not granted; Reviewer is — so the second capability routes.
    expect(r.route?.archetype).toBe('ontology-reviewer');
  });

  it('does NOT route to a host that did not grant that archetype', () => {
    // The Taxonomist exists in the roster but nobody granted it — dispatching would be refused.
    const r = chooseArchetypeRoute([cap('vocabulary-curation')], hosts);
    expect(r.route).toBeNull();
    expect((r as { reason: string }).reason).toMatch(/no host has granted/);
  });

  it('distinguishes "no archetype answers" from "nobody granted it" — different fixes', () => {
    const unknown = chooseArchetypeRoute([{ capabilityIri: 'urn:skills:cap:global-mission:field-mapping' }], hosts);
    expect((unknown as { reason: string }).reason).toMatch(/no archetype answers/);
    const ungranted = chooseArchetypeRoute([cap('vocabulary-curation')], hosts);
    expect((ungranted as { reason: string }).reason).toMatch(/no host has granted/);
  });

  it('a step with no capability is not an error — it just runs locally', () => {
    for (const c of [undefined, [] as { capabilityIri: string }[]]) {
      const r = chooseArchetypeRoute(c, hosts);
      expect(r.route).toBeNull();
      expect((r as { reason: string }).reason).toMatch(/declares no capability/);
    }
  });

  it('holding no grants at all routes nothing', () => {
    expect(chooseArchetypeRoute([cap('tbox-modeling')], []).route).toBeNull();
  });
});

// THE CATALOG — discovery, derived from the library so it cannot advertise what the harness would
// fail to load. Not authority: publishing a role grants nobody anything.
describe('buildArchetypeCatalog', () => {
  const pkg = (name: string, fm: string) => ({ name, frontmatter: fm });
  const lib = [
    pkg('ontologist', 'name: ontologist\ndescription: Grounds and authors.\nskills: ontology-grounding, author-tbox-class'),
    pkg('ontology-grounding', 'name: ontology-grounding\ndescription: Anchor a term.'),
    pkg('author-tbox-class', 'name: author-tbox-class\ndescription: Author one class.'),
    pkg('taxonomist', 'name: taxonomist\ndescription: Curates vocabularies.\nskills: curate-vocabulary'),
    pkg('curate-vocabulary', 'name: curate-vocabulary\ndescription: SKOS scheme.'),
  ];

  it('lists roles as archetypes and everything else as skills', () => {
    const c = buildArchetypeCatalog(lib);
    expect(c.archetypes.map((a) => a.slug)).toEqual(['ontologist', 'taxonomist']);
    expect(c.skills).toEqual(['author-tbox-class', 'curate-vocabulary', 'ontology-grounding']);
  });

  it('gives each archetype the METHOD a grant must authorize', () => {
    const c = buildArchetypeCatalog(lib);
    expect(c.archetypes[0]?.method).toBe('archetype.ontologist');
  });

  it('carries the composed skills and the roster capabilities', () => {
    const o = buildArchetypeCatalog(lib).archetypes.find((a) => a.slug === 'ontologist')!;
    expect(o.skills).toEqual(['ontology-grounding', 'author-tbox-class']);
    expect(o.capabilities).toContain(capabilityIriFor('ontology-engineering', 'tbox-modeling'));
  });

  it('ADVERTISES missing skills rather than hiding them', () => {
    // A role missing half its skills is a weaker specialist; a caller should see that before
    // dispatching, not discover it in a thin deliverable.
    const c = buildArchetypeCatalog([pkg('ontologist', 'name: ontologist\nskills: ontology-grounding, gone')]);
    const o = c.archetypes[0]!;
    expect(o.missingSkills).toEqual(['ontology-grounding', 'gone']);
    expect(o.skills).toEqual([]);
  });

  it('honours the explicit marker for a role that composes nothing', () => {
    const c = buildArchetypeCatalog([pkg('solo', 'name: solo\narchetype: true\ndescription: A role alone.')]);
    expect(c.archetypes.map((a) => a.slug)).toEqual(['solo']);
    expect(c.skills).toEqual([]);
  });

  it('never advertises a plain skill as a role — that would name a method nobody hosts', () => {
    const c = buildArchetypeCatalog([pkg('author-tbox-class', 'name: author-tbox-class\ndescription: Author one class.')]);
    expect(c.archetypes).toEqual([]);
    expect(c.skills).toEqual(['author-tbox-class']);
  });

  it('works for a non-ontology domain, with no capabilities when the roster does not know it', () => {
    const c = buildArchetypeCatalog([
      pkg('field-coordinator', 'name: field-coordinator\ndescription: Assigns fields.\nskills: assign-partner'),
      pkg('assign-partner', 'name: assign-partner\ndescription: Match a partner.'),
    ]);
    expect(c.archetypes[0]?.slug).toBe('field-coordinator');
    expect(c.archetypes[0]?.capabilities).toEqual([]);
    expect(c.archetypes[0]?.skills).toEqual(['assign-partner']);
  });

  it('an empty library is an empty catalog, not an error', () => {
    expect(buildArchetypeCatalog([])).toEqual({ archetypes: [], skills: [] });
  });
});
