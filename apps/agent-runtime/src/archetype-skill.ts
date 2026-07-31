// ARCHETYPE A2A SKILLS — a specialist agent you reach over the standard task rail.
//
// The shape this replaces is one worker pretending to be a panel: an endeavor step ran an in-worker
// model turn under the org's own playbook, so "the Ontologist authored the T-box" meant the same
// principal that owns the endeavor did it with a different prompt. Nothing was actually delegated,
// nothing could be authorized per specialist, and the specialist's instructions lived wherever the
// caller put them.
//
// Here the specialist is a real recipient. An org that needs T-box work sends `message/send` to the
// ontology-engineering org addressing the METHOD `archetype.ontologist`; that org's DO verifies the
// message against a delegation and runs the turn under ITS OWN definition. Ownership is the point:
//
//   the TARGET domain org  owns the endeavor, its specs/, and the working ontology;
//   the ONTOLOGY-ENGINEERING org owns the archetypes' SKILL.md and runs their turns.
//
// ONE METHOD PER ARCHETYPE, which is a security decision rather than a naming one. A2A authorizes by
// selector: `allowedMethods` is a list of `bytes4` selectors, so one method per archetype lets a
// grant say "you may ask my Ontologist and my Reviewer" and withhold the rest. A single
// `archetype` method taking the role as an argument would collapse that to all-or-nothing, and the
// argument would be caller-supplied — exactly the authority-in-a-message shape ADR-0041 forbids.
//
// VOCABULARY, because two meanings of "skill" meet in this file. The A2A wire field is `skill` and
// holds a METHOD that addresses a role. A SKILL is a SKILL.md package in the org's library. The
// method names the role; the skills are what the harness composes behind it.
//
// The SKILL.md is a HARNESS READ on the recipient's side, never carried in the request. A caller
// that could supply the specialist's instructions would be writing its own reviewer.
import { runIntent, createRuleBasedPlanner, type Planner, type ToolSpec, type RunResult } from '@agenticprimitives/orchestration';
import { selectPlanner, withPlaybook, type PlannerEnv } from './orchestration.js';
import { EVIDENCE_MAX } from './endeavors.js';

/**
 * The A2A METHOD that addresses an archetype — `ontologist` → `archetype.ontologist`.
 *
 * "Method", not "skill id", and the distinction is load-bearing in THIS repo: a skill here is a
 * SKILL.md package in a library, and what this returns is not one. It is an addressable role. The
 * authorization layer agrees — `skillSelector` reduces this string to a `bytes4` checked by the
 * ALLOWED_METHODS enforcer, the same shape as a Solidity function selector. A2A's wire field is
 * named `skill`, so quoting the protocol still says skill; our own vocabulary should not.
 *
 * The method names the ROLE; the SKILL.mds are what the harness composes behind it.
 *
 * NOT namespaced by context, deliberately. An archetype runs on the demo-a2a of the org that HOLDS
 * its definition, so the recipient address already says which context you are asking: the
 * ontology-engineering org answers `archetype.cluster-architect`, and a global-mission org answers
 * whatever archetypes ITS library holds, on the same rail. Baking `oe.` in would have made the
 * ontology-engineering roster the only one that could ever exist.
 */
export const archetypeMethod = (slug: string): string => `archetype.${slug}`;

/** A capability IRI in a context's namespace — the context is the org's domain, not a constant. */
export const capabilityIriFor = (context: string, slug: string): string => `urn:skills:cap:${context}:${slug}`;

/** Shape of a valid archetype slug. EXISTENCE is decided by the hosting org's library, never here —
 *  this only bounds what may be turned into a folder path and a skill id. */
export const isArchetypeSlug = (s: string): boolean => /^[a-z0-9][a-z0-9-]{1,60}$/.test(s);

export const OE_CONTEXT = 'ontology-engineering';
const oeCap = (slug: string): string => capabilityIriFor(OE_CONTEXT, slug);

/**
 * The MVP roster. Slugs match `urn:skills:archetype:ontology-engineering:<slug>` in the
 * ontology-engineering data graph, so an archetype's card, its capabilities and its A2A skill id all
 * derive from one string instead of three hand-maintained lists that drift.
 *
 * `capabilities` is what a step's `capabilityRequirements` is matched against to pick a recipient —
 * declared here so routing works before the ontology graph is reachable from this worker, and
 * checked against that graph rather than replacing it.
 */
export interface ArchetypeDef {
  slug: string;
  label: string;
  /** Capability IRIs this archetype answers for. */
  capabilities: string[];
}

