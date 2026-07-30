// ARCHETYPE A2A SKILLS — a specialist agent you reach over the standard task rail.
//
// The shape this replaces is one worker pretending to be a panel: an endeavor step ran an in-worker
// model turn under the org's own playbook, so "the Ontologist authored the T-box" meant the same
// principal that owns the endeavor did it with a different prompt. Nothing was actually delegated,
// nothing could be authorized per specialist, and the specialist's instructions lived wherever the
// caller put them.
//
// Here the specialist is a real recipient. An org that needs T-box work sends `message/send` to the
// ontology-engineering org with skill `oe.ontologist`; that org's DO verifies the message against a
// delegation and runs the turn under ITS OWN SKILL.md. The division of ownership is the point:
//
//   the TARGET domain org  owns the endeavor, its specs/, and the working ontology;
//   the ONTOLOGY-ENGINEERING org owns the archetypes' SKILL.md and runs their turns.
//
// ONE SKILL ID PER ARCHETYPE, which is a security decision rather than a naming one. A2A authorizes
// by selector: `allowedMethods` is a list of `bytes4` skill selectors, so one id per archetype lets
// a grant say "you may ask my Ontologist and my Reviewer" and withhold the rest. A single
// `oe.archetype` skill taking the archetype as an argument would collapse that to all-or-nothing,
// and the argument would be caller-supplied — exactly the authority-in-a-message shape ADR-0041
// forbids.
//
// The SKILL.md is a HARNESS READ on the recipient's side, never carried in the request. A caller
// that could supply the specialist's instructions would be writing its own reviewer.
import { runIntent, createRuleBasedPlanner, type Planner, type ToolSpec, type RunResult } from '@agenticprimitives/orchestration';
import { selectPlanner, withPlaybook, type PlannerEnv } from './orchestration.js';
import { EVIDENCE_MAX } from './endeavors.js';

/** A2A skill id for an archetype slug — `ontologist` → `oe.ontologist`. */
export const archetypeSkillId = (slug: string): string => `oe.${slug}`;

/** The archetype's capability IRI namespace, as the ontology-engineering context registers it. */
export const capabilityIriFor = (slug: string): string => `urn:skills:cap:ontology-engineering:${slug}`;

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

export const OE_ARCHETYPES: readonly ArchetypeDef[] = [
  { slug: 'domain-analyst', label: 'Domain Analyst',
    capabilities: ['domain-requirements-analysis', 'competency-question-elicitation'].map(capabilityIriFor) },
  { slug: 'cluster-architect', label: 'Cluster Architect',
    capabilities: ['semantic-clustering', 'semantic-packaging'].map(capabilityIriFor) },
  { slug: 'information-architect', label: 'Information Architect',
    capabilities: ['ontology-documentation'].map(capabilityIriFor) },
  { slug: 'ontologist', label: 'Ontologist',
    capabilities: ['upper-ontology-grounding', 'tbox-modeling', 'shacl-contract-authoring', 'canonical-id-minting'].map(capabilityIriFor) },
  { slug: 'taxonomist', label: 'Taxonomist',
    capabilities: ['vocabulary-curation'].map(capabilityIriFor) },
  { slug: 'ontology-reviewer', label: 'Ontology Reviewer',
    capabilities: ['ontology-review'].map(capabilityIriFor) },
  // The three the specs-first flow adds. They are archetypes rather than skills on an existing one
  // because each owns a decision the others should not make: how much work a wave is, what the
  // written source says, and whether a shape has ever been tested against an instance.
  { slug: 'ontology-creation-planner', label: 'Ontology Creation Planner',
    capabilities: ['ontology-build-planning', 'endeavor-wave-design'].map(capabilityIriFor) },
  { slug: 'spec-librarian', label: 'Spec Librarian',
    capabilities: ['spec-ingest', 'spec-citation'].map(capabilityIriFor) },
  { slug: 'exemplar-curator', label: 'Exemplar Curator',
    capabilities: ['abox-exemplar-authoring', 'shape-smoke-test'].map(capabilityIriFor) },
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
  /** The archetype being asked. Redundant with the skill id BY DESIGN — a mismatch means the caller
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
 * `expectArchetype` is the skill the message actually arrived on. Checking the body against it is
 * what stops a caller authorized for one archetype from addressing another through the body, which
 * is the only way the per-selector authorization could otherwise be sidestepped.
 */
export function parseArchetypeWorkInput(raw: unknown, expectArchetype: string): ParsedArchetypeWork | ArchetypeWorkParseError {
  const o = (raw ?? {}) as Record<string, unknown>;
  if (o.version !== 'ap.archetype.work.v1') return { ok: false, error: 'body must be ap.archetype.work.v1' };
  const archetype = String(o.archetype ?? '').trim();
  if (!archetype) return { ok: false, error: 'archetype is required' };
  if (archetype !== expectArchetype) {
    return { ok: false, error: `body archetype "${archetype}" does not match the skill it was sent to ("${expectArchetype}")` };
  }
  if (!archetypeBySlug(archetype)) return { ok: false, error: `unknown archetype "${archetype}"` };
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
      stepGoal: stepGoal.slice(0, 4_000),
      ...(str(o.endeavorId, 120) ? { endeavorId: str(o.endeavorId, 120)! } : {}),
      ...(str(o.stepId, 120) ? { stepId: str(o.stepId, 120)! } : {}),
      ...(str(o.capabilityIri, 300) ? { capabilityIri: str(o.capabilityIri, 300)! } : {}),
      ...(str(o.specDigest, EVIDENCE_MAX) ? { specDigest: str(o.specDigest, EVIDENCE_MAX)! } : {}),
      ...(paths?.length ? { specPaths: paths } : {}),
      ...(str(o.currentTurtle, EVIDENCE_MAX) ? { currentTurtle: str(o.currentTurtle, EVIDENCE_MAX)! } : {}),
      ...(str(o.extra, 4_000) ? { extra: str(o.extra, 4_000)! } : {}),
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

export interface ArchetypeTurnResult {
  deliverable: ArchetypeDeliverableV1 | null;
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
  const skillMd = await args.readSkillMd(args.input.archetype);
  if (!skillMd || !skillMd.trim()) {
    throw new Error(`no SKILL.md for archetype "${args.input.archetype}" — refusing to answer as a specialist without its instructions`);
  }

  const { planner, kind } = selectPlanner(env, {
    systemPrompt: withPlaybook(skillMd, ARCHETYPE_CONTRACT),
    // The deliverable rides inside the tool call's input, so the output budget must cover the whole
    // artifact — the same ceiling the endeavor work turn needed, for the same reason.
    maxTokens: 16_000,
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
    return { deliverable: captured, plannerKind: kind, result };
  }

  try {
    const result = await runIntent({ goal, context: {} }, { planner, tools: ARCHETYPE_TOOLS, invoke });
    return {
      deliverable: captured, plannerKind: kind, result,
      ...(captured ? {} : { error: 'turn completed without posting a deliverable' }),
    };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return { deliverable: captured, plannerKind: kind, result: { steps: [], error } as unknown as RunResult, error };
  }
}
