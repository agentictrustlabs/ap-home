// AN INSTRUCTION SKILL, APPLIED — `skill.apply` (spec 415 A4; the `playbook.answer` mechanism generalised).
//
// THE GAP THIS CLOSES. A SKILL.md that names no tool and asks for no authority — a governance assessor, a decision
// brief, a grant LOI drafter — is a skill NOTHING PERFORMS but the model under the skill's own body. Compiled into a
// playbook it used to be an "unprofiled" stub the planner could never choose (spec 415 §4 A4). Now each such skill is
// an INFORMATIONAL TOOL of its own (`execution: 'instruction'`, `source: {skillId, version, contractDigest}` — the
// `~/skills` compiler stamps both), the planner chooses among them by their descriptions, and choosing one runs the
// model ONCE under that skill's body over the person's words. The step is governed by the contract it names
// (`governedBySkill` on the run's provenance, from `source`), which is what a selection judge reads.
//
// WHAT IT IS. A read that reads nothing of the person's: the material is the ask, the judgement is the skill's. The
// body is read from the skills corpus BY THE DIGEST the playbook pinned — a body that moved is refused, never applied
// as if it were the pinned one. The answer renders as written (`answer: '{{answer}}'`, spec 371): advice, not a fact
// read from a record, so the grounded-composition governor has no table to judge it against.
//
// WHAT IT IS NOT. Not an act: nothing is performed, certified, submitted or ruled, and no mandate is asked for. Not
// the playbook's doctrine: the body is NOT in the archetype's instructions (twelve bodies in every planner prompt
// would be the cost), it is read when chosen. Not a fallback: a skill whose corpus is unbound is not listed.
import type { ToolSpec, ToolInvoker } from '@agenticprimitives/orchestration';
import type { StructuredCall } from '@agenticprimitives/context';
import type { DefinitionToolV1 } from '@agenticprimitives/capability-claims';
import { remembered } from './run-memo.js';

export interface InstructionToolLike extends DefinitionToolV1 { execution: 'instruction'; source: NonNullable<DefinitionToolV1['source']> }

const isInstruction = (t: DefinitionToolV1): t is InstructionToolLike => t.execution === 'instruction' && !!t.source && !t.capability;

/** The playbook's instruction skills as the planner's tools — each under its own contract's words. */
export function instructionSkillTools(playbook: { tools?: Record<string, DefinitionToolV1> } | null | undefined): ToolSpec[] {
  return Object.values(playbook?.tools ?? {}).filter(isInstruction).map((t) => ({
    id: t.id,
    description: t.description,
    inputSchema: t.inputSchema ?? { type: 'object', properties: { question: { type: 'string', description: 'What the person asked, in their own words' }, material: { type: 'string', description: 'The situation the person described, verbatim, when there is one' } }, required: ['question'] },
    ...(t.answers?.length ? { answers: t.answers } : {}),
    answer: t.answer ?? '{{answer}}',
    establishes: 'lookup',
  }));
}

export interface SkillDocument { body: string; commitment: string; version?: string }

/** Read a skill from the corpus by canonical id — the body under its frontmatter, and its content commitment. */
export type SkillReader = (skillId: string) => Promise<SkillDocument | null>;

/** The corpus over the `SKILLS_MCP` service binding (skills-mcp `GET /skill?skillset=public&id=…`), remembered a minute per id. */
export function skillReaderFor(corpus: Fetcher): SkillReader {
  return (skillId) => remembered(`skill-doc:${skillId}`, async () => {
    const r = await corpus.fetch(new Request(`https://skills-mcp/skill?skillset=public&id=${encodeURIComponent(skillId)}`));
    if (!r.ok) return null;
    const doc = (await r.json().catch(() => null)) as { content?: unknown; commitment?: unknown; version?: unknown } | null;
    if (!doc || typeof doc.content !== 'string' || typeof doc.commitment !== 'string') return null;
    const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(doc.content);
    return { body: (m ? doc.content.slice(m[0].length) : doc.content).trim(), commitment: doc.commitment, ...(doc.version !== undefined ? { version: String(doc.version) } : {}) };
  });
}