/**
 * The ontology-engineering roster — ONE context's archetypes, not the set of all archetypes.
 *
 * It is a default for routing before the ontology graph is reachable from this worker, and the
 * ontology-engineering org's library is what actually decides which of these can answer. Another
 * domain org hosts its own archetypes by putting `skills/<slug>/SKILL.md` in ITS library; nothing
 * here needs to change for that to work, which is why no code path treats this list as exhaustive.
 */
export const OE_ARCHETYPES: readonly ArchetypeDef[] = [
  { slug: 'domain-analyst', label: 'Domain Analyst',
    capabilities: ['domain-requirements-analysis', 'competency-question-elicitation'].map(oeCap) },
  { slug: 'cluster-architect', label: 'Cluster Architect',
    capabilities: ['semantic-clustering', 'semantic-packaging'].map(oeCap) },
  { slug: 'information-architect', label: 'Information Architect',
    capabilities: ['ontology-documentation'].map(oeCap) },
  { slug: 'ontologist', label: 'Ontologist',
    capabilities: ['upper-ontology-grounding', 'tbox-modeling', 'shacl-contract-authoring', 'canonical-id-minting'].map(oeCap) },
  { slug: 'taxonomist', label: 'Taxonomist',
    capabilities: ['vocabulary-curation'].map(oeCap) },
  { slug: 'ontology-reviewer', label: 'Ontology Reviewer',
    capabilities: ['ontology-review'].map(oeCap) },
  // The three the specs-first flow adds. They are archetypes rather than skills on an existing one
  // because each owns a decision the others should not make: how much work a wave is, what the
  // written source says, and whether a shape has ever been tested against an instance.
  { slug: 'ontology-creation-planner', label: 'Ontology Creation Planner',
    capabilities: ['ontology-build-planning', 'endeavor-wave-design'].map(oeCap) },
  { slug: 'spec-librarian', label: 'Spec Librarian',
    capabilities: ['spec-ingest', 'spec-citation'].map(oeCap) },
  { slug: 'exemplar-curator', label: 'Exemplar Curator',
    capabilities: ['abox-exemplar-authoring', 'shape-smoke-test'].map(oeCap) },
];

export const archetypeBySlug = (slug: string): ArchetypeDef | undefined =>
  OE_ARCHETYPES.find((a) => a.slug === slug);

/** Which archetype answers for a capability IRI — the routing question, asked of the roster. */
export const archetypeForCapability = (capabilityIri: string): ArchetypeDef | undefined =>
  OE_ARCHETYPES.find((a) => a.capabilities.includes(capabilityIri));

/**
 * What a caller sends. Everything here is MATERIAL, not instruction: the step to do, the written
 * source to ground it in, and the ontology as it currently stands. The specialist's own SKILL.md
 * supplies the method — see the module note on why that cannot travel in the request.
 */
export interface ArchetypeWorkInputV1 {
  /** `ap.archetype.work.v1` — pinned so a body of another shape is refused rather than guessed at. */
  version: 'ap.archetype.work.v1';
  /** The archetype being asked. Redundant with the METHOD by design — a mismatch means the caller
   *  and the rail disagree about who is answering, which is worth failing rather than resolving. */
  archetype: string;
  /** The plan step to carry out, verbatim from the adopted plan. */
  stepGoal: string;
  /** The endeavor this step belongs to, for provenance on the way back. */
  endeavorId?: string;
  stepId?: string;
  /** The capability the step declared, when it had one. */
  capabilityIri?: string;
  /** Excerpts from the domain's `specs/`, already budgeted by the caller. */
  specDigest?: string;
  /** Paths of every spec that exists, even those the digest could not carry. */
  specPaths?: string[];
  /** The working ontology so far — absent on the first wave. */
  currentTurtle?: string;
  /** Anything the requester added. */
  extra?: string;
}

export interface ParsedArchetypeWork {
  ok: true;
  input: ArchetypeWorkInputV1;
}
export interface ArchetypeWorkParseError {
  ok: false;
  error: string;
}

/**
 * Fail-closed body parsing — junk never reaches the turn.
 *
 * `expectArchetype` is the archetype the message's METHOD addressed. Checking the body against it is
 * what stops a caller authorized for one archetype from addressing another through the body, which
 * is the only way the per-selector authorization could otherwise be sidestepped.
 */
