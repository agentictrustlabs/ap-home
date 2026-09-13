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
// WHO ANSWERS AT A CARD TABLE (`card-room.ts`). A PERSON'S agent never runs this for `poker.advise`: it
// consults the coach SERVICE its playbook names, presenting the study grant the person signed, and the
// service runs this tool under that grant with the person's own records (`study`) beside the material —
// her style, her counts on the players here, her reads, the coach's past notes. `poker.review` is a real
// review over her recorded hands, on the service, when she asks. `poker.record` folds a finished hand
// into memory without a model. The only model call on a hand's clock is the coach's, on its own account.
//
// WHAT IT IS NOT. Not an act: nothing is performed and no mandate is asked for; a suggested move in the
// answer is a suggestion, and the card room applies nothing it returns. Not a record: the answer is an
// observation with its source named — this agent, this playbook. And not a fallback for the planner:
// it is LISTED only when the message names a skill the addressee's card publicly advertises, so an
// agent answers exactly the questions it has said it answers (fail closed, ADR-0013).
import type { ToolSpec, ToolInvoker } from '@agenticprimitives/orchestration';
import type { StructuredCall } from '@agenticprimitives/context';
import { foldObservation, familyOf, memoryRecordFor, observationOf, rememberedFor } from './playbook-memory.js';
import { compactHand, reviewScopeOf, spanLabel, type Study } from './card-room.js';

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
  /**
   * THE AGENT'S OWN MEMORY for a skill family (`playbook.memory:<family>`), in its own vault. A review
   * folds the round's observation in; advice reads the subjects at the table back. Absent ⇒ a review
   * is acknowledged and nothing is kept, and advice knows only what the message carried.
   */
  memory?: {
    /** `fresh` reads past any memo: a review folds into what is actually there, never into a minute-old copy. */
    read: (recordType: string, fresh?: boolean) => Promise<unknown>;
    write: (recordType: string, record: unknown) => Promise<{ ok: boolean; error?: string }>;
  };
  /**
   * THE PERSON'S STUDY, under her grant (`card-room.ts`) — present only when this agent is a coach SERVICE
   * consulted by the person's own agent, which presented a study grant `runAgentAsk` verified. Her style,
   * her hand record's counts on the players here, her reads, and this coach's own past notes, read from HER
   * vault; `note` appends one note to her cabinet. Present ⇒ `.review` is a real review over her hands.
   */
  study?: {
    load: () => Promise<Study>;
    /** The service consulted — the grant's delegate. */
    coach: string;
    note?: (text: string, extra?: { hand?: number; scope?: string; leak?: { pattern: string; count: number; of: number; cost?: number; metric?: string }; change?: string }) => Promise<{ ok: boolean; error?: string }>;
  };
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
  + 'in `reasoning`. When the baseline carries a `mix`, the solver itself splits between the two lines at '
  + 'that share: what you remember about the player across the table is the reason to pick one — bet '
  + 'into a player who folds to bets, check behind one who never does. A move that is free (checking) is '
  + 'never folded. A move must be one the legal moves allow.\n\n'
  + 'WHEN HER STUDY IS GIVEN — her style, her counts on the players here, her reads, your own past notes — '
  + 'it outranks in this order: her style beats your craft (say what a rule costs; never talk her out of '
  + 'it); the counts at this table, weighted by sample size (under ten hands is "so far", a lean; over '
  + 'thirty is a tendency); her reads; your notes. Say the price, then the player. Say the sample size '
  + 'when you use a count.\n\n'
  + 'EVIDENCE RULES, which override everything above. The ONLY facts about how she or anyone has played '
  + 'are the counts in "Her records" and the number of hands recorded. Your own past notes are your '
  + 'earlier OPINIONS, not a record of her hands: never count them, never say "you did this N times" '
  + 'from them, never treat a note about an earlier question as a hand she played. If the records hold '
  + 'one hand, she has one hand on record and you say so. A number you cannot point to in the records '
  + 'does not appear in your answer. Mid-hand you do not know how this hand ends, so you never describe '
  + 'it as won or lost. Preflop, the house baseline comes from a chart that agrees with a solver nine '
  + 'times in ten: say what the chart does and depart only for a count here or a rule she wrote. '
  + 'Pot odds are the share of the final pot a call buys — the equity a hand needs — not "how often the '
  + 'hand must be best"; preflop the chart already weighs that, so do not fold a chart-call on pot odds '
  + 'alone. A LIMP is entering an UNRAISED pot by calling; defending a blind against a raise is a call, '
  + 'not a limp, and a rule against limping does not forbid it.\n\n'
  + 'Then be concrete and short: `say` is ONE sentence for somebody with a clock running; `because` is the '
  + 'reason, which is the half that teaches; `action` is the move you would make, in exactly the action '
  + 'shape asked for, or omitted when you would not commit to one. Never claim to know what you cannot '
  + 'see. Never perform anything — this is advice, and the person plays the move or does not.';

