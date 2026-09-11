// A QUESTION OF JUDGEMENT, ANSWERED FROM THE PLAYBOOK — `playbook.answer`.
//
// THE GAP THIS CLOSES. The harness is a tool planner: every ask is satisfied by a tool or is
// `ask.unsupported`. That is right for records and acts — a planner must never invent a balance or
// perform a payment by paraphrase — and it left one whole class of ask with no tool at all: "here is
// what I can see; what should I do?" A card room asks a person's own agent that on every hand
// (`poker.advise`, `canasta.advise`), carrying the seat's own view in the message. The agent's card
// ADVERTISED the skill; its harness answered "I can't help with that here" and listed the payments it
// could make instead (seen live, alice.me, 2026-09-11).
//
// WHAT IT IS. A read that reads nothing: the material is in the message, the judgement is the playbook's.
// It runs the model ONCE under the archetype's own instructions — the doctrine a person chose for their
// agent, versioned and receipted (spec 354) — over the material and the question, and returns one
// structured answer. `answer` renders it deterministically, so the grounded-composition governor (built
// for facts read from records) never judges a sentence of advice against a table it cannot check.
//
// WHAT IT IS NOT. Not an act: nothing is performed and no mandate is asked for; a suggested move in the
// answer is a suggestion, and the card room applies nothing it returns. Not a record: the answer is an
// observation with its source named — this agent, this playbook. And not a fallback for the planner:
// it is LISTED only when the message names a skill the addressee's card publicly advertises, so an
// agent answers exactly the questions it has said it answers (fail closed, ADR-0013).
import type { ToolSpec, ToolInvoker } from '@agenticprimitives/orchestration';
import type { StructuredCall } from '@agenticprimitives/context';

export const PLAYBOOK_ANSWER_CAPABILITY = 'playbook.answer';

export const PLAYBOOK_ANSWER_TOOL: ToolSpec = {
  id: PLAYBOOK_ANSWER_CAPABILITY,
  answers: ['what I should do', 'what should I do here', 'advice', 'advise'],
  verbs: ['advise'],
  description:
    'ANSWERS A QUESTION OF JUDGEMENT FROM THIS AGENT\'S OWN PLAYBOOK, over material the message itself carried. '
    + 'Use it when the ask names one of the advisory skills this agent advertises (for example poker.advise, '
    + 'canasta.advise, poker.review, canasta.review) or asks what the person should do about a situation the '
    + 'message describes. It reads no records and performs nothing: the material is in the message and the '
    + 'judgement is the playbook\'s. Args: skill (the skill the ask names, exactly), question (what was asked, '
    + 'in the person\'s words — or the skill\'s own purpose when nothing was asked).',
  inputSchema: {
    type: 'object',
    properties: {
      skill: { type: 'string', description: 'The advisory skill the ask names, exactly as written (poker.advise)' },
      question: { type: 'string', description: 'What was asked, in the person\'s own words' },
    },
    required: ['skill'],
  },
  // Rendered, never composed: the invoker already wrote the answer under the playbook, and the
  // grounded-composition governor has no table to check a sentence of advice against.
  answer: '{{answer}}',
  establishes: 'lookup',
};

/** What the message carried for the skill to reason over: the card room's `{ skill, input }` data part. */
export interface PlaybookMaterial {
  skill: string;
  input?: unknown;
  question?: string;
  /** How the asker wants the answer shaped, field by field — the action union of its own game, say. Honoured verbatim. */
  answer?: Record<string, string>;
}

export interface PlaybookAnswerDeps {
  /** The structured-completion call for this turn, routed the same way the planner's is. */
  call: StructuredCall | undefined;
  /** The playbook's own instructions — what this agent IS, in its person's chosen words. */
  instructions?: string | null;
  /** The material the message carried. Absent ⇒ the tool refuses, it never invents a situation. */
  material?: PlaybookMaterial | null;
  /** The addressee's name, for the answer's source line. */
  agentName?: string | null;
  /** Skills the addressee's card advertises. The tool answers ONLY those. */
  advertised: string[];
  maxTokens?: number;
}