export function parseArchetypeWorkInput(raw: unknown, expectArchetype: string): ParsedArchetypeWork | ArchetypeWorkParseError {
  const o = (raw ?? {}) as Record<string, unknown>;
  if (o.version !== 'ap.archetype.work.v1') return { ok: false, error: 'body must be ap.archetype.work.v1' };
  const archetype = String(o.archetype ?? '').trim();
  if (!archetype) return { ok: false, error: 'archetype is required' };
  if (archetype !== expectArchetype) {
    return { ok: false, error: `body archetype "${archetype}" does not match the method it was sent to ("${expectArchetype}")` };
  }
  // SHAPE ONLY. Whether this archetype exists is the hosting org's library's answer, not a constant
  // in this worker — an org that adds an archetype to its own library must not need a redeploy here.
  if (!isArchetypeSlug(archetype)) return { ok: false, error: `invalid archetype slug "${archetype}"` };
  const stepGoal = String(o.stepGoal ?? '').trim();
  if (!stepGoal) return { ok: false, error: 'stepGoal is required' };

  const str = (v: unknown, max: number): string | undefined => {
    const s = String(v ?? '').trim();
    return s ? s.slice(0, max) : undefined;
  };
  const paths = Array.isArray(o.specPaths)
    ? o.specPaths.map((p) => String(p ?? '').trim()).filter(Boolean).slice(0, 200)
    : undefined;

  return {
    ok: true,
    input: {
      version: 'ap.archetype.work.v1',
      archetype,
      stepGoal: stepGoal.slice(0, 16_000),
      ...(str(o.endeavorId, 120) ? { endeavorId: str(o.endeavorId, 120)! } : {}),
      ...(str(o.stepId, 120) ? { stepId: str(o.stepId, 120)! } : {}),
      ...(str(o.capabilityIri, 300) ? { capabilityIri: str(o.capabilityIri, 300)! } : {}),
      ...(str(o.specDigest, EVIDENCE_MAX) ? { specDigest: str(o.specDigest, EVIDENCE_MAX)! } : {}),
      ...(paths?.length ? { specPaths: paths } : {}),
      ...(str(o.currentTurtle, EVIDENCE_MAX) ? { currentTurtle: str(o.currentTurtle, EVIDENCE_MAX)! } : {}),
      // SAME CEILING AS THE OTHER MATERIAL. `extra` was capped at 4k while specDigest and
      // currentTurtle got 64k — but it is where the package map, the alignment digest and the
      // assembled ontology for review all travel. So a reviewer sent a 1300-line ontology read the
      // first 4k, reported it as "truncated mid-sentence, no SHACL shapes present, 1 of 4 vocabulary
      // instances", and FAILED work that was complete. A caller cannot see this: the clip happens
      // after the request is accepted.
      ...(str(o.extra, EVIDENCE_MAX) ? { extra: str(o.extra, EVIDENCE_MAX)! } : {}),
    },
  };
}

/** What comes back. One artifact, so the caller merges a deliverable rather than parsing prose. */
export interface ArchetypeDeliverableV1 {
  version: 'ap.archetype.deliverable.v1';
  archetype: string;
  stepId?: string;
  /** The work product. Turtle for the authoring archetypes, prose or JSON for the rest. */
  deliverable: string;
  /** Spec paths the specialist says it used — the citation requirement, answered by the specialist. */
  citedSpecs?: string[];
  /** Set when the specialist judged it could not do the step. A refusal is a first-class outcome:
   *  an archetype asked for work outside its remit should say so, not improvise. */
  declined?: boolean;
  declineReason?: string;
}

export const ARCHETYPE_TOOLS: ToolSpec[] = [
  {
    id: 'post_archetype_deliverable',
    description:
      'Post the deliverable for this step. Call exactly once. Put the ENTIRE work product in ' +
      '`deliverable` — for authoring steps that is Turtle, for analysis steps prose or JSON. List in ' +
      '`citedSpecs` the spec paths you actually used. If the step is outside your remit or the ' +
      'material to do it is missing, set `declined` with a `declineReason` instead of improvising.',
    inputSchema: {
      type: 'object',
      properties: {
        deliverable: { type: 'string', description: 'The complete work product for this step.' },
        citedSpecs: { type: 'array', items: { type: 'string' }, description: 'Spec paths used, e.g. specs/charter.md.' },
        declined: { type: 'boolean', description: 'True if you cannot do this step.' },
        declineReason: { type: 'string', description: 'Why, when declined.' },
      },
      required: ['deliverable'],
    },
  },
];