const REVIEW_SYSTEM =
  'You are a hold\'em coach reviewing ONE person\'s past hands from her own records, because she asked. '
  + 'The records are hers: each hand as her seat saw it (her cards, the board, the action, the result) and '
  + 'the counts per player folded across every hand. Say the sample size in the first sentence — ten '
  + 'hands are an anecdote, thirty a lean, sixty a pattern. Then, in order: what happened (the money, in a '
  + 'few sentences); the two or three decisions that mattered, each with the street, the price and what it '
  + 'cost or earned; the leak they point to, with the count behind it and the chips it cost (two leaks at '
  + 'most); ONE thing to change next session, concrete enough to do on the first hand; what went right, in '
  + 'a sentence. A number you did not compute from the records is not in the review. If a leak is a rule '
  + 'in her style, say what it cost and that it is her rule. If she asks about one decision, answer the '
  + 'decision as it was at the time with what she could see — a right decision that lost is still right. '
  + 'Never review cards she could not see; opponents\' cards appear only when shown at showdown, and you '
  + 'say "shown" when you use them. With fewer than five hands, give one honest sentence and say what would '
  + 'change it. THE HANDS LISTED ARE THE WHOLE RECORD: your own earlier remarks are opinions, not hands — '
  + 'never count them, never say "N times" from them, and if they disagree with the hands, the hands win '
  + 'and you say you were wrong. Write it the way a coach talks after the session, not the way a '
  + 'spreadsheet prints.';

/**
 * THE OTHER GAME'S PROMPTS. Canasta has no price, no outs, no streets and no solver: the order the playbook
 * teaches is the pile, the partner's card count, the minimum, what the hand can build, what the discard
 * gives away — and a partnership is not a channel, so nothing here ever names a partner's card. The evidence
 * rules are the same rules with "rounds" for "hands".
 */
const ANSWER_SYSTEM_CANASTA =
  'You are answering AS this agent, for the person whose agent you are, from the playbook below. The '
  + 'material is what the person can see themselves — their own hand, every other seat as a card COUNT, the '
  + 'pile as its top card and size, both sides\' melds; you have been shown nothing they have not. Answer '
  + 'the question of judgement it poses.\n\n'
  + 'REASON FIRST, in `reasoning`, in the order the playbook teaches — the pile (its size, whether it is '
  + 'frozen, whether this hand can take it and what the discard after it gives away), the partner\'s card '
  + 'count, the opening minimum still to reach, what the hand can build toward a canasta, what the '
  + 'discard says — and only then decide. WHEN LEGAL MOVES ARE GIVEN, THEY ARE THE LAW: whether the pile '
  + 'can be taken and why not, the minimum to open, which cards may be discarded, whether the side may go '
  + 'out — use them and do not recompute them. When a house baseline is given it is a rules coach\'s line '
  + 'and is right about the mechanics; start from it, and depart from it only for a reason you state in '
  + '`reasoning`. Going out ends everybody\'s round: say it is available and what it is worth, and leave '
  + 'the press to the person. A move must be one the legal moves allow, in the game\'s own action shape '
  + '(draw; take-pile with the meld the top card goes into; meld with ranks and cards; discard with the card).\n\n'
  + 'WHEN THEIR STUDY IS GIVEN — their style, their counts on the players here, their reads, your own past '
  + 'notes — it outranks in this order: their style beats your craft (say what a rule costs; never talk '
  + 'them out of it); the counts at this table, weighted by sample size (under ten rounds is "so far", a '
  + 'lean; over thirty is a tendency) — the partner\'s going-out rate first; their reads; your notes. Say '
  + 'the pile, then the partner, then the move. Say the sample size when you use a count.\n\n'
  + 'EVIDENCE RULES, which override everything above. The ONLY facts about how they or anyone has played '
  + 'are the counts in "Their records" and the number of rounds recorded. Your own past notes are your '
  + 'earlier OPINIONS, not a record of their rounds: never count them, never say "you did this N times" '
  + 'from them. If the records hold one round, they have one round on record and you say so. A number you '
  + 'cannot point to in the records does not appear in your answer. On a turn you do not know how this '
  + 'round ends, so you never describe it as won or lost. NOTHING FACE-DOWN IS A FACT: what is under the '
  + 'pile\'s top card, what the partner holds, what an opponent holds — say what is likely from what has '
  + 'gone, as likelihood, and never name a partner\'s card.\n\n'
  + 'Then be concrete and short: `say` is ONE sentence for somebody with a clock running; `because` is the '
  + 'reason, which is the half that teaches; `action` is the move you would make, in exactly the action '
  + 'shape asked for, or omitted when you would not commit to one. Never claim to know what you cannot '
  + 'see. Never perform anything — this is advice, and the person plays the move or does not.';

