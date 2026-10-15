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
import type { TextStreamCall } from '@agenticprimitives/orchestration-openai-compat';
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
  /** Spec 417 §5 — the call FOR ONE STEP (so the trace ties the model call, its tokens and its time to the step that
   *  made it). Preferred over `call` when given. */
  callFor?: (stepRef: string) => StructuredCall | undefined;
  /** Spec 418 A1 — a STREAMED answer for one step (plain text over SSE); when given, the answer streams and each growing
   *  draft goes to `onDraft` (throttled). The structured call is not used for that step. */
  streamFor?: (stepRef: string) => TextStreamCall | undefined;
  onDraft?: (stepRef: string, draft: string) => void;
  /** Called once, with ms from the step's start to the first streamed words. */
  onFirstWords?: (stepRef: string, ms: number) => void;
  /** The offered instruction tools' sources by tool id (`instructionSourcesOf`) — what each answer is applied under. */
  sources: Record<string, InstructionToolLike['source']>;
  readSkill: SkillReader;
  agentName?: string | null;
  maxTokens?: number;
  /** Spec 416 — a comparison measuring the PICK alone: the step is stamped under the skill (so the selection is read
   *  exactly as in a full run) but the skill is not applied — no body read, no model call. Never set outside a variant. */
  pickOnly?: boolean;
  /** 2026-10-14 (W0, the harness half) — A RUN ENDS BY PRODUCING ITS RECORD. For a tool id, the classes the skill
   *  produces with the fields their shapes require: the answer is asked to END with a fenced ```record block holding one
   *  JSON object per class (the prose before it is the rendering), the block is parsed off the answer and returned as
   *  `records`, and the declared record effect writes each to the asker's vault. Absent ⇒ the answer as before (the
   *  control arm). CIL's bodies will state the same closing section upstream; this instruction is the harness's until then. */
  recordsFor?: (toolId: string) => Array<{ iri: string; label: string; requiredFields: string[]; qualityFields?: string[] }> | undefined;
}

/** The closing instruction, from the classes and their shapes. Pure, so a test can hold the words. */
export function recordInstructionOf(specs: ReadonlyArray<{ iri: string; label: string; requiredFields: string[]; qualityFields?: string[] }>): string {
  return [
    'END YOUR ANSWER WITH ITS RECORD. After the prose, add one fenced block tagged `record` holding a JSON array with one object per artifact below — the typed record the answer renders. Each object has `"@type"` (the class IRI exactly as given), `"label"` (a short title), every REQUIRED field, and the optional fields where the answer has them. A field whose value is a controlled term uses the term exactly; a field that references another artifact gives that artifact\'s label as a string; a field for which the request gave no fact gets a clearly marked placeholder string (never an invented fact). The prose stays the person\'s rendering; the block is the record.',
    ...specs.map((sp) => `- ${sp.label} — "@type": "${sp.iri}"; required: ${sp.requiredFields.length ? sp.requiredFields.join(', ') : '(label only)'}${sp.qualityFields?.length ? `; optional: ${sp.qualityFields.join(', ')}` : ''}`),
  ].join('\n');
}

/** The record block off the end of an answer: the prose without it, and the records (one per `@type`). An unparsable
 *  block is reported, never silently dropped — the answer keeps its text either way. */
/** The instruction answer's output budget. 1400 ended a CIL document mid-sentence (`finish_reason: length`, 2026-10-15 —
 *  on Gemini 3.5 the model's thinking spends the same budget, so 1400 bought 2.6k characters); a complete crosswalk or
 *  playbook is 4–5k characters, and the record block rides after it. `brief` (an intermediate chain step) stays at 600. */
export const DEFAULT_ANSWER_TOKENS = 4000;