/**
 * The contract wrapped AROUND the archetype's own SKILL.md.
 *
 * Deliberately thin. It states the rail (one tool, once) and the two rules a caller depends on —
 * cite the specs, decline rather than improvise — and says nothing about ontology method, because
 * the method is the archetype's SKILL.md and duplicating it here is how the two versions drift.
 */
export const ARCHETYPE_CONTRACT =
  'You are acting as a specialist agent that another organization has formally asked for help. Your ' +
  'instructions below define your role, method and standards — follow them exactly. You are given ' +
  'one step of a larger plan, the requesting domain\'s own specification excerpts, and the ontology ' +
  'as it currently stands. Ground your work in those specifications rather than in general knowledge, ' +
  'and cite the spec paths you used. Do the ONE step you were asked for and nothing beyond it — ' +
  'another specialist owns the next one. Call post_archetype_deliverable exactly once. Never answer ' +
  'in prose.';

/** The material, assembled as the turn's goal. Order is deliberate: the step first (what to do), the
 *  written source next (what to ground in), the current state last (what not to redo). */
export function archetypeGoal(input: ArchetypeWorkInputV1): string {
  const parts = [`STEP TO CARRY OUT: ${input.stepGoal}`];
  if (input.capabilityIri) parts.push(`Capability this step requires: ${input.capabilityIri}`);
  if (input.extra?.trim()) parts.push(`Additional direction from the requester: ${input.extra.trim()}`);
  if (input.specPaths?.length) {
    parts.push(`Specification documents in the requesting organization's library (${input.specPaths.length}): ${input.specPaths.map((p) => `specs/${p}`).join(', ')}`);
  }
  if (input.specDigest?.trim()) parts.push(`SPECIFICATION EXCERPTS:\n${input.specDigest.trim()}`);
  if (input.currentTurtle?.trim()) {
    parts.push(`ONTOLOGY SO FAR — extend it, do not restate it:\n${input.currentTurtle.trim()}`);
  } else {
    parts.push('There is no ontology yet for this domain; this is the first wave.');
  }
  return parts.join('\n\n');
}

/** What the reader needs: the co-resident InteractionsDO namespace and the in-Worker marker. */
export interface ArchetypeLibraryEnv {
  INTERACTIONS: DurableObjectNamespace;
  A2A_CUSTODY_BRIDGE_SECRET?: string;
}

/**
 * Read an archetype's SKILL.md from the agent's OWN library, in place.
 *
 * The package name convention is the archetype slug — `skills/ontologist/SKILL.md` — so the roster
 * slug addresses the card, the capabilities and now the instructions without a fourth mapping.
 *
 * Returns null when the package is absent, which the caller turns into a refusal rather than a
 * default: see `runArchetypeTurn`. Errors are NOT swallowed into null — "the library said no such
 * package" and "the read failed" need different fixes, and collapsing them is what made an earlier
 * empty-list bug undiagnosable.
 */
export function archetypeSkillReader(env: ArchetypeLibraryEnv, agentSA: string): (slug: string) => Promise<string | null> {
  return async (slug: string): Promise<string | null> => {
    const secret = env.A2A_CUSTODY_BRIDGE_SECRET;
    if (!secret) throw new Error('no internal marker configured — cannot read the archetype library');
    const id = agentSA.toLowerCase();
    const stub = env.INTERACTIONS.get(env.INTERACTIONS.idFromName(id));
    const resp = await stub.fetch(new Request(`https://do/interactions/${id}/internal.library.skillMd`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ap-internal': secret },
      body: JSON.stringify({ name: slug, file: 'SKILL.md' }),
    }));
    const out = (await resp.json().catch(() => ({}))) as { ok?: boolean; found?: boolean; text?: string | null; error?: string };
    if (!resp.ok || out.ok === false) throw new Error(out.error ?? `archetype SKILL.md read failed (${resp.status})`);
    return out.found && out.text ? out.text : null;
  };
}

/**
 * AN ARCHETYPE IS A ROLE PLUS A SET OF SKILLS, not a single document.
 *
 * The org's library holds skill packages. An archetype package (`skills/<slug>/SKILL.md`) states the
 * role — its doctrine, what it owns, what it refuses — and NAMES the skills that role composes, in
 * frontmatter:
 *
 *     ---
 *     name: ontologist
 *     skills: ontology-grounding, author-tbox-class, author-shacl-contract
 *     ---
 *
 * Each named skill is another package in the SAME library, loaded and appended. That is what makes
 * this general-purpose rather than ontology-specific: an org services `archetype.<slug>` for
 * whatever archetypes ITS library defines, composed from whatever skills ITS library holds. The
 * ontology-engineering org answers for a Cluster Architect; a global-mission org answers for
 * whatever roles that domain needs, on the same rail, with no code change here.
 *
 * A named skill that is MISSING is reported, never silently skipped — an archetype composed from
 * four skills of which two failed to load is a different specialist than the one the org defined,
 * and it would answer confidently as if it were not.
 */