const REVIEW_SYSTEM_CANASTA =
  'You are a canasta coach reviewing ONE person\'s past rounds from their own records, because they asked. '
  + 'The records are theirs: each round as their seat saw it (their hand at the end, both sides\' melds and '
  + 'which were canastas, the pile, who went out, each side\'s score and why) and the counts per seat folded '
  + 'across every round. Say the sample size in the first sentence — five rounds are an anecdote, fifteen a '
  + 'lean, thirty a pattern. Then, in order: what happened (the points, per side, in a few sentences); the '
  + 'two or three decisions that mattered, each with the round, the pile or the meld, and what it cost or '
  + 'earned in points; the leak they point to, with the count behind it and the points it cost (two leaks '
  + 'at most); ONE thing to change next session, concrete enough to do on the first turn; what went right, '
  + 'in a sentence. The partnership is counts, never blame: a partner\'s habit is "went out 4 of 11 rounds", '
  + 'and the change you propose is one the person can make. A number you did not compute from the records '
  + 'is not in the review. If a leak is a rule in their style, say what it cost and that it is their rule. '
  + 'If they ask about one decision, answer the decision as it was at the time with what they could see — '
  + 'a right decision that lost is still right. Never review cards they could not see; a partner\'s or '
  + 'opponent\'s hand appears only as a count and as what was melded. With fewer than three rounds, give '
  + 'one honest sentence and say what would change it. THE ROUNDS LISTED ARE THE WHOLE RECORD: your own '
  + 'earlier remarks are opinions, not rounds — never count them, never say "N times" from them, and if '
  + 'they disagree with the rounds, the rounds win and you say you were wrong. Write it the way a coach '
  + 'talks after the evening, not the way a scoreboard prints.';

/** The person's profile for this game, as the coach reads it (cr:PlayerProfile): register, goals, how to speak. */
function profileLines(p: NonNullable<Study['profile']>): string {
  const lines: string[] = [];
  if (p.level) lines.push(`Their own account of where they are at this game: ${p.level}${p.since ? ` (playing since ${p.since})` : ''} — "new" gets the rule named before the move, "strong" gets the number and the move.`);
  if (p.coachingStyle) lines.push(`How they want to be spoken to: ${p.coachingStyle === 'teach' ? 'teach me — the reason with every move' : p.coachingStyle === 'terse' ? 'keep it short — the move and one clause' : 'only when I ask — nothing unless they typed a question'}. This outranks your own doctrine about how to say it.`);
  if (p.goals.length) lines.push(`What they said they want to get better at (their goals, in their words):\n${p.goals.map((g) => `- ${g}`).join('\n')}`);
  if (p.about) lines.push(`In their words, about themselves: ${p.about}`);
  return `Their profile — what they told their coach:\n${lines.join('\n')}`;
}

const answerSystemFor = (skill: string): string => (familyOf(skill) === 'canasta' ? ANSWER_SYSTEM_CANASTA : ANSWER_SYSTEM);
const reviewSystemFor = (skill: string): string => (familyOf(skill) === 'canasta' ? REVIEW_SYSTEM_CANASTA : REVIEW_SYSTEM);