/** Whether the tool should be LISTED for this turn: a named, advertised skill, and a model to answer with. */
export function playbookAnswerAvailable(deps: Pick<PlaybookAnswerDeps, 'call' | 'material' | 'advertised'>): boolean {
  const skill = deps.material?.skill;
  return !!deps.call && typeof skill === 'string' && skill.trim() !== '' && deps.advertised.map((s) => s.toLowerCase()).includes(skill.toLowerCase());
}

const ANSWER_SYSTEM =
  'You are answering AS this agent, for the person whose agent you are, from the playbook below. The '
  + 'material is what the person can see themselves; you have been shown nothing they have not. Answer '
  + 'the question of judgement it poses.\n\n'
  + 'REASON FIRST, in `reasoning`, in the order the playbook teaches — the price, the outs, position, '
  + 'what the board beats, the money behind — and only then decide. WHEN A READ IS GIVEN, ITS NUMBERS ARE '
  + 'THE NUMBERS: use them and do not recompute them. When a house baseline is given it is a rules coach\'s '
  + 'line and is right about the mechanics; start from it, and depart from it only for a reason you state '
  + 'in `reasoning`. A move that is free (checking) is never folded. A move must be one the legal moves '
  + 'allow.\n\n'
  + 'Then be concrete and short: `say` is ONE sentence for somebody with a clock running; `because` is the '
  + 'reason, which is the half that teaches; `action` is the move you would make, in exactly the action '
  + 'shape asked for, or omitted when you would not commit to one. Never claim to know what you cannot '
  + 'see. Never perform anything — this is advice, and the person plays the move or does not.';

/** A review skill (`*.review`) is told how something went; it is acknowledged in one line, never advised on. */
const REVIEW_SYSTEM =
  'You are this agent, being told how a finished round went for the person whose agent you are, so that '
  + 'you can remember it. Reply in ONE sentence: what is worth remembering from it, or that nothing is. '
  + 'Do not advise — the round is over.';