export interface ArchetypeBundle {
  slug: string;
  /** The archetype package's own body — the role. */
  role: string;
  /** Skills named by the archetype, in declaration order, that were found. */
  skills: { name: string; description: string; body: string }[];
  /** Named but absent from the library. */
  missing: string[];
}

/** Frontmatter block of a SKILL.md, as `key: value` pairs. Deliberately tiny — these files are
 *  written to a flat-key convention and a YAML dependency in a Worker bundle is not worth it. */
export function readFrontmatter(text: string): { fm: Record<string, string>; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!m) return { fm: {}, body: text };
  const fm: Record<string, string> = {};
  let key = '';
  for (const line of (m[1] ?? '').split('\n')) {
    const km = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (km) { key = km[1]!; fm[key] = (km[2] ?? '').trim(); }
    else if (key && line.trim()) fm[key] += ` ${line.trim()}`;
  }
  return { fm, body: m[2] ?? '' };
}

/** The skills an archetype composes, from `skills:` (comma or whitespace separated). */
export function declaredSkills(fm: Record<string, string>): string[] {
  const raw = fm.skills ?? fm.composes ?? '';
  return [...new Set(raw.split(/[,\s]+/).map((x) => x.trim()).filter((x) => isArchetypeSlug(x)))].slice(0, 24);
}

/**
 * Load an archetype and every skill it declares, from the hosting org's own library.
 *
 * `readPackage` is the library seam — one call per package, so this works against any store that can
 * answer "give me `skills/<name>/SKILL.md`". Throws when the ARCHETYPE itself is absent: answering
 * as a specialist whose definition you could not read is the failure this module exists to prevent.
 */
export async function loadArchetypeBundle(
  readPackage: (name: string) => Promise<string | null>,
  slug: string,
): Promise<ArchetypeBundle> {
  const root = await readPackage(slug);
  if (!root || !root.trim()) {
    throw new Error(`no SKILL.md for archetype "${slug}" — refusing to answer as a specialist without its definition`);
  }
  const { fm, body } = readFrontmatter(root);
  const names = declaredSkills(fm).filter((n) => n !== slug);   // an archetype naming itself is a loop
  const skills: { name: string; description: string; body: string }[] = [];
  const missing: string[] = [];
  for (const name of names) {
    const text = await readPackage(name);
    if (text && text.trim()) {
      const parsed = readFrontmatter(text);
      skills.push({ name, description: (parsed.fm.description ?? '').trim(), body: parsed.body.trim() });
    } else missing.push(name);
  }
  return { slug, role: body.trim() || root.trim(), skills, missing };
}

/**
 * Compose the bundle into the system prompt: the ROLE first, then each skill as a named section.
 *
 * Order matters. The role states what this specialist owns and refuses, and the skills are methods
 * available to it — reversed, a long method document reads as the whole job and the archetype's
 * boundaries get lost. Missing skills are declared IN the prompt so the model knows its own
 * toolkit is incomplete rather than quietly working around a gap it cannot see.
 */
export function composeArchetypePrompt(bundle: ArchetypeBundle): string {
  const parts = [bundle.role];
  if (bundle.skills.length) {
    // AN INDEX FIRST, THEN THE BODIES. The intent arrives addressed to the ROLE, not to a skill, so
    // choosing which skills the step needs is the harness's job to enable and the model's to do.
    // A list of names and descriptions up front is what makes that choice possible — without it the
    // model meets several thousand words of method with no map and applies whichever it read last.
    parts.push(
      `\n\n---\n\n# Skills available to you\n\nThis role composes the following ${bundle.skills.length} skill(s). ` +
      'You were given a STEP, not a skill — decide which of these the step calls for, apply those, and ' +
      'ignore the rest. Say in your deliverable which you used.\n',
    );
    for (const s of bundle.skills) parts.push(`\n- **${s.name}**${s.description ? ` — ${s.description}` : ''}`);
    for (const s of bundle.skills) parts.push(`\n\n## Skill: ${s.name}\n\n${s.body}`);
  }
  if (bundle.missing.length) {
    parts.push(
      `\n\n---\n\nNOTE: this role declares skill(s) that could not be loaded: ${bundle.missing.join(', ')}. ` +
      'Work without them and say so in your deliverable if the step needed one.',
    );
  }
  return parts.join('');
}