const APPLY_SYSTEM =
  'You are answering AS this agent, for the person whose agent you are, under ONE of the skills its playbook holds — '
  + 'the skill\'s own document follows. The person\'s words are the only material: you have been shown nothing they '
  + 'have not, and you invent no fact about them, their organization or their systems. Answer under the skill\'s own '
  + 'method and in the person\'s terms; where the skill prescribes placeholders for unsupplied facts, caveats, tiers, '
  + 'questions back or a refusal, keep them exactly. Guidance only: nothing is performed, certified, submitted, sent or '
  + 'ruled on, and you say so where the skill says so. Be concrete and as short as the method allows.';

export interface SkillApplyDeps {
  /** The structured-completion call for this turn, routed the same way the planner's is. */
  call: StructuredCall | undefined;
  /** The offered instruction tools' sources by tool id (`instructionSourcesOf`) — what each answer is applied under. */
  sources: Record<string, InstructionToolLike['source']>;
  readSkill: SkillReader;
  agentName?: string | null;
  maxTokens?: number;
  /** Spec 416 — a comparison measuring the PICK alone: the step is stamped under the skill (so the selection is read
   *  exactly as in a full run) but the skill is not applied — no body read, no model call. Never set outside a variant. */
  pickOnly?: boolean;
}

/** The invoker: the skill's body by its pinned digest, the model once, the answer as written. */
export function skillApplyInvoker(deps: SkillApplyDeps): ToolInvoker {
  return async (toolId, args) => {
    const source = deps.sources[toolId];
    if (!source) return { refused: `${toolId} is not an instruction skill of this playbook` };
    if (deps.pickOnly) return { answer: `(pick-only comparison) ${source.skillId} was selected; it was not applied.`, skill: { id: source.skillId, version: source.version, digest: source.contractDigest }, source: `${deps.agentName ?? 'this agent'}, selection only` };
    if (!deps.call) return { refused: 'no model is available to answer with' };
    const question = String(args.question ?? '').trim();
    if (!question) return { refused: 'an instruction skill answers a question; none was asked' };
    if (source.contractDigest.startsWith('id:')) return { refused: `${source.skillId} was compiled without a content commitment; a body cannot be applied under a pin that names none` };
    const doc = await deps.readSkill(source.skillId);
    if (!doc) return { refused: `${source.skillId} could not be read from the corpus` };
    if (doc.commitment !== source.contractDigest) return { refused: `${source.skillId} has moved: the playbook pins ${source.contractDigest}, the corpus serves ${doc.commitment} — re-assign the playbook to apply the current skill` };
    const material = typeof args.material === 'string' && args.material.trim() ? `\n\nThe situation, in the person's words:\n${args.material.trim()}` : '';
    const out = await deps.call({
      system: `${APPLY_SYSTEM}\n\n---\n\n${doc.body}`,
      messages: [{ role: 'user', content: `${question}${material}` }],
      tool: { name: 'skill_answer', description: `The answer under ${source.skillId}, as the person will read it.`, input_schema: { type: 'object', properties: { answer: { type: 'string', description: 'The answer, in the person\'s terms, under the skill\'s method' } }, required: ['answer'] } },
      maxTokens: deps.maxTokens ?? 1400,
    });
    const answer = typeof out['answer'] === 'string' ? out['answer'].trim() : '';
    if (!answer) return { refused: `the model returned no answer under ${source.skillId}` };
    return { answer, skill: { id: source.skillId, version: source.version, digest: source.contractDigest }, source: `${deps.agentName ?? 'this agent'}, under ${source.skillId}` };
  };
}

/** The offered instruction tools' sources, keyed by tool id — what the invoker applies under. */
export function instructionSourcesOf(playbook: { tools?: Record<string, DefinitionToolV1> } | null | undefined): Record<string, InstructionToolLike['source']> {
  return Object.fromEntries(Object.values(playbook?.tools ?? {}).filter(isInstruction).map((t) => [t.id, t.source]));
}