export function playbookAnswerInvoker(deps: PlaybookAnswerDeps): ToolInvoker {
  return async (toolId, args) => {
    if (toolId !== PLAYBOOK_ANSWER_CAPABILITY) return { refused: `${toolId} is not playbook.answer` };
    const m = deps.material;
    const skill = String(args.skill ?? m?.skill ?? '').trim();
    if (!m || !skill) return { refused: 'the message carried no material to answer from' };
    if (!deps.advertised.map((s) => s.toLowerCase()).includes(skill.toLowerCase())) {
      return { refused: `${deps.agentName ?? 'this agent'} does not advertise ${skill}` };
    }
    if (!deps.call) return { refused: 'no model is available to answer with' };
    const review = /\.review$/i.test(skill);
    const question = String(args.question ?? m.question ?? '').trim();
    const system = `${review ? REVIEW_SYSTEM : ANSWER_SYSTEM}\n\n---\n\n${relevantInstructions(deps.instructions, skill) || '(this agent has no further instructions)'}`;
    // THE ASKER'S OWN SHAPE, when it sent one. A card room names its game's exact action union; an answer
    // in any other shape is a move it can only refuse to draw a button for.
    const shape = m.answer && typeof m.answer === 'object'
      ? Object.entries(m.answer).filter(([, v]) => typeof v === 'string').map(([k, v]) => `  ${k}: ${v}`).join('\n')
      : '';
    // THE READ AND THE BASELINE, set apart from the raw material. A card room computes the arithmetic
    // and sends its own rules coach's line; both are worth more to a model than the table they came
    // from, and buried in one JSON blob they were read as just more fields.
    const inp = (m.input && typeof m.input === 'object' ? m.input : {}) as Record<string, unknown>;
    const { read, baseline, ...rest } = inp;
    const user = [
      `Skill: ${skill}`,
      question ? `Question: ${question}` : 'Question: (nothing specific was asked — say what to do, and why)',
      ...(shape ? [`Answer shape, field by field:\n${shape}`] : []),
      ...(read != null ? [`Read — the facts of the spot, computed (use these numbers):\n${JSON.stringify(read)}`] : []),
      ...(baseline != null ? [`House baseline — a rules coach's line, as an observation:\n${JSON.stringify(baseline)}`] : []),
      `Material: ${JSON.stringify(rest)}`,
    ].join('\n');
    const started = Date.now();
    const out = await deps.call({
      system,
      messages: [{ role: 'user', content: user }],
      tool: review
        ? { name: 'reviewed', description: 'What is worth remembering.', input_schema: { type: 'object', properties: { say: { type: 'string' } }, required: ['say'] } }
        : {
            name: 'advice',
            description: 'One sentence to say, the reason, and optionally the move.',
            input_schema: {
              type: 'object',
              properties: {
                // FIRST, on purpose: a model that has to write its reasoning before its answer gives a
                // better answer, and the reasoning stays here — only say/because/action go back.
                reasoning: { type: 'string', description: 'At most 60 words: the price, the outs, position, the board, the money behind — then the decision. Not shown to the person.' },
                say: { type: 'string', description: 'One sentence, for somebody with a clock running' },
                because: { type: 'string', description: 'The reason — the half that teaches' },
                action: { type: 'object', description: 'The move, in the action shape the legal moves use; omit to commit to none', additionalProperties: true },
              },
              required: ['reasoning', 'say', 'because'],
            },
          },
      maxTokens: deps.maxTokens ?? 700,
    });
    const say = typeof out.say === 'string' ? out.say.trim() : '';
    if (!say) return { refused: 'the playbook produced no answer' };
    const because = typeof out.because === 'string' ? out.because.trim() : undefined;
    const action = out.action && typeof out.action === 'object' ? out.action : undefined;
    // How long the model took, on the record: latency is a fact about the answer worth keeping beside it.
    console.log(`[playbook.answer] ${skill} model ${Date.now() - started}ms · prompt ${system.length + user.length} chars · answer ${say.length + (because?.length ?? 0)} chars`);
    const result = { skill, say, ...(because ? { because } : {}), ...(action ? { action } : {}), source: deps.agentName ?? 'this agent', modelMs: Date.now() - started, promptChars: system.length + user.length };
    // `answer` is the rendered reply — the JSON a card room decodes, verbatim. The fields beside it are
    // the same answer as an observation, for the trace.
    return { ...result, answer: JSON.stringify({ say, ...(because ? { because } : {}), ...(action ? { action } : {}) }) };
  };
}

/**
 * THE CRAFT THAT APPLIES, not the whole doctrine.
 *
 * A person steward's compiled instructions run to twenty "how each act is done" sections — payments,
 * invitations, charters — and every one of them was in the prompt for a question about a poker hand:
 * slower to read, and a distraction the model has to set aside. The opening (who this agent is) is
 * kept whole; of the act sections, only those about the skill's game are kept. A skill outside any
 * game keeps everything, because there is no basis to cut.
 */
export function relevantInstructions(instructions: string | null | undefined, skill: string): string {
  const text = (instructions ?? '').trim();
  if (!text) return '';
  const game = skill.split('.')[0]?.toLowerCase() ?? '';
  const words = game === 'poker' ? /hold.?em|poker/i : game === 'canasta' ? /canasta/i : null;
  if (!words) return text;
  const [opening, ...sections] = text.split(/\n(?=### )/);
  const kept = sections.filter((sec) => words.test(sec.split('\n')[0] ?? '') || words.test(sec.slice(0, 400)));
  // The compiler's "How each act is done" heading precedes the sections; keep it only with sections.
  const head = (opening ?? '').replace(/\n## How each act is done[\s\S]*$/, '').trim();
  return kept.length ? `${head}\n\n## How this is done\n\n${kept.join('\n')}` : head;
}