export function playbookAnswerInvoker(deps: PlaybookAnswerDeps): ToolInvoker {
  return async (toolId, args) => {
    if (toolId !== PLAYBOOK_ANSWER_CAPABILITY) return { refused: `${toolId} is not playbook.answer` };
    const m = deps.material;
    const skill = String(args.skill ?? m?.skill ?? '').trim();
    if (!m || !skill) return { refused: 'the message carried no material to answer from' };
    if (!deps.advertised.map((s) => s.toLowerCase()).includes(skill.toLowerCase())) {
      return { refused: `${deps.agentName ?? 'this agent'} does not advertise ${skill}` };
    }
    // A RECORD IS REMEMBERED, NOT ANSWERED. The round is over; there is nothing to advise and nobody
    // reading a sentence about it. The observation folds into the agent's own memory of this skill
    // family — counts, in its vault — and costs no model call. (A person's agent records a hand before
    // the harness runs at all — `runAgentAsk` — so this is the path for any other agent that keeps one.)
    if (/\.record$/i.test(skill)) return recordIntoMemory(deps, skill, m.input);
    const question = String(args.question ?? m.question ?? '').trim();
    // A REVIEW READS HER RECORDS. Without a study grant there are none to read: the person's agent does not
    // review (it consults), and a service without the grant has nothing of hers. Refused, never improvised.
    if (/\.review$/i.test(skill)) {
      if (!deps.study) return { refused: 'a review reads her hand records under her study grant, and none was presented' };
      if (!deps.call) return { refused: 'no model is available to review with' };
      return reviewStudy(deps, skill, question);
    }
    if (!deps.call) return { refused: 'no model is available to answer with' };
    // THE STAGE: hold'em's street from the read; canasta's phase (draw | play) from the seat's view.
    const stageInput = m.input as { read?: { street?: unknown }; view?: { phase?: unknown } } | undefined;
    const street = typeof stageInput?.read?.street === 'string' ? stageInput.read.street : typeof stageInput?.view?.phase === 'string' && familyOf(skill) === 'canasta' ? stageInput.view.phase : null;
    const system = `${answerSystemFor(skill)}\n\n---\n\n${relevantInstructions(deps.instructions, skill, street, 'advise') || '(this agent has no further instructions)'}`;
    // WHAT THIS AGENT REMEMBERS about the players in the material — its own counts from the rounds the
    // asker reported, with the rates worked out. Only the subjects present here; a memory of somebody at
    // another table is not this question.
    const memoryT0 = Date.now();
    // HER STUDY, when this is a coach consulted under her grant; otherwise the agent's own memory.
    const study = deps.study ? await deps.study.load().catch(() => null) : null;
    const memory = !study && deps.memory ? await deps.memory.read(memoryRecordFor(skill)).catch(() => null) : null;
    const remembered = study ? study.remembered : rememberedFor(memory, m.input);
    const memoryMs = Date.now() - memoryT0;
    // THE ASKER'S OWN SHAPE, when it sent one. A card room names its game's exact action union; an answer
    // in any other shape is a move it can only refuse to draw a button for.
    const shape = m.answer && typeof m.answer === 'object'
      ? Object.entries(m.answer).filter(([, v]) => typeof v === 'string').map(([k, v]) => `  ${k}: ${v}`).join('\n')
      : '';
    // THE READ AND THE BASELINE, set apart from the raw material. A card room computes the arithmetic
    // and sends its own rules coach's line; both are worth more to a model than the table they came
    // from, and buried in one JSON blob they were read as just more fields.
    const inp = (m.input && typeof m.input === 'object' ? m.input : {}) as Record<string, unknown>;
    const { read, baseline, observation: _observation, ...rest } = inp;
    const user = [
      `Skill: ${skill}`,
      question ? `Question: ${question}` : 'Question: (nothing specific was asked — say what to do, and why)',
      ...(shape ? [`Answer shape, field by field:\n${shape}`] : []),
      ...(read != null ? [`Read — the facts of the spot, computed (use these numbers):\n${JSON.stringify(read)}`] : []),
      ...(baseline != null ? [`House baseline — a rules coach's line, as an observation:\n${JSON.stringify(baseline)}`] : []),
      ...(study?.profile ? [profileLines(study.profile)] : []),
      ...(study?.lastPlan?.change ? [`The one change your last review set (${study.lastPlan.at.slice(0, 10)}${study.lastPlan.scope ? `, ${study.lastPlan.scope}` : ''}): "${study.lastPlan.change}"${study.lastPlan.leak ? ` — for the leak "${study.lastPlan.leak.pattern}" (${study.lastPlan.leak.count} of ${study.lastPlan.leak.of})` : ''}. When this spot is that spot, say so in one clause.`] : []),
      ...(study?.style.length ? [`Her style — her own rules, which outrank your craft:\n${study.style.map((r) => `- ${r}`).join('\n')}`] : []),
      ...(remembered.length ? [study
        ? `Her records — the counts on the players here, from the ${study.hands} hand${study.hands === 1 ? '' : 's'} she has recorded (rates are computed; small samples mean little):\n${JSON.stringify(remembered)}`
        : `Remembered — your own counts on the players here, from rounds reported to you (rates are computed; small samples mean little):\n${JSON.stringify(remembered)}`] : []),
      ...(study?.reads.length ? [`Her reads — her own notes on players:\n${study.reads.map((r) => `- ${r.about}: ${r.note}`).join('\n')}`] : []),
      ...(study?.notes.length ? [`Your own earlier remarks (opinions from past reviews — NOT a record of her hands; the counts above are the record), oldest first:\n${study.notes.map((n) => `- ${n.at.slice(0, 10)}: ${n.text}`).join('\n')}`] : []),
      `Material: ${JSON.stringify(rest)}`,
    ].join('\n');
    const started = Date.now();
    const out = await deps.call({
      system,
      messages: [{ role: 'user', content: user }],
      tool: {
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
    console.log(`[playbook.answer] ${skill} model ${Date.now() - started}ms · memory ${memoryMs}ms (${remembered.length} remembered) · prompt ${system.length + user.length} chars · answer ${say.length + (because?.length ?? 0)} chars`);
    // NO NOTE MID-HAND. A consultation does not know how the hand ends, and a note written from one reads
    // later as a record of a hand she played: with the field offered "rarely", the model wrote one on every
    // consultation and then counted its own notes as her history ("seventh identical spot — called twice,
    // lost both", over ONE recorded hand; seen live 2026-09-12). Notes are a REVIEW's to write, from hands
    // that have endings (`reviewStudy`).
    const result = { skill, say, ...(because ? { because } : {}), ...(action ? { action } : {}), source: deps.agentName ?? 'this agent', modelMs: Date.now() - started, memoryMs, promptChars: system.length + user.length, ...(remembered.length ? { remembered: remembered.map((r) => `${r.label ?? r.id}:${r.rounds}`) } : {}), ...(study ? { study: { owner: study.owner, hands: study.hands, style: study.style.length, reads: study.reads.length, notes: study.notes.length } } : {}) };
    // `answer` is the rendered reply — the JSON a card room decodes, verbatim. The fields beside it are
    // the same answer as an observation, for the trace.
    return { ...result, answer: JSON.stringify({ say, ...(because ? { because } : {}), ...(action ? { action } : {}) }) };
  };
}

/**
 * A REVIEW OF HER HANDS, from her records, because she asked (`holdem-review`). One model call over the
 * hands in scope; the note it leaves goes into her cabinet so the next consultation starts where this
 * review ended. Never triggered by a hand ending — the table records those without a model.
 */
async function reviewStudy(deps: PlaybookAnswerDeps, skill: string, question: string): Promise<Record<string, unknown>> {
  const source = deps.agentName ?? 'this agent';
  const started = Date.now();
  const study = await deps.study!.load().catch(() => null);
  const recent = study?.recent ?? [];
  if (!study || study.hands === 0 || recent.length === 0) {
    const unit = familyOf(skill) === 'canasta' ? 'rounds' : 'hands';
    const say = study?.days ? `There are no recorded ${unit} in the last ${study.days} day${study.days === 1 ? '' : 's'} — play a session with your agent at the table, or ask the card room to send your past ${unit}, and ask again.` : `There are no recorded ${unit} to review yet — play a session with your agent at the table and ask again.`;
    return { skill, say, source, hands: 0, answer: JSON.stringify({ say }) };
  }
  // The question narrows the span (a day, one hand); otherwise the review is the whole span.
  const named = reviewScopeOf(question, recent);
  const scope = named.label.startsWith('the last ') && study.days ? { hands: recent, label: spanLabel(study.days, recent.length) } : named;
  if (scope.hands.length === 0) {
    const say = `Nothing recorded for ${scope.label.split(',')[0]} — the record holds ${study.hands} hand${study.hands === 1 ? '' : 's'}, the most recent ${recent.length} in full.`;
    return { skill, say, source, hands: 0, answer: JSON.stringify({ say }) };
  }
  // THE HANDS, COMPACT. The view is the game's own; it is passed as it was kept, with the record's own
  // framing (hand number, seat, net) so the model can quote a hand she can find.
  const hands = scope.hands.map(compactHand);
  const system = `${reviewSystemFor(skill)}\n\n---\n\n${relevantInstructions(deps.instructions, skill, null, 'review') || '(this agent has no further instructions)'}`;
  const user = [
    `Skill: ${skill}`,
    `Question, in her words: ${question || 'how have I been playing?'}`,
    `Scope: ${scope.label} of ${study.hands} recorded.`,
    ...(study.profile ? [profileLines(study.profile), ...(study.profile.goals.length ? ['ANSWER THEIR GOALS FIRST: before anything you found on your own, say how the records answer each goal above, with the count.'] : [])] : []),
    ...(study.lastPlan ? [`YOUR LAST REVIEW (${study.lastPlan.at.slice(0, 10)}${study.lastPlan.scope ? `, ${study.lastPlan.scope}` : ''}) set the plan "${study.lastPlan.change ?? '(none)'}"${study.lastPlan.leak ? ` for the leak "${study.lastPlan.leak.pattern}", counted ${study.lastPlan.leak.count} of ${study.lastPlan.leak.of}` : ''}. MEASURE PROGRESS against it from the records in scope — the same pattern, its count now over its sample now — and say improving, same, worse, or too few to say (under ten). Say what went right FIRST when the plan worked.`] : []),
    ...(study.style.length ? [`Her style — her own rules:\n${study.style.map((r) => `- ${r}`).join('\n')}`] : []),
    ...(study.notes.length ? [`Your own earlier remarks (opinions from past reviews — NOT a record of her hands; the hands below are the record), oldest first:\n${study.notes.map((n) => `- ${n.at.slice(0, 10)}: ${n.text}`).join('\n')}`] : []),
    `Counts per player across all ${study.hands} recorded hand${study.hands === 1 ? '' : 's'} (rates computed; "you" is her):\n${JSON.stringify(study.remembered)}`,
    familyOf(skill) === 'canasta'
      ? `The rounds in scope, oldest first (one line each; YOU is the person, "YOUR side" their partnership):\n${hands.map((h) => (typeof h === 'string' ? `- ${h}` : `- ${JSON.stringify(h)}`)).join('\n')}`
      : `The hands in scope, oldest first (one line each: street by street, YOU is her; "timed out" means she was away, not deciding):\n${hands.map((h) => (typeof h === 'string' ? `- ${h}` : `- ${JSON.stringify(h)}`)).join('\n')}`,
  ].join('\n');
  // THE REVIEW IS THE REASONING — no hidden scratchpad here: a review is read slowly, and a model that
  // wrote 120 words of reasoning and then ran out of room for the review itself returned an empty `say`
  // (seen live, 2026-09-12, over 24 hands). Room for paragraphs, and one second try when the first is empty.
  const review = async () => deps.call!({
    system,
    messages: [{ role: 'user', content: user }],
    tool: {
      name: 'review',
      description: 'The review, as a coach talks after the session.',
      input_schema: {
        type: 'object',
        properties: {
          say: { type: 'string', description: 'The review itself, for her to read: what happened with the count (hands, net), the two or three decisions that mattered with the street, the price and what each cost, the leak with its count and cost, what went right. Short paragraphs separated by blank lines. Never empty.' },
          because: { type: 'string', description: 'The one thing to change next session, in one sentence she can do on the first hand.' },
          note: { type: 'string', description: 'Two or three sentences for your own notes: the date, the scope, the leak with its count, the one change. Checkable against the hands.' },
          leak: {
            type: 'object',
            description: 'THE ONE LEAK the plan addresses, as a count: the pattern named so she can recognise it on the next deal, how many times, out of how many chances or units in scope, and what it cost. Omit when the records show none.',
            properties: {
              pattern: { type: 'string', description: 'The mistake, in one clause: "called a raise from the blinds, then folded the flop".' },
              count: { type: 'integer', description: 'How many times, in the records in scope.' },
              of: { type: 'integer', description: 'Out of how many chances or units.' },
              cost: { type: 'integer', description: 'What it cost over the span, in chips or points, computed from the records. Omit rather than estimate.' },
              metric: { type: 'string', description: 'The counter it was read off, when one names it (foldToBet, inHandValue). Optional.' },
            },
            required: ['pattern', 'count', 'of'],
          },
          progress: { type: 'string', description: 'When a last plan was given: improving | same | worse | too-few, followed by the two counts ("8 of 11, then 2 of 9"). Omit when there was no last plan.' },
        },
        required: ['say', 'because', 'note'],
      },
    },
    maxTokens: deps.maxTokens ?? 2500,
  });
  let out = await review();
  let say = typeof out.say === 'string' ? out.say.trim() : '';
  if (!say) {
    console.warn(`[playbook.answer] ${skill} review: the model returned no say (keys ${Object.keys(out).join(',') || 'none'}) · prompt ${system.length + user.length} chars · ${scope.hands.length} hands — asking once more`);
    out = await review();
    say = typeof out.say === 'string' ? out.say.trim() : '';
  }
  if (!say) return { refused: `the review produced nothing over ${scope.label}` };
  const because = typeof out.because === 'string' ? out.because.trim() : undefined;
  const noteText = typeof out.note === 'string' ? out.note.trim() : '';
  // THE LEAK AND THE PLAN, STRUCTURED (cr:Leak, cr:CoachingPlan): kept on the note so the next review measures
  // progress against counts rather than re-reading prose. A leak without a count is not kept as one.
  const rawLeak = out.leak && typeof out.leak === 'object' ? (out.leak as { pattern?: unknown; count?: unknown; of?: unknown; cost?: unknown; metric?: unknown }) : null;
  const leak = rawLeak && typeof rawLeak.pattern === 'string' && rawLeak.pattern.trim() && typeof rawLeak.count === 'number' && typeof rawLeak.of === 'number' && rawLeak.of > 0
    ? { pattern: rawLeak.pattern.trim(), count: Math.round(rawLeak.count), of: Math.round(rawLeak.of), ...(typeof rawLeak.cost === 'number' ? { cost: Math.round(rawLeak.cost) } : {}), ...(typeof rawLeak.metric === 'string' && rawLeak.metric.trim() ? { metric: rawLeak.metric.trim() } : {}) }
    : undefined;
  const progress = typeof out.progress === 'string' && out.progress.trim() ? out.progress.trim() : undefined;
  const noted = noteText && deps.study?.note ? (await deps.study.note(noteText, { scope: scope.label, ...(leak ? { leak } : {}), ...(because ? { change: because } : {}) }).catch(() => ({ ok: false }))).ok : false;
  console.log(`[playbook.answer] ${skill} review ${Date.now() - started}ms · ${scope.label} · prompt ${system.length + user.length} chars · noted=${noted}${leak ? ` · leak ${leak.count}/${leak.of}` : ''}${progress ? ` · progress ${progress.split(' ')[0]}` : ''}`);
  return { skill, say, ...(because ? { because } : {}), ...(leak ? { leak } : {}), ...(progress ? { progress } : {}), source, hands: scope.hands.length, scope: scope.label, noted, modelMs: Date.now() - started, answer: JSON.stringify({ say, ...(because ? { because } : {}), ...(leak ? { leak } : {}), ...(progress ? { progress } : {}) }) };
}

/**
 * A FINISHED ROUND, INTO MEMORY. No model: the observation is counts, and adding counts is arithmetic.
 * The reply is one line for the record; the asker does not wait for it and nobody reads it aloud.
 */
async function recordIntoMemory(deps: PlaybookAnswerDeps, skill: string, input: unknown): Promise<Record<string, unknown>> {
  const family = familyOf(skill);
  const source = deps.agentName ?? 'this agent';
  const obs = observationOf(input);
  const done = (say: string, extra: Record<string, unknown> = {}) => ({ skill, say, source, ...extra, answer: JSON.stringify({ say }) });
  if (!obs) return done('Noted; the round carried nothing to count.');
  if (!deps.memory) return done('Noted; this agent keeps no memory here.', { kept: false });
  const recordType = memoryRecordFor(skill);
  const prev = await deps.memory.read(recordType, true).catch(() => null);
  const next = foldObservation(prev, family, obs);
  const wrote = await deps.memory.write(recordType, next).catch((e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }));
  if (!wrote.ok) {
    console.warn(`[playbook.answer] ${skill} memory not kept: ${wrote.error ?? 'refused'}`);
    return done(`Noted; the memory could not be kept (${wrote.error ?? 'refused'}).`, { kept: false, record: recordType });
  }
  const n = Object.keys(obs.subjects).length;
  console.log(`[playbook.answer] ${skill} remembered round ${next.rounds} · ${n} subjects · ${Object.keys(next.subjects).length} kept`);
  return done(`Remembered round ${next.rounds}: ${n} player${n === 1 ? '' : 's'} counted.`, { kept: true, record: recordType, rounds: next.rounds, subjects: n });
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
export function relevantInstructions(instructions: string | null | undefined, skill: string, street?: string | null, act?: 'advise' | 'review'): string {
  const text = (instructions ?? '').trim();
  if (!text) return '';
  const game = skill.split('.')[0]?.toLowerCase() ?? '';
  const words = game === 'poker' ? /hold.?em|poker/i : game === 'canasta' ? /canasta/i : null;
  if (!words) return text;
  const [opening, ...sections] = text.split(/\n(?=### )/);
  // THE STREET SELECTS THE STAGE. A skill named for a street — holdem-flop, holdem-river — is that
  // street's craft and nobody else's; shown on the turn it is at best noise and at worst a plan for a
  // card that has not come. Sections naming no street (the table read, the person's style) always
  // apply. This is the selective context PokerSkill measured the gain from: the applicable procedure,
  // not the whole essay.
  // Canasta's stages are its two PHASES — the draw decision (draw, or take the pile) and the play (meld, discard).
  // A skill named for one (canasta-draw, canasta-play) is that phase's craft; canasta-endgame applies to both.
  const STREETS = ['preflop', 'flop', 'turn', 'river', 'draw', 'play'];
  const streetOf = (heading: string): string | null => { const m = /hold.?em-(preflop|flop|turn|river)\b/i.exec(heading) ?? /canasta-(draw|play)\b/i.exec(heading); return m ? m[1]!.toLowerCase() : null; };
  // THE ACT SELECTS THE CRAFT, the way the street selects the stage. A coach's playbook carries the review
  // method beside the street stages; mid-hand the review is four thousand characters the model reads and
  // sets aside, and in a review the street stages are the same in reverse. Neither is a loss of skill: the
  // section that applies is the one that stays.
  // Canasta has no streets; its review method (`canasta-review`) is the one section a turn does not need, and
  // a review needs the review method and the partner's craft but not the consult skill's mechanics.
  const notThisAct = act === 'advise' ? /(hold.?em|canasta)-review\b/i : act === 'review' ? /(hold.?em-(preflop|flop|turn|river)|canasta-(draw|play))\b/i : null;
  const kept = sections.filter((sec) => {
    const heading = sec.split('\n')[0] ?? '';
    if (!(words.test(heading) || words.test(sec.slice(0, 400)))) return false;
    if (notThisAct && notThisAct.test(heading)) return false;
    const st = streetOf(heading);
    return !st || !street || !STREETS.includes(street) || st === street;
  });
  // The compiler's "How each act is done" heading precedes the sections; keep it only with sections.
  const head = (opening ?? '').replace(/\n## How each act is done[\s\S]*$/, '').trim();
  return kept.length ? `${head}\n\n## How this is done\n\n${kept.join('\n')}` : head;
}