export function splitRecordBlock(answer: string): { text: string; records: Array<{ class: string; record: Record<string, unknown> }>; error?: string } {
  // The fenced block the instruction asks for — or, as a structured (tool-call) answer tends to come back (Gemini,
  // 2026-10-15), the same JSON array BARE at the end of the answer after a rule or a blank line: the record is the record.
  // …or fenced under any tag (`json`, none): Gemini wrote ```json around the array one ask in two (2026-10-15). The content
  // decides — a JSON array of `@type` objects at the end of the answer is the record block whatever the fence says.
  const m = /\n?```record\s*\n([\s\S]*?)\n```\s*$/.exec(answer)
    ?? /\n?```(?:json|jsonc|)\s*\n(\s*\[[\s\S]*?\])\s*\n```\s*$/.exec(answer)
    ?? /\n(?:---\n)?(\[\s*\{\s*"@type"[\s\S]*\])\s*$/.exec(answer);
  if (!m) {
    // 2026-10-15 — an opened fence with no close is an answer that hit its token cap (or a gateway's) before the record
    // landed: say so, so the state check's "no record" has a cause and the run's failure reads `environment`, not `agent`.
    const open = /\n?```record\s*\n/.exec(answer);
    return open ? { text: answer.slice(0, open.index).trimEnd(), records: [], error: 'the record block was cut off before it closed — the answer hit its output cap' } : { text: answer, records: [] };
  }
  const text = answer.slice(0, m.index).trimEnd();
  try {
    const parsed = JSON.parse(m[1]!) as unknown;
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    const records = arr.flatMap((r) => (r && typeof r === 'object' && typeof (r as { '@type'?: unknown })['@type'] === 'string' ? [{ class: (r as { '@type': string })['@type'], record: Object.fromEntries(Object.entries(r as Record<string, unknown>).filter(([k]) => k !== '@type')) }] : []));
    return { text, records, ...(records.length !== arr.length ? { error: `${arr.length - records.length} record(s) without an @type` } : {}) };
  } catch (e) { return { text, records: [], error: `the record block is not JSON: ${e instanceof Error ? e.message : String(e)}` }; }
}

/** The invoker: the skill's body by its pinned digest, the model once, the answer as written. */
export function skillApplyInvoker(deps: SkillApplyDeps): ToolInvoker {
  return async (toolId, args, ctx) => {
    const call = deps.callFor ? deps.callFor(ctx?.step?.id ?? `s${ctx?.index ?? 0}`) : deps.call;
    const source = deps.sources[toolId];
    if (!source) return { refused: `${toolId} is not an instruction skill of this playbook` };
    if (deps.pickOnly) return { answer: `(pick-only comparison) ${source.skillId} was selected; it was not applied.`, skill: { id: source.skillId, version: source.version, digest: source.contractDigest }, source: `${deps.agentName ?? 'this agent'}, selection only` };
    if (!call) return { refused: 'no model is available to answer with' };
    const question = String(args.question ?? '').trim();
    if (!question) return { refused: 'an instruction skill answers a question; none was asked' };
    if (source.contractDigest.startsWith('id:')) return { refused: `${source.skillId} was compiled without a content commitment; a body cannot be applied under a pin that names none` };
    const doc = await deps.readSkill(source.skillId);
    if (!doc) return { refused: `${source.skillId} could not be read from the corpus` };
    if (doc.commitment !== source.contractDigest) return { refused: `${source.skillId} has moved: the playbook pins ${source.contractDigest}, the corpus serves ${doc.commitment} — re-assign the playbook to apply the current skill` };
    // Spec 417 — a chain hands earlier steps' answers on as material (one, or a list when a skill works from several).
    const pieces = (Array.isArray(args.material) ? args.material : [args.material]).filter((m): m is string => typeof m === 'string' && !!m.trim()).map((m) => m.trim());
    const material = !pieces.length ? '' : Array.isArray(args.material) ? `\n\nThe material, from earlier steps:\n${pieces.map((m, i) => `--- ${i + 1} ---\n${m}`).join('\n\n')}` : `\n\nThe situation, in the person's words:\n${pieces[0]}`;
    const stepRef = ctx?.step?.id ?? `s${ctx?.index ?? 0}`;
    const stream = deps.streamFor?.(stepRef);
    // W0 — the record instruction, when the comparison (or the deployment) asked for records and the skill produces classes.
    const specs = deps.recordsFor?.(toolId);
    const recordAsk = specs?.length ? `\n\n---\n\n${recordInstructionOf(specs)}` : '';
    // The ask rides in the USER turn too: placed only after the skill body in the system prompt, Gemini followed it on
    // some asks and not others (2026-10-15, two of four). The last line of the request is the one a model answers to.
    const recordNudge = specs?.length ? `\n\n(End with the \`record\` block: ${specs.map((s) => s.label).join(', ')}.)` : '';
    // 2026-10-15 — THE BODY IS THE PRODUCT (docs/cil-commons/record-first-2026-10-14.md): a skill whose body states its
    // record ends every answer with the block whether or not the harness appended the ask — `skill/record` only adds the
    // instruction. So the block is read off EVERY answer and handed to the record effect; "asked" and "no block" are said
    // only when the harness asked, and an answer with neither ask nor block is returned untouched.
    const withRecords = (answer: string): { answer: string; recordsAsked?: string[]; records?: Array<{ class: string; record: Record<string, unknown> }>; recordError?: string } => {
      const r = splitRecordBlock(answer);
      if (!specs?.length && !r.records.length && !r.error) return { answer };
      return { answer: r.text, ...(specs?.length ? { recordsAsked: specs.map((s) => s.iri) } : {}), ...(r.records.length ? { records: r.records } : {}), ...(r.error ? { recordError: r.error } : specs?.length && !r.records.length ? { recordError: 'the answer carried no record block' } : {}) };
    };
    if (stream) {
      const t0 = Date.now(); let first = false; let lastEmit = 0;
      const text = await stream({
        system: `${APPLY_SYSTEM}\n\n---\n\n${doc.body}\n\n---\n\nWrite the answer itself, as the person will read it — plain text or markdown, nothing around it.${recordAsk}`,
        messages: [{ role: 'user', content: `${question}${material}${recordNudge}` }],
        maxTokens: args.brief === true ? Math.min(deps.maxTokens ?? DEFAULT_ANSWER_TOKENS, 600) : deps.maxTokens ?? DEFAULT_ANSWER_TOKENS,
        onDelta: (_d, soFar) => {
          const now = Date.now();
          if (!first) { first = true; deps.onFirstWords?.(stepRef, now - t0); }
          if (now - lastEmit > 400) { lastEmit = now; deps.onDraft?.(stepRef, soFar); }
        },
      }).catch((e: unknown) => { throw new Error(`the streamed answer under ${source.skillId} failed: ${e instanceof Error ? e.message : String(e)}`); });
      deps.onDraft?.(stepRef, text);
      return { ...withRecords(text.trim()), skill: { id: source.skillId, version: source.version, digest: source.contractDigest }, source: `${deps.agentName ?? 'this agent'}, under ${source.skillId}` };
    }
    const out = await call({
      system: `${APPLY_SYSTEM}\n\n---\n\n${doc.body}${recordAsk}`,
      messages: [{ role: 'user', content: `${question}${material}${recordNudge}` }],
      tool: { name: 'skill_answer', description: `The answer under ${source.skillId}, as the person will read it.`, input_schema: { type: 'object', properties: { answer: { type: 'string', description: 'The answer, in the person\'s terms, under the skill\'s method' } }, required: ['answer'] } },
      // Spec 418 — an intermediate chain step (`brief`) produces only the artifact the next step consumes: a smaller budget.
      maxTokens: args.brief === true ? Math.min(deps.maxTokens ?? DEFAULT_ANSWER_TOKENS, 600) : deps.maxTokens ?? DEFAULT_ANSWER_TOKENS,
    });
    const answer = typeof out['answer'] === 'string' ? out['answer'].trim() : '';
    if (!answer) return { refused: `the model returned no answer under ${source.skillId}` };
    return { ...withRecords(answer), skill: { id: source.skillId, version: source.version, digest: source.contractDigest }, source: `${deps.agentName ?? 'this agent'}, under ${source.skillId}` };
  };
}

/** The offered instruction tools' sources, keyed by tool id — what the invoker applies under. */
export function instructionSourcesOf(playbook: { tools?: Record<string, DefinitionToolV1> } | null | undefined): Record<string, InstructionToolLike['source']> {
  return Object.fromEntries(Object.values(playbook?.tools ?? {}).filter(isInstruction).map((t) => [t.id, t.source]));
}