export interface ArchetypeTurnResult {
  deliverable: ArchetypeDeliverableV1 | null;
  /** What actually answered — which skills composed the role, and which it declared but could not
   *  load. Worth reporting: a specialist missing half its skills gives a plausible, weaker answer. */
  bundle?: { skills: string[]; missing: string[] };
  plannerKind: 'anthropic' | 'rule-based';
  result: RunResult;
  error?: string;
}

/**
 * Run one archetype turn.
 *
 * `readSkillMd` is a SEAM, and the reason is worth stating: the archetype's SKILL.md lives in the
 * ontology-engineering org's library, and how this worker reaches that library is the part still
 * being wired. Injecting it keeps the turn — the piece with the real behaviour — testable and
 * finished now, and leaves exactly one function to point at the library later. A missing SKILL.md is
 * a FAILURE, not a default: an archetype with no instructions is a generic model turn wearing a
 * specialist's name, which is the thing this module exists to stop.
 */
export async function runArchetypeTurn(
  env: PlannerEnv,
  args: { input: ArchetypeWorkInputV1; readSkillMd: (slug: string) => Promise<string | null> },
): Promise<ArchetypeTurnResult> {
  // The role AND the skills it composes, both from the hosting org's own library.
  const bundle = await loadArchetypeBundle(args.readSkillMd, args.input.archetype);

  const { planner, kind } = selectPlanner(env, {
    systemPrompt: withPlaybook(composeArchetypePrompt(bundle), ARCHETYPE_CONTRACT),
    // The deliverable rides INSIDE the tool call's input, so the output budget must cover the whole
    // artifact. This ceiling has now been raised four times — 1024 → 4k → 16k → 32k → 64k — and each
    // time the symptom was identical and mute: "turn completed without posting a deliverable", an
    // EMPTY CAPTURE WITH NO ERROR, because the model never finished the call it was making. 32k fell
    // over on a 44 KB spec corpus after 155s.
    //
    // 64k is claude-sonnet-4-6's output CEILING, so this is the last raise available. The next time
    // this fails the answer cannot be a bigger number — it has to be a smaller ask (bound what the
    // goal requests) or a split turn. Note the budget covers reasoning AND the artifact together,
    // which is why a long deliberation on a large corpus can exhaust it before a word is emitted.
    maxTokens: 64_000,
  });

  let captured: ArchetypeDeliverableV1 | null = null;
  const invoke = async (toolId: string, a: Record<string, unknown>): Promise<unknown> => {
    if (toolId !== 'post_archetype_deliverable') throw new Error(`unknown tool: ${toolId}`);
    const deliverable = String(a.deliverable ?? '').trim().slice(0, EVIDENCE_MAX);
    const declined = a.declined === true;
    if (!deliverable && !declined) throw new Error('deliverable is required unless declining');
    captured = {
      version: 'ap.archetype.deliverable.v1',
      archetype: args.input.archetype,
      ...(args.input.stepId ? { stepId: args.input.stepId } : {}),
      deliverable,
      ...(Array.isArray(a.citedSpecs)
        ? { citedSpecs: a.citedSpecs.map((s) => String(s ?? '').trim()).filter(Boolean).slice(0, 200) }
        : {}),
      ...(declined ? { declined: true, declineReason: String(a.declineReason ?? '').trim().slice(0, 2_000) } : {}),
    };
    return { ok: true, length: deliverable.length };
  };

  const goal = archetypeGoal(args.input);
  if (kind !== 'anthropic') {
    // No model on this deployment. A specialist that cannot think does NOT emit a plausible-looking
    // deliverable — it declines, so the requester sees "nobody did this" rather than filler that
    // reads like ontology work and would be merged.
    const deterministic: Planner = createRuleBasedPlanner([
      { match: () => true, toolId: 'post_archetype_deliverable', args: {
        deliverable: '', declined: true,
        declineReason: 'no model is configured on this deployment, so this archetype cannot produce a deliverable',
      } },
    ]);
    const result = await runIntent({ goal, context: {} }, { planner: deterministic, tools: ARCHETYPE_TOOLS, invoke });
    return { deliverable: captured, plannerKind: kind, result, bundle: { skills: bundle.skills.map((x) => x.name), missing: bundle.missing } };
  }

  try {
    const result = await runIntent({ goal, context: {} }, { planner, tools: ARCHETYPE_TOOLS, invoke });
    return {
      deliverable: captured, plannerKind: kind, result,
      bundle: { skills: bundle.skills.map((x) => x.name), missing: bundle.missing },
      // Name the LIKELY cause. An empty capture almost always means the tool call was cut mid-emit
      // by the output budget, and "completed without posting" sent me looking at authorization.
      ...(captured ? {} : { error: 'turn completed without posting a deliverable — usually the answer exceeded the output budget and the tool call was cut mid-emit' }),
    };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return { deliverable: captured, plannerKind: kind, result: { steps: [], error } as unknown as RunResult, error };
  }
}


// ── THE HARNESS ────────────────────────────────────────────────────────────────────────────────
//
// An agent serves an A2A endpoint for a SET OF ARCHETYPES the way it serves one for itself. The
// method names the role, the org's own library defines what that role is and which skills it
// composes, and adding a role is a LIBRARY WRITE rather than a redeploy — which is what makes this
// general purpose. `archetype.cluster-architect` on the ontology-engineering org and
// `archetype.field-coordinator` on a global-mission org are the same code path.
//
// It plugs in through `resolveHandler`, consulted only when the static registry misses, so an
// archetype can never shadow a skill the agent actually declared.

import type { SkillHandler } from '@agenticprimitives/a2a';

/** `archetype.ontologist` → `ontologist`; any other method → null. */
export function archetypeSlugFromMethod(method: string): string | null {
  const m = /^archetype\.([a-z0-9][a-z0-9-]{1,60})$/.exec(method ?? '');
  return m ? m[1]! : null;
}

export interface ArchetypeHarnessEnv extends PlannerEnv, ArchetypeLibraryEnv {}

/**
 * Resolve an `archetype.<slug>` METHOD into a handler backed by this agent's own library.
 *
 * Returns undefined for a method that does not address an archetype, which leaves the task rejected as
 * `unknown skill` exactly as before. Whether the archetype EXISTS is not decided here — the handler
 * discovers that when it reads the library, and a missing definition fails the task with a reason
 * rather than being reported as an unknown skill. Those are different problems: "this agent does not
 * host archetypes" and "this agent does not host THAT archetype" need different fixes.
 */
export function resolveArchetypeMethod(env: ArchetypeHarnessEnv, agentSA: string): (method: string) => SkillHandler | undefined {
  const read = archetypeSkillReader(env, agentSA);
  return (method: string): SkillHandler | undefined => {
    const slug = archetypeSlugFromMethod(method);
    if (!slug) return undefined;
    return {
      // `skill` is the A2A WIRE FIELD (protocol vocabulary) and carries our method string.
      skill: method,
      handle: async (ctx) => {
        const parsed = parseArchetypeWorkInput(ctx.input, slug);
        if (!parsed.ok) return { state: 'failed', error: parsed.error };
        let turn: ArchetypeTurnResult;
        try {
          turn = await runArchetypeTurn(env, { input: parsed.input, readSkillMd: read });
        } catch (e) {
          // A definition this agent cannot read is a FAILED task with the reason attached, never a
          // silent default — the caller must be able to tell "you do not host this role" from "the
          // role produced nothing".
          return { state: 'failed', error: e instanceof Error ? e.message : String(e) };
        }
        if (!turn.deliverable) {
          return { state: 'failed', error: turn.error ?? 'archetype turn produced no deliverable' };
        }
        await ctx.emitArtifact({
          artifactKind: 'archetype.deliverable',
          body: turn.deliverable,
          bodyContentType: 'application/json',
        });
        return { state: 'completed' };
      },
    };
  };
}


/** One host org and the archetypes it has granted this caller. */
export interface ArchetypeHostGrant {
  host: string;
  archetypes: string[];
}

export interface ArchetypeRoute {
  host: string;
  archetype: string;
  capabilityIri: string;
}

/**
 * Pick the host to send a step to, from the capabilities the step declared and the grants we hold.
 *
 * ROUTING FOLLOWS AUTHORITY. The candidate hosts are exactly those that granted us the archetype —
 * a configured directory could name a host we cannot reach, and the dispatch would fail at the gate
 * with a message about credentials rather than about routing. Here an unroutable step is knowable
 * before anything is sent.
 *
 * Returns null when the step declares no capability, when no archetype answers for it, or when no
 * host has granted that archetype. All three mean the same thing to the caller — run it yourself —
 * but they are different situations, so `reason` says which.
 */
export function chooseArchetypeRoute(
  capabilityRequirements: ReadonlyArray<{ capabilityIri: string }> | undefined,
  hosts: readonly ArchetypeHostGrant[],
): { route: ArchetypeRoute } | { route: null; reason: string } {
  const caps = (capabilityRequirements ?? []).map((c) => c?.capabilityIri).filter(Boolean);
  if (caps.length === 0) return { route: null, reason: 'step declares no capability' };

  for (const capabilityIri of caps) {
    const archetype = archetypeForCapability(capabilityIri);
    if (!archetype) continue;
    const host = hosts.find((h) => h.archetypes.includes(archetype.slug));
    if (host) return { route: { host: host.host, archetype: archetype.slug, capabilityIri } };
  }
  // Distinguish "nothing answers for this capability" from "something does, but nobody granted it" —
  // the first is a modelling gap, the second is a missing ceremony, and they have different fixes.
  const known = caps.some((c) => archetypeForCapability(c));
  return known
    ? { route: null, reason: `no host has granted an archetype for ${caps.join(', ')}` }
    : { route: null, reason: `no archetype answers for ${caps.join(', ')}` };
}


// ── THE ARCHETYPE CATALOG (discovery) ──────────────────────────────────────────────────────────
//
// DISCOVERY IS NOT AUTHORITY, and this is the file where that could most easily blur. A catalog says
// what an organization HOSTS; a grant says what a caller may INVOKE. Publishing an archetype grants
// nobody anything, and a caller holding a grant needs no catalog — the two answer different
// questions and neither substitutes for the other.
//
// It is also not agent discovery. An agent card describes ONE agent; an org agent hosts N roles,
// each with its own capabilities and composed skills, which the card's flat skill list cannot carry.
// Hence a nested document.
//
// DERIVED FROM THE LIBRARY, never hand-maintained. A catalog that can disagree with the library
// advertises a role whose definition the harness then fails to load — and that reaches the caller as
// a rejected task rather than as "the advertisement was stale". Deriving it makes the two the same
// fact by construction.

/** One hosted archetype, as a caller browsing the org would see it. */
export interface ArchetypeCatalogEntry {
  slug: string;
  /** The A2A method to address it — what a grant must authorize. */
  method: string;
  description: string;
  /** Skills the role composes, by library package name. */
  skills: string[];
  /** Capability IRIs it answers for, when the roster knows this slug. */
  capabilities: string[];
  /** Declared skills that are NOT in this library — advertised honestly rather than hidden, because
   *  a role missing half its skills is a weaker specialist and a caller should be able to see that
   *  before dispatching to it. */
  missingSkills: string[];
}

export interface ArchetypeCatalog {
  archetypes: ArchetypeCatalogEntry[];
  /** Package names present in the library that are skills rather than roles. */
  skills: string[];
}

/** A library package reduced to what the catalog needs. */
export interface LibraryPackageMeta {
  name: string;
  frontmatter: string;
}

/**
 * Build the catalog from the org's library packages.
 *
 * A package is an ARCHETYPE when it says so (`archetype: true`) or when it composes skills
 * (`skills:`). The explicit marker is authoritative; the implicit one exists so a library seeded
 * before the marker still reads correctly, and so a role is never mistaken for one of its own
 * skills — which would advertise `archetype.author-tbox-class` as a role nobody hosts.
 */
export function buildArchetypeCatalog(packages: readonly LibraryPackageMeta[]): ArchetypeCatalog {
  const parsed = packages.map((p) => {
    const { fm } = readFrontmatter(`---\n${p.frontmatter}\n---\n`);
    return { name: p.name, fm };
  });
  const names = new Set(parsed.map((p) => p.name));
  const roles = parsed.filter((p) => p.fm.archetype === 'true' || declaredSkills(p.fm).length > 0);
  const roleNames = new Set(roles.map((r) => r.name));

  const archetypes = roles
    .filter((r) => isArchetypeSlug(r.name))
    .map((r) => {
      const declared = declaredSkills(r.fm).filter((n) => n !== r.name);
      const def = archetypeBySlug(r.name);
      return {
        slug: r.name,
        method: archetypeMethod(r.name),
        description: (r.fm.description ?? '').replace(/^["']|["']$/g, '').trim(),
        skills: declared.filter((n) => names.has(n)),
        capabilities: def ? [...def.capabilities] : [],
        missingSkills: declared.filter((n) => !names.has(n)),
      };
    })
    .sort((a, b) => a.slug.localeCompare(b.slug));

  return { archetypes, skills: parsed.map((p) => p.name).filter((n) => !roleNames.has(n)).sort() };
}
