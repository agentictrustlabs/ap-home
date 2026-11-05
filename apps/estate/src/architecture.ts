// THE ESTATE'S ARCHITECTURE POSTS. Public, static, written here: `/architecture` lists them, `/architecture/<slug>` is one.
// A FLOW post is a picture of a flow, the flow's steps listed to the right of it, and prose under both. An ARTICLE is prose under
// its picture, with no steps. Choosing a step (in the list or
// on its tile in the picture) opens that step's details in a panel on the right: why the step exists, what happens, where it runs,
// what it reads and leaves, and how it stops. The panel is plain CSS (`:target`), so a post needs no script of its own (the header's `/nav.js` only shows a
// signed-in steward their menu). Everything is
// authored in this file (no value from a request reaches markup); pictures are static assets under `assets/architecture/`.
//
// To add a post: draw its picture (scripts/*-flow.mjs, numbered tiles), add it to `assets/architecture/`, and add an entry to POSTS
// (newest first) with its steps. A step's `at` is the centre of its tile in the picture's own units.
import { shell } from './html.js';

/** One step of a flow. The strings are authored HTML. */
export interface Step {
  id: string;
  name: string;
  /** the tile's colour and centre in the picture */
  color: string;
  at: [number, number];
  /** one line, shown in the list beside the picture */
  summary: string;
  why: string;
  what: string[];
  where: string[];
  /** a model, or code; or, in a flow with no model, who acts */
  by: string;
  reads: string[];
  leaves: string[];
  stops: string[];
}

export interface Post {
  slug: string;
  title: string;
  /** ISO date, shown as written. */
  date: string;
  /** One or two sentences: the listing, the page's standfirst and its link preview. */
  description: string;
  picture: { svg: string; png: string; alt: string; width: number; height: number; caption: string };
  /** A flow post lists its steps beside the picture. An article has none: it is prose under its picture. */
  steps?: Step[];
  /** The heading over each step's `by` line. The harness posts ask "a model, or code"; a flow with no model asks who acts. */
  byHeading?: string;
  body: string;
}

// ───────────────────────────────────────────────────────────────── the agent harness (ap-home apps/agent-runtime)

const HARNESS_ALT =
  'A flow diagram. An ask goes from the asker through Admit, Playbook, Ground, Judge, Plan and Check the plan. Then, for every step, ' +
  'Authority, Execute and Receipt, and the Answer returns to the asker. Skills enter from the top: a SKILL.md is published to the skills ' +
  'registry, compiled with the domain ontology into an archetype, and assigned to the agent as its playbook. The judge reads each ' +
  "skill's card. The skill's body is read by its pinned digest when the step runs.";

const RUNTIME = 'The agent runtime, one Cloudflare Worker (<code>demo-a2a-faithnet</code>) that serves every agent of the estate at its own host under <code>faithnet.io</code>.';

const HARNESS_STEPS: Step[] = [
  {
    id: 'admit', name: 'Admit', color: '#8b5cf6', at: [186, 470],
    summary: 'Who is asking is settled before anything else.',
    why: 'Everything after this depends on who asked: what the agent may read for them, whose mandate can authorize a step, and whose budget pays. So the question is closed first, in code, before any model sees the request.',
    what: [
      'There are three ways in. A person signed in at their Home, whose session is verified. An app holding a wire that person signed, sent in the <code>A2A-Session</code> header. Another agent sending an A2A message to <code>/api/a2a</code>.',
      "The agent's budget is checked here too. An agent that has spent its budget replies with a refusal, not a partial run.",
    ],
    where: [RUNTIME, 'Source: <code>apps/agent-runtime/src/index.ts</code> (<code>POST /harness/ask</code>), with the Home session check in <code>custody-oidc.ts</code>.'],
    by: 'Code only. No model is called.',
    reads: ["The Home session, checked against the Home's published keys.", 'The signed wire and its delegation.', "The agent's budget."],
    leaves: ['The asker on the run: who they are and which way they came in.'],
    stops: ['<code>401</code> when the caller cannot be verified.', '<code>403</code> when the run belongs to someone else.', '<code>429</code> when the budget is spent, returned as a refused reply.'],
  },
  {
    id: 'playbook', name: 'Playbook', color: '#3b82f6', at: [300, 470],
    summary: "The agent's assigned skills, checked against their digest.",
    why: 'An agent should answer with the skills its custodian chose, in exactly those words. Pinning the playbook by digest means that neither the registry nor a deploy can change what the agent knows how to do. Only a new assignment can.',
    what: [
      "The playbook is the archetype the agent's custodian assigned. The harness reads the assignment from the agent's vault and recomputes the playbook's digest.",
      'If the digest does not match, or there is no assignment, the agent runs with no playbook at all. It never runs with a changed one.',
    ],
    where: [RUNTIME, 'Source: <code>harness-run.ts</code> (<code>loadPlaybook</code>), with the digest check in <code>@agenticprimitives/harness</code>.', "The assignment is a record in the agent's vault, which is kept by the vault Worker (<code>demo-mcp-faithnet</code>)."],
    by: 'Code only.',
    reads: ["The <code>archetype.assignment</code> record in the agent's vault.", "The estate's adopted ontology manifest digest."],
    leaves: ["The playbook's digest on the run, so every receipt can name the exact playbook it ran under."],
    stops: ['It does not stop the run. A missing or mismatched playbook means the agent answers with its plain tools and no skills.'],
  },
  {
    id: 'ground', name: 'Ground', color: '#14b8a6', at: [414, 470],
    summary: "Code reads the request against the domain's own terms.",
    why: "Models are good with language and unreliable about the facts of this estate. Reading the request against the domain's terms first gives the later steps typed facts in place of guesses. It also lets a common request skip the models entirely: cheaper, faster, and the same every time.",
    what: [
      'Code works out which things the request names and how the asker stands to the agent: themselves, a steward, a member, a stranger.',
      'A common request, such as reading a balance or a list of members, matches a known shape and is planned right here, with no model.',
      'On faithnet the reading also carries what the asker has been doing lately: the tools they used in the last 30 days.',
    ],
    where: [RUNTIME, 'Source: <code>harness-run.ts</code> (<code>classifyOpenIntent</code> and the compiled shapes), with the typed reading in <code>@agenticprimitives/orchestration</code>.'],
    by: 'Code only.',
    reads: ["The playbook's domain lexicon and outcome classes.", "The operations index (the D1 database <code>OPS</code>) for the asker's recent tools."],
    leaves: ['A typed reading on the run.', 'For a known shape, a finished plan marked <code>compiled</code>.'],
    stops: ['It does not stop the run. A request that matches no shape goes on to the judge.'],
  },
  {
    id: 'judge', name: 'Judge', color: '#ef4444', at: [528, 470],
    summary: 'Which one skill should handle this, or none of them?',
    why: 'A planner that is offered every tool tends to pick a plausible one. Asking a narrower question, and accepting the answer by a declared rule, makes the choice measurable: the same floor and margin every time, with the probabilities on record. It also makes "none of these" a proper answer.',
    what: [
      'One call to a small model. It sees only the card of each offered skill (one line of purpose, what it produces, what it is not for) and answers with a probability for each skill and for "none".',
      'A rule in code then decides. The top skill is accepted only if it reaches the floor (0.5) and leads the next one by the margin (0.15).',
      'Anything else is a hold, with a reason on record: <code>none-fits</code>, <code>below-floor</code>, <code>no-margin</code>, <code>judge-error</code>. On a hold the skills are taken out of reach and the ask goes to the planner.',
    ],
    where: [RUNTIME, 'Source: <code>harness-run.ts</code>, calling <code>selectByJudgment</code> from <code>@agenticprimitives/orchestration</code>.', "The model call goes through the estate's inference gateway (<code>inference.faithnet.io</code>) under the profile <code>selection-structured</code>."],
    by: 'One small model call, then a rule in code. The model gives probabilities and nothing else.',
    reads: ["Each skill's card, from the playbook.", 'The typed reading from Ground.'],
    leaves: ['<code>trace.selection</code>: every probability, and the choice or the reason for holding.', '<code>trace.skillStage</code>: whether it chose, or handed the ask to the planner.'],
    stops: ['It never stops the run. A hold only changes who plans.', 'The stage is on when <code>SKILL_SELECTION_DEFAULT</code> is <code>selective</code>, as it is on faithnet.'],
  },
  {
    id: 'plan', name: 'Plan', color: '#f59e0b', at: [642, 470],
    summary: 'The plan is built around the chosen skill.',
    why: "An ask can need more than one step, and their order matters. Writing the whole plan down before anything runs means it can be checked as a whole. Building it around the judge's pick keeps a planner from quietly overruling that choice.",
    what: [
      'With a chosen skill, the plan is that skill alone, or that skill together with the skill that produces what it needs.',
      "With no chosen skill, a planner model plans over the agent's other tools. The skills are not offered to it.",
      'If no model is available at all, a rule-based planner is used.',
    ],
    where: [RUNTIME, 'Source: <code>harness-run.ts</code> (<code>choosePlanAround</code>, <code>selectPlanner</code>).', 'The planner model is called through the inference gateway under the profile <code>planner-fast</code>.'],
    by: 'Code when a skill was chosen. One planner model call when none was.',
    reads: ['What each skill produces and consumes, from the domain ontology in the playbook.', "The agent's other tools."],
    leaves: ['<code>trace.plan</code>: the steps, in order.', 'Which planner wrote it, and a digest of the prompt it was given.'],
    stops: ['It does not stop the run. The plan goes to the check.'],
  },
  {
    id: 'check', name: 'Check the plan', color: '#eab308', at: [756, 470],
    summary: 'Fixed rules, no model, before anything runs.',
    why: 'A plan from a model is a proposal. Fixed rules look for the mistakes models make: a number the person never said, a party they never named, a step that depends on nothing, an outcome the request does not ask for. Catching these before a step runs is cheaper and safer than catching them after.',
    what: [
      'Each rule names what happens when it fails: carry on, plan again, ask the person, or refuse.',
      'The planner gets one more try. After that a failing plan is refused, and the reply says which rule refused it.',
    ],
    where: [RUNTIME, 'Source: <code>harness-run.ts</code> (<code>planAdmission</code>), with the rules in <code>@agenticprimitives/orchestration</code>.'],
    by: 'Code only.',
    reads: ['The plan.', 'The typed reading and what the person actually said.'],
    leaves: ['The rules that fired, by code: for example <code>UNSUPPORTED_BINDING_SOURCE</code>, <code>DEPENDENCY_NOT_SATISFIED</code>, <code>OUTCOME_NOT_ENTAILED</code>, <code>REQUIRED_ROLE_UNRESOLVED</code>.'],
    stops: ['Refused: the reply is <code>refused</code>, with <code>plan_refused</code> and the rule.', 'Asked: the person gets a question, and the run waits for the answer.'],
  },
  {
    id: 'authority', name: 'Authority', color: '#22c55e', at: [900, 470],
    summary: 'Every step that acts needs a mandate the person signed.',
    why: 'Choosing and planning grant nothing. An agent acts for a person only where that person has said so, in a signed mandate that states its limits. Checking each step, and not the run as a whole, means a long plan cannot carry an unauthorized act in behind authorized ones.',
    what: [
      'A mandate is a delegation the person signed. The harness verifies it for the step in hand, including the limits it carries, such as the exact act and the value.',
      'With no mandate, the run stops and says exactly what it needs. The person signs at their Home, and the same run resumes where it stopped.',
    ],
    where: [RUNTIME, 'Source: <code>harness-run.ts</code>, with the verifier and the risk policy in <code>@agenticprimitives/harness</code>.', "Signing happens at the person's Home. The delegation manager and its enforcers are contracts on the estate's chain."],
    by: 'Code only.',
    reads: ["The person's signed delegations.", 'The delegation manager and enforcer contracts.'],
    leaves: ["The mandate each step ran under, on that step's receipt."],
    stops: ['<code>authority_required</code>: the run pauses and names what to sign.', '<code>denied</code>: the mandate does not allow this step.'],
  },
  {
    id: 'execute', name: 'Execute', color: '#0ea5e9', at: [1016, 470],
    summary: 'Check it has not already happened, then run it once.',
    why: 'This is the only step with effects in the world, so it carries two protections. First it checks whether this exact act already happened, as it may have on a retry or a resumed run. Then it runs it once. A payment sent twice is worse than a slow answer.',
    what: [
      'A step can be a skill, an act (a payment, a message, an invitation), a connector (calendar, mail, GitHub, an MCP server), or a question to another agent.',
      "For a skill, the harness reads the skill's body from the skills registry and compares it with the digest the playbook pinned. If the registry's copy has moved, the step is refused. Otherwise one model call writes the answer under the skill's own words.",
    ],
    where: [RUNTIME, 'Source: <code>harness-run.ts</code> (the reconcile port and the invokers) and <code>skill-apply.ts</code>.', 'The skill body comes from the skills registry Worker (<code>skills-mcp</code>), reached over a service binding and never over the public internet.'],
    by: 'Code for an act or a connector. One model call for each skill step, through the inference gateway.',
    reads: ["The skill's body, by its pinned digest.", 'The results of the steps before it.'],
    leaves: ["The step's result and what was observed."],
    stops: ['A skill whose body has moved is refused: "the playbook pins one digest, the registry serves another".', 'An act found already done is not run again.'],
  },
  {
    id: 'receipt', name: 'Receipt', color: '#6366f1', at: [1132, 470],
    summary: 'Every step leaves a record of what ran and under what.',
    why: "Without a record, \"the agent did it\" is only a claim. A receipt turns it into evidence: which skill and version, which mandate, what was observed. It is kept in the agent's own vault, where its custodian can read it, and not only in a service's logs.",
    what: [
      "Each step writes a receipt with its status: executed, failed, denied, suspended or waiting for authority. A skill step names the archetype, its version and the playbook's digest.",
      "The run's record is kept at the agent for about a week. Its provenance is written to the agent's vault after the reply has gone, so the asker does not wait for it.",
    ],
    where: [RUNTIME, 'Source: <code>harness-run.ts</code> (the receipt sink), <code>index.ts</code> (the run record) and <code>run-export.ts</code> (provenance).', "The run record lives in the agent's own Durable Object and is indexed in the D1 database <code>OPS</code>. The vault is kept by the vault Worker (<code>demo-mcp-faithnet</code>)."],
    by: 'Code only.',
    reads: ["Each step's outcome."],
    leaves: ['An audit entry for each step, <code>harness.step.&lt;status&gt;</code>.', "The vault record <code>run.provenance:&lt;run&gt;</code>."],
    stops: ['It does not stop the run.'],
  },
  {
    id: 'answer', name: 'Answer', color: '#3b82f6', at: [1262, 470],
    summary: 'As the skill wrote it, or composed and checked.',
    why: 'The last step is where a model could undo every check before it, by saying something the steps never established. So a skill\'s answer passes through as written, and any other answer is checked against the steps\' results before it is sent.',
    what: [
      "A skill's answer is given as the skill wrote it. No second model rewrites it.",
      "Any other answer is composed by a model from the steps' results, then checked against them in code. If the check fails, it is composed once more. If that fails too, the reply is built directly from the results.",
    ],
    where: [RUNTIME, 'Source: <code>harness-run.ts</code> (<code>askReplyFor</code>, <code>checkGroundedComposition</code>).', 'The composer is called through the inference gateway under the profile <code>composer-default</code>.'],
    by: 'No model for a skill\'s answer. Otherwise one composer call, with one retry, and a check in code.',
    reads: ["The steps' results."],
    leaves: ['The reply, as one of: <code>answer</code>, <code>prompt</code>, <code>authority_required</code>, <code>waiting</code>, <code>done</code>, <code>refused</code>.'],
    stops: ['A composed answer that cannot be grounded is replaced by one built from the results.'],
  },
];

const HARNESS_BODY = `
<h2>Where skills come in</h2>
<p>A skill is a document, a <code>SKILL.md</code>: what it does, when to use it, and how. It reaches an agent in four moves, the pink path in the picture.</p>
<ul>
<li><b>Published.</b> The author publishes the skill to the skills registry, which records a commitment to its exact content.</li>
<li><b>Described.</b> The domain's ontology says what each skill covers, what it produces and what it consumes. That is how one skill is told from its neighbour, and how a plan knows which skill feeds another.</li>
<li><b>Compiled.</b> An archetype gathers a set of skills into one definition, a tool for each skill, under one digest.</li>
<li><b>Assigned.</b> The agent's custodian assigns that archetype to the agent. From then on it is the agent's playbook.</li>
</ul>
<p>The harness uses a skill twice, and reads a different part each time.</p>
<ul>
<li><b>To choose.</b> The judge sees only each skill's card: one line of purpose, what it produces, and what it is not for.</li>
<li><b>To answer.</b> The skill's full body is read only when its step runs, by the digest the playbook pinned. If the registry's copy has moved since, the step is refused, never run under different words.</li>
</ul>

<h2>Three rules that hold it together</h2>
<ul>
<li><b>Intelligence may be probabilistic. Authority must not be.</b> The planner proposes, the mandate authorizes, the executor acts, the receipt proves.</li>
<li><b>The ontology proposes, a judge decides, a declared rule accepts.</b> Choosing a skill never permits anything. The chosen step still meets every gate after it.</li>
<li><b>An archetype changes what an agent knows how to do, never what it may do.</b></li>
</ul>
<p>The Scripture Agent answers through a harness of its own, shaped for an agent that only reads: <a href="/architecture/scripture-ask">How the Scripture Agent answers a question</a>.</p>`;

// ───────────────────────────────────────────────────────────────── the Scripture Agent (verifiable-content-demo apps/demo-bible-a2a)

const SCRIPTURE_ALT =
  'A flow diagram. A question goes from the reader through Admit and Route. A judge chooses an answer plan, or none, while the agent ' +
  'gathers what it holds, and the plan gates what the writer sees. Then a model drafts, code proves every quoted verse against the signed ' +
  'corpus, and the draft is revised once if a check failed. The answer is enriched with what the sources say at the cited verses and ' +
  'returned to the reader with a receipt. Skills enter from the top: a SKILL.md is published to the skills registry and read when the ' +
  "question arrives. The judge reads each plan's card, the gate applies the plan's writings policy, and the writer reads the plan's body.";

const SCRIPTURE = 'The Scripture Agent, one Cloudflare Worker (<code>demo-bible-a2a-faithnet</code>) at <code>scripture.faithnet.io</code>.';
const LIBRARY = "The library Worker (<code>demo-bible-mcp-faithnet</code>), reached over a service binding. It keeps the verses, the writings and the original-language texts in D1 databases, with vector indexes for search by meaning.";

const SCRIPTURE_STEPS: Step[] = [
  {
    id: 'admit', name: 'Admit', color: '#8b5cf6', at: [188, 470],
    summary: 'A question arrives, and the asker is known as little as possible.',
    why: 'This agent answers anyone, so admission here is not about keeping people out. It settles how the asker is known, which is as little as possible, and it bounds the request before any model sees it.',
    what: [
      'A question arrives in one of two ways: as an A2A message to <code>/api/a2a</code>, plain or streaming, or as a direct <code>POST /ask</code> with the question, what the reader has open, and the edition they read.',
      "Asking is open. The agent's card declares a pairwise asker: a stable pseudonym derived for this agent alone, with no credential behind it. An app can also send a wire the reader signed for this agent, which is checked by its signature and for revocation.",
      'Asking is never paid for. Payment applies only to reading the text of a licensed edition.',
    ],
    where: [SCRIPTURE, 'Source: <code>src/index.ts</code> (the routes), <code>src/host.ts</code> (admission) and <code>src/a2a/standard.ts</code>.'],
    by: 'Code only. No model is called.',
    reads: ['The message and its context.', 'A signed wire, when one is sent.'],
    leaves: ['The asker on the run, as a pseudonym or a verified wire.', 'The question, cut to 1,000 characters.'],
    stops: ['A wire that does not verify, or was revoked, is not admitted.', 'With no writer model configured, the agent says so and does not answer.'],
  },
  {
    id: 'route', name: 'Route', color: '#3b82f6', at: [304, 470],
    summary: 'A verse open in front of the reader, or any question.',
    why: 'A reader looking at one verse wants a short note on that verse, in seconds. An open question needs the full run. Deciding by what the reader has open, in code, spends no model call on guessing which they meant.',
    what: [
      'If the request carries a verse (one verse, or up to five in a row from one chapter) it goes to the verse companion: one streamed call over that verse\'s dossier, written under the <code>verse-companion</code> skill from the registry.',
      'Everything else takes the path in this picture. The agent\'s host plans it as a single step, <code>writings.run</code>, and the rest of the flow happens inside that step.',
      'A mode the agent no longer offers is refused. There is no fallback to another path.',
    ],
    where: [SCRIPTURE, 'Source: <code>src/ask-route.ts</code> (<code>routeAsk</code>), <code>src/ask-verse.ts</code> (the verse companion) and <code>src/host.ts</code> (the single-step plan).'],
    by: 'Code only.',
    reads: ["The request's context: the verse or verses the reader has open."],
    leaves: ['The route taken: <code>verse</code> or <code>writings</code>.'],
    stops: ['An unknown or retired mode is refused.', 'A verse ask with no verse is refused.'],
  },
  {
    id: 'choose', name: 'Choose a plan', color: '#ef4444', at: [420, 470],
    summary: 'A judge picks one answer plan, or none.',
    why: 'One way of answering does not suit every question. Asked "Who was Charles Stanley?", search by meaning handed the writer commentaries that were about other things, and the writer narrated them. A plan lets the kind of question change what the writer is given and told. A judge with a declared rule keeps that choice measurable, and most questions get no plan and run as they always did.',
    what: [
      'The agent reads its answer plans from the skills registry when the question arrives. A plan is admitted only if Scripture\'s organization owns it, it is the newest published version, and its content matches its commitment. A refused plan is listed with the reason.',
      'One call to a small model sees each plan\'s card and gives a probability for each plan and for "none". A rule in code accepts the top plan only at 0.6 or more, with a lead of 0.2 over the next. That is stricter than the agent harness, which uses 0.5 and 0.15.',
      'The judge runs beside the search, so it adds no waiting. A hold changes nothing. A bounded factual lookup skips the judge.',
    ],
    where: [SCRIPTURE, 'Source: <code>src/harness/answer-plan.ts</code> (<code>selectAnswerPlan</code>) and <code>src/scripture-skills.ts</code> (the registry reader). The judge is <code>selectByJudgment</code> from <code>@agenticprimitives/orchestration</code>, the same one the agent harness uses.', 'The plans come from the skills registry Worker (<code>skills-mcp</code>), over a service binding. The agent remembers them for one minute.'],
    by: 'One small model call (Claude Haiku 5.5 by default), then a rule in code. About $0.00015 and 0.7 seconds a question.',
    reads: ['The plans named <code>skill:scripture/plan-*</code> in the registry.', 'The question.'],
    leaves: ['<code>skillSelection</code> on the receipt: the plans offered, every probability, the choice or the reason for holding, and the chosen plan\'s id, version and commitment.', 'When the registry was read, and whether that reading was stale.'],
    stops: ['It never stops the run. Holds are <code>none-fits</code>, <code>below-floor</code>, <code>no-margin</code>, <code>no-plans</code>, <code>registry-unavailable</code> and <code>judge-error</code>, and each means "answer as before".'],
  },
  {
    id: 'gather', name: 'Gather', color: '#14b8a6', at: [536, 470],
    summary: 'What the agent holds: at the verses, by meaning, in the original.',
    why: 'The agent answers from what it holds, not from what a model remembers. Starting at the verses in the question finds the notes written about those exact verses. Search by meaning covers the question that names no verse.',
    what: [
      'First, what is held at the verses the question names: study notes and writings, including writings in the original Greek, Latin and Hebrew.',
      'Then search by meaning: the sixteen nearest passages of the writings and the six nearest verses.',
      'Then the original words behind the verses: form, transliteration, gloss and grammar, where the library has them.',
      'A run may make at most 160 requests to the library.',
    ],
    where: [SCRIPTURE, 'Source: <code>src/harness/draft-prove.ts</code> and <code>src/harness/enrich.ts</code>.', LIBRARY],
    by: 'Code. The search by meaning uses vector indexes over the writings and the verses.',
    reads: ['The library tools <code>notes_at</code>, <code>writings_at</code>, <code>writings_retrieve</code> and <code>verses_retrieve</code>.'],
    leaves: ['Every call to the library, in <code>retrieval</code> on the receipt.'],
    stops: ['A failed call is retried.', 'Past the limit of 160, a call is refused, and the refusal is recorded with the other calls.'],
  },
  {
    id: 'gate', name: 'Gate', color: '#eab308', at: [652, 470],
    summary: "The plan's policy decides which writings reach the writer.",
    why: 'Search by meaning returns what is near, and near is not always about the subject. The plan states as policy which writings may reach the writer, and code enforces it, so the rule does not depend on a model obeying an instruction.',
    what: [
      'A plan carries one of three policies. <code>open</code>: the writings as gathered. <code>subject-named</code>: only a writing that names the whole subject of the question. <code>closed</code>: no writings.',
      'Scripture is never filtered. A translation may name the subject differently, so a verse is not dropped for its wording.',
      'With no plan chosen, nothing is gated.',
    ],
    where: [SCRIPTURE, 'Source: <code>src/harness/answer-plan.ts</code> (<code>planWritingsGate</code>), applied in <code>draft-prove.ts</code> to everything gathered, before the draft and again before the additions.'],
    by: 'Code only.',
    reads: ["The chosen plan's writings policy.", 'What was gathered.'],
    leaves: ['<code>skillSelection.gate</code>: the policy, the subject it looked for, and each writing kept or dropped.'],
    stops: ['It does not stop the run. If no subject can be found under <code>subject-named</code>, every writing is dropped and the writer answers without them.'],
  },
  {
    id: 'draft', name: 'Draft', color: '#f59e0b', at: [790, 470],
    summary: 'A model writes the answer, and says what it relies on.',
    why: 'Writing a clear answer from many sources is what a model is good at. This is the one step where a model has freedom, and it sits between a gate before it and a proof after it.',
    what: [
      'One call. The writer must return a structured draft: the answer, and with it the verses and quotations the answer relies on.',
      "Its rules: answer first; say only what the sources support; answer well-documented history from general knowledge, without invented quotations; make no grammar claim the supplied parsing does not support. A chosen plan's body is added to these rules.",
    ],
    where: [SCRIPTURE, 'Source: <code>src/harness/draft-prove.ts</code>.', "The writer is Claude Haiku 5.5 by default, called from the agent's Worker."],
    by: 'One model call.',
    reads: ['The gated sources.', "The writer's rules, the guidance for this kind of question, and the plan's body."],
    leaves: ['The draft and its stated verses and quotations.', 'The writer model, in the run\'s versions.'],
    stops: ['A draft that runs out of room is an error. A cut-off answer is never sent.'],
  },
  {
    id: 'prove', name: 'Prove', color: '#22c55e', at: [906, 470],
    summary: 'Code checks every verse and quotation against the signed corpus.',
    why: "A reader should never have to trust that a quotation is real. Every verse is fetched from the edition's own signed text and compared. The model's memory of a verse is never what the reader is shown.",
    what: [
      "For each verse the draft cites, code resolves the reference, fetches the text in the reader's chosen edition, checks that text against the publisher's commitment, and has the citation signed.",
      'A named edition is never swapped for another.',
      "A quotation that nearly matches is replaced with the edition's own wording, or its quotation marks are removed. A reference that does not resolve, or a text that does not verify, is a problem for the next step.",
    ],
    where: [SCRIPTURE, 'Source: <code>src/harness/draft-prove.ts</code> (<code>proveScripture</code>) and <code>src/index.ts</code> (<code>doResolve</code>).', 'The library Worker resolves, serves and signs. The agent signs as its Smart Agent through a delegate key held in the key service, never in a Worker. A verifier roots its trust in the Smart Agent, not in the key.'],
    by: 'Code only.',
    reads: ['The library tools <code>resolve</code>, <code>get_passage_text</code> and <code>sign_content_credential</code>.', "The publisher's commitment for the edition."],
    leaves: ['<code>citations</code>, <code>proof</code> and <code>verification</code> on the receipt.', 'A citation that could not be signed is marked <code>unsigned</code>, never passed off as signed.'],
    stops: ['Problems are named: <code>not-held</code>, <code>fetch-failed</code>, <code>verification-failed</code>, a quotation that does not match.'],
  },
  {
    id: 'revise', name: 'Revise', color: '#0ea5e9', at: [1022, 470],
    summary: 'Once, and only if a check failed.',
    why: 'A failed check should improve the answer, not just mark it. One round is enough to fix a misquoted verse. More rounds cost time and tend to wander from the question.',
    what: [
      'If the proof found problems, the writer is given them, together with the true text of the verses, and writes once more.',
      "A chosen plan adds its own checks here: a year stated when no writing named the subject, or an answer that talks about \"the material supplied\" in place of answering.",
      'The revision is proved again. It is kept only if it has no more problems than the draft had.',
    ],
    where: [SCRIPTURE, 'Source: <code>src/harness/draft-prove.ts</code>, with the plan\'s checks in <code>answer-plan.ts</code> (<code>planAnswerProblems</code>).'],
    by: 'One model call, only when needed. The decision to keep the revision is code.',
    reads: ['The list of problems.', "The cited verses' own text."],
    leaves: ['<code>revised</code>: the problems before and after, and whether the revision was kept.'],
    stops: ['There is one round. What still fails is stated on the receipt, under <code>verification</code>.'],
  },
  {
    id: 'enrich', name: 'Enrich', color: '#a855f7', at: [1150, 470],
    summary: 'What the sources say at the verses the answer cites.',
    why: 'Once the answer\'s verses are known and proved, the agent can look up exactly what its sources say at those verses. That is more precise than any search made before the draft. Adding afterwards, as attributed sentences, leaves the proved answer as it was.',
    what: [
      'The agent gathers again, at the proved verses, and passes what it finds through the same gate.',
      'One model call proposes additions: up to three attributed sentences, and up to three places where the sources disagree. The additions are proved, and kept only if they add no new problem.',
      'The original words behind every cited verse are attached, with their forms and glosses.',
      'A plain factual lookup, or an answer that cites no verse, skips this step.',
    ],
    where: [SCRIPTURE, 'Source: <code>src/harness/draft-prove.ts</code> and <code>src/harness/enrich.ts</code>.', LIBRARY],
    by: 'One model call, then the same proof in code.',
    reads: ['Notes and writings at the cited verses.', 'The original-language text of those verses.'],
    leaves: ['<code>enriched</code>: what was asked, admitted, held back and added.', '<code>originalLanguage</code>: the original words shown, and where they came from.'],
    stops: ['Additions that bring a new problem are dropped, and the proved answer goes out without them.'],
  },
  {
    id: 'receipt', name: 'Receipt', color: '#6366f1', at: [1264, 470],
    summary: 'What it read, what it checked, and what it ran under.',
    why: 'An answer about Scripture should be checkable by someone who does not trust the agent. The receipt says what was read, what was checked, and under which skills and versions, so the run can be audited and repeated.',
    what: [
      'Every answer carries a run manifest (<code>ask-run/2</code>): the run\'s id, the edition, the configuration and its hash, and the versions of the code, the policy and the writer. The question is recorded as a hash.',
      'With it come the signed citations, the proof, the plan selection and its gate, what was revised and added, the cost, and the time each stage took.',
      "The run is kept at the agent, and its provenance is written to the agent's vault. Anyone can check a citation at <code>/verify</code>.",
    ],
    where: [SCRIPTURE, 'Source: <code>src/harness/pipeline.ts</code> (the manifest), <code>src/host.ts</code> and <code>src/index.ts</code>.', "The run record lives in the agent's Durable Object (<code>RUNS</code>). The provenance record, <code>run.provenance:&lt;run&gt;</code>, goes to the agent's vault."],
    by: 'Code only.',
    reads: ['Every stage of the run.'],
    leaves: ['The reply: the answer, its citations and its receipt.', 'The run record and its provenance.'],
    stops: ['If the vault cannot be written, the run\'s export says so. The answer is still returned.'],
  },
];

const SCRIPTURE_BODY = `
<h2>Where skills come in</h2>
<p>The Scripture Agent's skills are documents in the skills registry, under the <code>scripture</code> domain. Nothing is compiled into the agent: it reads them when a question arrives, so a newly published version reaches readers within a minute, with no deploy.</p>
<p>A skill is admitted only if all three of these hold. A skill that fails one is refused, and listed with the reason.</p>
<ul>
<li><b>Owned.</b> It belongs to Scripture's own organization. Anyone can publish a skill under a similar name, and it changes nothing.</li>
<li><b>Published.</b> It is the newest published version. A draft never reaches a reader.</li>
<li><b>As committed.</b> Its content hashes to the commitment the registry recorded.</li>
</ul>
<p>An answer plan is used three times in one run, and a different part is read each time. These are the three pink arrows in the picture.</p>
<ul>
<li><b>Its card, to choose.</b> The judge sees a line of purpose, what the plan covers and what it leaves to others.</li>
<li><b>Its policy, to gate.</b> Code reads one field: which writings may reach the writer.</li>
<li><b>Its body, to write.</b> The writer reads the plan's instructions alongside its own rules.</li>
</ul>

<h2>The categories of skills that drive it</h2>
<p>As of 5 November 2026, two kinds of skill shape live answers: the method for a verse, and one answer plan. The rest of the table is built and in testing. It is not live and not yet in the registry. It moves the judge to the front of the flow, so that what the reader is asking decides what is gathered and how the answer is written.</p>
<figure class="picture"><a href="/architecture/scripture-intent-flow.svg"><img src="/architecture/scripture-intent-flow.svg" width="1460" height="990" alt="The Scripture ask as it is being built. A question goes through admission to a judge, which picks one of twelve intents or holds. An intent names a scope, which drives planning, gathering and the gate, and a form, which drives the draft. The reader's stated context adds a standpoint and a reader skill to the draft by rule; a people-group skill is reserved and not built. A model drafts, code proves every verse, and the answer returns with a receipt. Skills come from the registry through a pinned playbook."></a>
<figcaption>The design in testing. It is not what answers readers today; the picture at the top of this page is. Pink arrows are skills. Dashed pink arrows show which stages each skill drives.</figcaption></figure>
<div class="table-wrap"><table class="skills-table">
<thead><tr><th>Category</th><th>What it decides</th><th>Chosen by</th><th>Drives</th><th>How many</th><th>State</th></tr></thead>
<tbody>
<tr><td><b>Ask skill</b></td><td>The method for one kind of question</td><td>A rule: a verse is open</td><td>The verse companion</td><td>9; only the verse skill drives live answers</td><td>Live</td></tr>
<tr><td><b>Answer plan</b></td><td>Which writings the writer may see, and how to answer</td><td>The judge</td><td>Gate, Draft</td><td>1: a person, body or event after the Bible</td><td>Live</td></tr>
<tr><td><b>Intent</b></td><td>What the reader is asking for. This is the card the judge reads, and it names one scope and one form</td><td>The judge</td><td>Selects the scope and the form</td><td>12</td><td>In testing</td></tr>
<tr><td><b>Scope</b></td><td>What the question is about, so what is gathered and what the writer may rely on</td><td>The intent, with the rule applied to the scope</td><td>Gather, Gate, Draft</td><td>7: a verse or passage, a book, a subject in the Bible, a word, a topic, outside the Bible, this agent</td><td>In testing</td></tr>
<tr><td><b>Form</b></td><td>The shape of the answer</td><td>The intent, or the scope's default when no form clearly leads</td><td>Draft, answer checks</td><td>10: exposition, survey, profile, definition, teaching, counsel, reasoned case, verse list, describe and weigh, agent record</td><td>In testing</td></tr>
<tr><td><b>Reader</b></td><td>How the answer is told. It changes the telling, never the teaching</td><td>A rule, from what the reader's context states</td><td>Draft</td><td>11: eight faith-journey roles and three age bands</td><td>In testing</td></tr>
<tr><td><b>Standpoint</b></td><td>Whose reading leads, when the reader states a tradition</td><td>A rule, and only for a tradition whose standards the library holds</td><td>Draft</td><td>2: Reformed, Reformed Baptist</td><td>In testing</td></tr>
<tr><td><b>People group</b></td><td>The people the reader belongs to or serves</td><td>A rule, from a stable id and never a bare name</td><td>To be decided</td><td>None</td><td>Reserved, not built</td></tr>
</tbody></table></div>
<p>Four things hold across these categories:</p>
<ul>
<li><b>They compose.</b> One question gets one scope and one form, and the reader's context may add a reader and a standpoint. About forty documents cover the range, with no skill per subject or per doctrine.</li>
<li><b>Scripture comes first.</b> Five scopes are about the Bible itself, and they are built first. The other two take questions from around it and bring them back to Scripture, with no new source or stage.</li>
<li><b>Context is stated, never guessed.</b> Nothing about the reader is inferred from how a question is worded, and a tradition the library holds no standards for is not presented as served.</li>
<li><b>Each one earns its place.</b> A category in testing changes answers only after it beats today's answer in blind comparison by two model families, and then only at the exact version pinned. Until then its choice is only recorded, and a question the judge is unsure of runs today's path.</li>
</ul>
<p>No skill in any category can switch off the proof or change the edition.</p>

<h2>Three rules that hold it together</h2>
<ul>
<li><b>The model drafts. Code proves.</b> A model chooses words. It never decides what a verse says.</li>
<li><b>A plan can only narrow.</b> A plan can withhold writings and add instructions and checks. It cannot switch off the proof, change the edition, or add a source.</li>
<li><b>Nothing is hidden in the answer.</b> What was read, dropped, revised and added is on the receipt, with the plan and version it ran under.</li>
</ul>

<h2>How this differs from the agent harness</h2>
<p>Every other agent in this estate answers through <a href="/architecture/agent-harness">the agent harness</a>. The Scripture Agent uses the same judge and the same kind of skill, in a different shape.</p>
<ul>
<li><b>It only reads.</b> It makes no payment and sends no message, so there is no mandate to check at each step. Proof takes the place that authority has in the agent harness.</li>
<li><b>Its plan is one step.</b> The host plans a single step and the flow in this picture runs inside it. The judge chooses how that step answers, not which step to run.</li>
<li><b>It reads the newest published skill.</b> The agent harness pins a skill by digest through a playbook its custodian assigned. Here the owner and the commitment are checked, and the newest published version is used.</li>
</ul>`;

// ───────────────────────────────────────────────────────────────── the article: a harness needs a substrate

const SUBSTRATE_ALT =
  'A diagram in two layers. On top, the ten steps of the agent harness in a row: Admit, Playbook, Ground, Judge, Plan, Check, Authority, ' +
  'Execute, Receipt, Answer. Beneath, the seven capabilities of the Agentic Primitives substrate: Identity, Admission, Knowledge, ' +
  'Orchestration, Authority, Vault and Evidence. A line joins each step to what it takes from the substrate. Admit takes Identity and ' +
  'Admission. Playbook takes Knowledge and the Vault. Ground takes Knowledge. Judge, Plan, Check and Answer take Orchestration. ' +
  'Authority takes Authority and Identity. Execute takes Knowledge and Orchestration. Receipt takes Evidence and the Vault.';

const SUBSTRATE_BODY = `
<p>Every team that builds agents ends up writing the same loop. Take a request, let a model plan, call some tools, write an answer. It demos well. Then the agent starts acting for real people, and someone asks the questions that matter:</p>
<ul>
<li>Who actually asked?</li>
<li>What is this agent allowed to do for them, and who said so?</li>
<li>Which instructions did it follow, and could anyone have changed them?</li>
<li>Did the thing really happen, only once, and who can check?</li>
</ul>
<p>A loop cannot answer these. They are not planning problems. They are questions about identity, authority and evidence, and they need a layer underneath the loop that already holds the answers. We call that layer the substrate.</p>
<p>Ours is <a href="https://agenticprimitives.dev">Agentic Primitives</a>, an open set of TypeScript packages and contracts in which identity, custody, admission, delegation, naming and evidence are designed as one system. This article walks through the harness that runs every agent in the faithnet estate and shows what each step takes from that substrate. The flow itself, with the details of every step, is at <a href="/architecture/agent-harness">How an ask runs at an agent</a>.</p>

<h2>The harness, in ten steps</h2>
<p>An ask is one sentence from a person to an agent. It passes through ten steps.</p>
<ol>
<li><b>Admit.</b> Who is asking is settled before anything else.</li>
<li><b>Playbook.</b> The skills this agent was assigned are loaded and checked against their digest.</li>
<li><b>Ground.</b> Code reads the request against the domain's own terms.</li>
<li><b>Judge.</b> A small model answers one question: which one skill should handle this, or none?</li>
<li><b>Plan.</b> The plan is built around the chosen skill.</li>
<li><b>Check.</b> Fixed rules examine the plan before anything runs.</li>
<li><b>Authority.</b> Every step that acts needs a mandate the person signed.</li>
<li><b>Execute.</b> The step is checked for having already happened, then run once.</li>
<li><b>Receipt.</b> Every step leaves a record of what ran and under what.</li>
<li><b>Answer.</b> The answer is given as the skill wrote it, or composed and checked.</li>
</ol>
<p>Only four of the ten can call a model: the judge, the planner when no skill fits, a skill as it writes, and the composer of an answer. The other six are code, and they are the six that decide whether the agent can be trusted.</p>

<h2>What each step takes from the substrate</h2>
<p>The substrate gives the harness seven capabilities. Each is used by name in the steps above.</p>

<h3>Identity that can sign</h3>
<p>Every person, organization and agent is a Smart Agent: one permanent account with a name, such as <code>.me</code>, <code>.org</code> or <code>.svc</code>, whose signature anyone can check. A lost key is replaced. The identity stays, and so does everything set up under it.</p>
<p><b>Admit</b> uses it to know who is asking. <b>Authority</b> uses it to know who signed the mandate.</p>

<h3>Admission</h3>
<p>A front door that settles how a caller arrived: a person signed in at their Home, an app holding a wire that person signed, or another agent sending a message over A2A. It also checks the agent's budget. Admission says who is at the door. It never decides what they may do inside.</p>
<p><b>Admit</b> is this capability, used as it is.</p>

<h3>Knowledge with an address</h3>
<p>The domain's ontology says what things are called, and what each skill covers, produces and consumes. A skill is a document published with a commitment to its exact content, so it can be named by digest and never silently changed.</p>
<p><b>Playbook</b> pins the agent's skills by digest. <b>Ground</b> reads the request against the ontology before any model sees it. <b>Execute</b> reads a skill's body by the pinned digest, and refuses it if the registry's copy has moved.</p>

<h3>Orchestration</h3>
<p>The loop itself: intent, plan, act, observe. In the substrate it is a core with declared parts. The judge accepts a skill by a stated floor and margin. The plan rules are fixed code with named outcomes. Every model call goes through a gateway, under a named profile with a budget.</p>
<p><b>Judge</b>, <b>Plan</b>, <b>Check</b> and <b>Answer</b> are built from it.</p>

<h3>Authority</h3>
<p>A delegation is a signed, narrow permission that can be taken back: this act, up to this value, until this date. Its limits are kept by contracts, not by the agent behaving well.</p>
<p><b>Authority</b> checks a mandate for every step that acts, not once for the run. With no mandate the run stops, says exactly what it needs, and resumes when the person has signed at their Home.</p>

<h3>A vault the owner holds</h3>
<p>Each agent has a vault of its own records, and reading from it takes a grant. The service that runs the agent is not the owner of what is in it.</p>
<p><b>Playbook</b> reads the agent's skill assignment from the vault. <b>Receipt</b> writes the run's provenance into it.</p>

<h3>Evidence</h3>
<p>Every step leaves an audit event and a receipt: the skill and its version, the mandate it ran under, and what was observed. The run as a whole is projected into a provenance record in a standard vocabulary.</p>
<p><b>Receipt</b> is where a claim that "the agent did it" becomes something another party can check.</p>

<h2>Take the substrate away</h2>
<p>The clearest way to see what the substrate does is to remove it and look at what each step turns into.</p>
<ul>
<li><b>Admit becomes an API key.</b> You know which app called. You do not know which person.</li>
<li><b>Playbook becomes a prompt in a config file.</b> Whoever can deploy can change what the agent does, and nothing records that they did.</li>
<li><b>Authority becomes the service's own credentials.</b> The agent can do whatever the service can do, for everyone, and permission is an <code>if</code> statement.</li>
<li><b>Execute becomes a retry.</b> Nothing says whether the payment already went out.</li>
<li><b>Receipt becomes a log line in someone else's system.</b> The person the agent acted for cannot read it, and nobody outside can verify it.</li>
</ul>
<p>The judge and the planner would work exactly as before. That is the point. The intelligent parts of a harness are the parts you can get anywhere. The trustworthy parts are the ones that cannot be added afterwards, because they depend on every party having an identity, every permission being signed, and every record having an owner.</p>

<h2>Three rules that hold it together</h2>
<ul>
<li><b>Intelligence may be probabilistic. Authority must not be.</b> The planner proposes, the mandate authorizes, the executor acts, the receipt proves.</li>
<li><b>The ontology proposes, a judge decides, a declared rule accepts.</b> Choosing a skill never permits anything. The chosen step still meets every gate after it.</li>
<li><b>An archetype changes what an agent knows how to do, never what it may do.</b></li>
</ul>

<h2>Where to look next</h2>
<ul>
<li><a href="/architecture/agent-harness">How an ask runs at an agent</a>: the flow, with each step's details, where it runs and what it leaves behind.</li>
<li><a href="/architecture/scripture-ask">How the Scripture Agent answers a question</a>: the same judge and the same kind of skill in a harness shaped for an agent that only reads.</li>
<li><a href="https://agenticprimitives.dev">Agentic Primitives</a>: the substrate.</li>
</ul>`;

// ───────────────────────────────────────────────────────────────── sign-in at the Home (ap-home apps/home)

const SIGNIN_ALT =
  'A flow diagram. An app asks the Home to sign a person in. The Home checks the app against its registry and looks for a Home session. ' +
  'Without a session the person proves a credential and, the first time, a Home is made for them. Then the Allow sheet, a delegation the ' +
  'person signs, its check on chain, a record with a single-use code, and the code exchanged for an id_token. Three arcs run above the row. ' +
  'A new app for a person already signed in goes from Recognize to Allow. An app that still holds its delegation goes straight to Token. ' +
  'A proposed path, not built, would go from Recognize to Verify, with no sheet and no new signature.';

const HOME_PAGES = "The Home's pages, in the person's browser. The Home is a Next.js app (<code>apps/home</code>) at <code>www.faithnet.me</code>.";
const HOME_SERVER = "The Home's server (<code>apps/home/server</code>). Tickets, codes and rows are kept in its key-value store, <code>AUTH_CODES</code>.";

const SIGNIN_STEPS: Step[] = [
  {
    id: 'ask', name: 'Ask', color: '#8b5cf6', at: [191, 520],
    summary: 'The app sends the person to their Home with a PKCE request.',
    why: 'An app never sees a credential. It asks the Home to sign the person in and waits for a code. The request carries a PKCE challenge so that only the tab that asked can finish, even if the code is seen on the way back.',
    what: [
      'The app makes a random verifier, keeps it, and sends its SHA-256 as the challenge. It opens the Home, in a popup or as a full page, at <code>/?client_id=…&amp;redirect_uri=…&amp;response_type=code&amp;code_challenge=…&amp;code_challenge_method=S256&amp;state=…&amp;delegation_template=site-login</code>.',
      'Optional parts: <code>agent_name</code> pins the request to one named Home, <code>nonce</code> is echoed in the id_token, <code>session_key</code> asks for a session leaf, and <code>prompt</code> changes how the Home treats an existing session.',
      'The Home copies the request into its own storage for twenty minutes, so it survives a trip out to Google or an email link and back.',
    ],
    where: ["The app's own page. On this site that is <code>apps/estate/assets/app.js</code> (<code>signIn</code>).", 'The Home reads the request in <code>src/components/onboarding/useEnrollReq.ts</code> (<code>parseEnrollReq</code>).'],
    by: 'The app starts it. The person has done nothing yet but press Sign in.',
    reads: ['Nothing at the Home yet.'],
    leaves: ["The verifier and <code>state</code>, in the app's storage.", "The request, in the Home's <code>sessionStorage</code> and a short <code>ap_pending_enroll</code> cookie."],
    stops: [
      'A request without a client, a redirect, a challenge and a template is not a sign-in request. The Home shows its own front door.',
      'Only the code flow and only S256 are read. Anything else is ignored.',
      '<code>prompt=none</code> never shows a page. The Home answers <code>login_required</code> when there is no session and <code>interaction_required</code> when there is one. It does not sign anyone in this way today.',
    ],
  },
  {
    id: 'check', name: 'Check', color: '#3b82f6', at: [309, 520],
    summary: 'Is this app registered, and may it ask for this?',
    why: 'Everything in the request is written by the app, so none of it can be trusted to say who the app is. The registry is the one place that says which origins an app may return to, which permissions it may ask for, and which key its delegations go to.',
    what: [
      "The Home looks the client up in its registry. An estate's own apps are in the white-label config. An app a member registered is looked up once at <code>/connect/client-info</code>.",
      "The redirect must match a registered one exactly, and its origin must be on the Home's list of relying origins. The template must be one the app is allowed.",
      'The name and logo on the consent sheet come from the registry. The <code>delegate</code> in the URL is only a hint: the server takes the delegate from the registry and ignores the one that was sent.',
    ],
    where: [HOME_PAGES, 'Source: <code>src/lib/oidc-clients.ts</code>, <code>src/whitelabel/config.ts</code> (<code>relyingApps</code>).', 'The server checks again at <code>/oidc/authorize-grant</code> and at <code>/token</code> (<code>server/_lib/oidc-registry.ts</code>).'],
    by: 'Code only.',
    reads: ["The app's registry entry: redirects, allowed templates, delegate keys, the claims it may receive, its session lifetime."],
    leaves: ['Nothing. It is a gate.'],
    stops: ['An unknown client or an unlisted origin gets the page "Request blocked". Nothing is sent back to the app.'],
  },
  {
    id: 'recognize', name: 'Recognize', color: '#14b8a6', at: [428, 520],
    summary: 'Is this person already signed in at the Home?',
    why: 'This step is single sign-on. A person who proved who they are at the Home once should not prove it again for every app. What they should still decide is whether this app gets in.',
    what: [
      "The Home looks for its own session: a token it signed for this person, kept in the Home's <code>localStorage</code> and mirrored in the <code>ap_sso</code> cookie on the Home's parent domain, so every host of the Home sees it. The token lasts one hour. The cookie that carries it lasts thirty days, so after the hour the cookie is still there and no longer works.",
      "The token is tried by reading the person's profile with it. It must name an account that is deployed. If the request pinned a name, the session must be that name.",
      'With a session, the person goes straight to Allow. A passkey only works on the host it was made for, so a passkey person is first moved to their own subdomain of the Home, with the request carried along.',
      'Without a session, the person goes to Prove.',
      'This step does not ask whether the person has allowed this app before. Nothing in sign-in asks that.',
    ],
    where: [HOME_PAGES, 'Source: <code>EntryExperience.tsx</code> (the routing), <code>RecognizedEnroll.tsx</code> (the recognized path), <code>src/lib/sso-cookie.ts</code>, <code>src/context/session.tsx</code>.'],
    by: 'Code only.',
    reads: ['The <code>ap_sso</code> cookie.', "The person's profile, read with the token inside it."],
    leaves: ['The person and how they sign (server-held key, passkey or wallet), for the steps after.'],
    stops: ['A missing, expired or mismatched session is not an error. It falls to Prove, the one fallback.'],
  },
  {
    id: 'prove', name: 'Prove', color: '#ef4444', at: [547, 520],
    summary: 'The person proves who they are with one credential.',
    why: 'Someone has to establish who is at the keyboard, and it should happen in one place. The Home is that place, so an app never handles a password, a code or a key.',
    what: [
      'The Home shows its sign-in methods. The app may narrow which ones are offered, for display only.',
      "Social (Google, YouVersion) is a full-page trip to the provider and back. The Home restores the app's request from where it was put aside in step 1.",
      'Email and phone send a one-time code.',
      "A passkey is made and used on the person's own subdomain of the Home, so a new passkey person chooses a name first.",
      'A wallet signs a sign-in message.',
      'Any of these ends the same way: the Home signs a session token, stores it, writes the <code>ap_sso</code> cookie, and tells the browser the person is signed in here.',
    ],
    where: [HOME_PAGES, 'Source: <code>EntryExperience.tsx</code> (<code>CredentialFirstStart</code>), <code>GoogleEnrollResume.tsx</code> (the return from a provider), <code>src/home/onboarding.ts</code>.', 'The provider legs and the code checks run on the server (<code>server/oidc/google</code>, <code>server/connect/email-verify.ts</code>, <code>phone-verify.ts</code>, <code>passkey.ts</code>, <code>siwe.ts</code>).'],
    by: 'The person, with their credential.',
    reads: ["The credential, checked by the Home's server or by the provider."],
    leaves: ["The Home session: in the Home's <code>localStorage</code>, and in the <code>ap_sso</code> cookie. The token is good for one hour."],
    stops: [
      'A failed code, a cancelled provider trip or a refused wallet signature leaves the person on the sign-in page.',
      'A Google account that already opens a different Home than the one the request named is explained, not connected.',
    ],
  },
  {
    id: 'home', name: 'Make a Home', color: '#f59e0b', at: [666, 520],
    summary: 'First time only: the person gets an account of their own.',
    why: 'What an app receives is a delegation from an account the person controls. That account, a smart account on the chain, has to exist before it can sign anything.',
    what: [
      'For a person with an account already, this step does nothing.',
      'For a new social, email or phone person, the Home deploys an account with no name. The key is held for them on the server, so there is no prompt. They can claim a name later.',
      'For a new passkey person, the account is made with the name they chose, and that one approval both founds the Home and registers the name. A wallet person can take a name or go without.',
      'If the app declared what its new members need, such as a name on their profile or a money account, that is set up here, before the sheet.',
    ],
    where: [HOME_PAGES, 'Source: <code>src/home/onboarding.ts</code> (<code>secureHomeNoName</code>, <code>secureHome</code>), <code>NewMemberSetup.tsx</code>, <code>OnboardingJourney.tsx</code>.', 'The account is deployed on faithchain.'],
    by: 'Code, signing with the credential from Prove.',
    reads: ["The app's registry entry, for what a new member needs."],
    leaves: ["The person's account on chain: their agent."],
    stops: ['A deploy that fails is said on the page, and the person can try again. Nothing is sent to the app.', 'A name that was reserved but never finished is refused, with a way to pick another.'],
  },
  {
    id: 'allow', name: 'Allow', color: '#eab308', at: [784, 520],
    summary: 'The sheet: allow this app, or not now.',
    why: 'Knowing who a person is does not say what an app may do as them. That is a separate decision and it is the person\'s. The sheet is where they make it, with the terms in front of them.',
    what: [
      'The sheet names who is signed in, then the app by its registered name, domain and logo.',
      'It lists what the app can do and what it cannot, from the permission template. For a plain sign-in: sign in as you and read your profile, and never move funds, add sign-in methods or change recovery.',
      'It adds a line for anything else the registry lets this app receive: a name, an email, the right to ask your agent as you.',
      'Allow goes on to Sign. Not now sends the app a refusal. A third link lets a different person sign in.',
      'The sheet is shown on every trip to the Home that gets this far. A first sign-in, a new app, and the same app for the tenth time all see it. Why, and what would change it, is <a href="#pauls-points">answered at the bottom of the page</a>.',
    ],
    where: [HOME_PAGES, 'Source: <code>RecognizedEnroll.tsx</code>, <code>src/components/shared/ConsentSheet.tsx</code>, with the lines in <code>src/whitelabel/config.ts</code> (<code>delegationTemplates</code>).'],
    by: 'The person decides.',
    reads: ['The permission template.', "The app's registry entry."],
    leaves: ['Nothing until Allow is pressed.'],
    stops: ['Not now returns <code>enroll_error=denied</code> to the app, or closes the popup with a cancel message.'],
  },
  {
    id: 'sign', name: 'Sign', color: '#22c55e', at: [903, 520],
    summary: 'The person signs a delegation to the app\'s registered key.',
    why: 'The app should hold something narrow, dated and revocable, signed by the person, and never the person\'s credential. A delegation is that: what one key may do as this account, until when.',
    what: [
      'The page first asks the server for a ticket: <code>POST /oidc/authorize-grant</code>. The server binds the client, redirect, PKCE challenge, nonce, template and the delegate from the registry under a random id, for ten minutes and one use.',
      "The page builds the site delegation, from the person's account to that delegate, and approves its digest on chain in one sponsored operation. A server-held key signs with no prompt. A wallet prompts. A passkey asks for one touch.",
      'Other wires are signed in the same ceremony when the registry declares them: an ask-as-me wire (30 days), a session-key leaf, a grant on the person\'s own vault, a capped payment mandate.',
      'A bare site delegation that this browser already made for the same person and delegate is reused, with no new signature. That holds only in the same browser, only when nothing else rides along, and never in the delegation\'s last thirty days.',
    ],
    where: [HOME_PAGES, 'Source: <code>src/home/onboarding.ts</code> (<code>givePermission</code>), <code>src/lib/delegation.ts</code>, <code>src/lib/grant-cache.ts</code>.', 'The ticket: <code>server/oidc/authorize-grant.ts</code>.'],
    by: 'The person\'s credential signs. Code builds what is signed.',
    reads: ['The ticket and the delegate it names.', 'The standing delegation in this browser, if there is one.'],
    leaves: ['A delegation whose digest is approved on chain.', "A copy in the Home's <code>localStorage</code>, for reuse in this browser."],
    stops: ['The ticket is refused when it is not asked from the Home\'s own origin, or when the client, redirect or template is not registered.', 'A refused prompt or a failed approval stops here and is said on the page.'],
  },
  {
    id: 'verify', name: 'Verify', color: '#0ea5e9', at: [1022, 520],
    summary: 'The server proves the delegation on chain.',
    why: 'The page is the person\'s browser, and a browser can be made to say anything. So the server takes nothing on trust: it checks the delegation against the chain and against the ticket it issued.',
    what: [
      'The page sends the ticket id and the delegation to <code>POST /oidc/grant</code>. The ticket is read and deleted, so it works once.',
      "The delegation's delegate must be the one the registry named when the ticket was made.",
      "The signature is checked against the person's account on chain (ERC-1271). The delegation must not be revoked and must be inside its dates. If the chain cannot be read, the answer is no.",
      'Every extra wire is proved on its own, against its own signer.',
    ],
    where: [HOME_SERVER, 'Source: <code>server/oidc/grant.ts</code>, <code>server/_lib/verify-delegation.ts</code>, deciding with <code>verifyLiveDelegation</code> from <code>@agenticprimitives/delegation</code>.'],
    by: 'Code only.',
    reads: ['The ticket.', "The chain: the account's signature check and the revocation registry."],
    leaves: ["The delegation's digest, used as a key in the next step."],
    stops: [
      '<code>403</code> when the call does not come from the Home\'s own origin.',
      '<code>400</code> for a ticket that is unknown or already used.',
      '<code>401</code> when the delegate does not match or a proof fails.',
      'A reused delegation that is refused is dropped from the browser, and a fresh one is signed, once.',
    ],
  },
  {
    id: 'record', name: 'Record', color: '#6366f1', at: [1140, 520],
    summary: 'An id_token is minted, a row is written, a code goes back.',
    why: 'The token must never travel in a URL, and the app that asked must be the only one able to collect it. So the Home keeps the answer and hands back a code that is good once, for five minutes, to the holder of the PKCE verifier.',
    what: [
      'Still inside <code>/oidc/grant</code>. The server mints the id_token: issued by the Home, about the person\'s account, for this client, with the nonce and whatever name or email the registry permits.',
      "It binds the delegation's digest to this client (<code>oidc-deleg:&lt;digest&gt;</code>), so the delegation can renew a session for this app and no other.",
      'It writes the Allow as a row under the person (<code>app-grants:&lt;person&gt;</code>): the client, the template, the delegate, the delegation and the time. A newer Allow for the same app replaces the row.',
      'It puts the whole answer under a single-use code and returns the code to the page.',
      "The page makes sure the person's vault key is bound, refreshes the session cookie, and delivers the code: a message to the app's exact origin from a popup, or a redirect with <code>?code</code> and <code>state</code>.",
    ],
    where: [HOME_SERVER, 'Source: <code>server/oidc/grant.ts</code>. Delivery: <code>useEnrollReq.ts</code> (<code>deliverEnrollCode</code>).'],
    by: 'Code only.',
    reads: ['The ticket, for the client, the nonce and the PKCE challenge.'],
    leaves: [
      'A binding from the delegation to the client. It lasts as long as an id_token.',
      'A row for this Allow. The Connected Apps page lists it and revokes from it. Sign-in does not read it.',
      'A code, for five minutes and one use.',
    ],
    stops: ['Nothing new can stop here. Every refusal is in Verify.'],
  },
  {
    id: 'token', name: 'Token', color: '#3b82f6', at: [1259, 520],
    summary: 'The app trades the code, or a delegation it holds, for an id_token.',
    why: 'The app gets two things and they do different work. The id_token says who the person is. The delegation says what the app may do as them. Keeping them apart is what lets the delegation renew the session later without a page.',
    what: [
      'After a trip to the Home: the app posts the code, its PKCE verifier, its client id and its redirect to <code>/token</code>. The code is deleted as it is read. The client and redirect must match, and the verifier must hash to the challenge.',
      "The answer is the id_token, the delegation, and any extra wires. Whoever relies on the token checks it against the Home's published keys.",
      'Coming back: the app posts <code>grant_type: delegation</code> with the delegation it kept. The server checks that the delegate is the app\'s registered one, proves the delegation on chain again, and looks for the binding made in step 9. Then it mints a fresh id_token and renews the binding. No page is shown.',
      'An id_token lasts seven days unless the estate or the app\'s registration says otherwise.',
    ],
    where: [HOME_SERVER, 'Source: <code>server/token.ts</code>, <code>server/_lib/session-ttl.ts</code>.', "The app's side on this site: <code>apps/estate/assets/app.js</code> (<code>finishSignIn</code>)."],
    by: 'Code only.',
    reads: ['The code, or the binding for the presented delegation.', 'The chain, for a delegation.'],
    leaves: ["In the app's own storage: the id_token and the delegation."],
    stops: [
      '<code>400</code> for a code that is unknown, used, or presented with the wrong client, redirect or verifier.',
      '<code>401</code> "re-enroll required" when a presented delegation has no binding here, or was issued for another client. The app must send the person to the Home again.',
    ],
  },
];

const SIGNIN_BODY = `
<h2>Two things come back, not one</h2>
<p>A sign-in at the Home returns an <b>id_token</b> and a <b>delegation</b>. The id_token is identity: the Home's signed statement of who this person is, for this app, for a few days. The delegation is authority: the person's own signed statement of what this app's key may do as them, until a date, revocable on chain. The Home issues the first. Only the person can issue the second.</p>
<p>The row in the picture is the first sign-in, every step. The three arcs above it are the other visits. Each one skips what it does not need.</p>
<p class="callout"><b>From review.</b> Paul's points on remembered consent are quoted and answered one by one at the bottom of this page: <a href="#pauls-points">Paul's points, answered</a>.</p>

<h2>First time in</h2>
<p>A person who has never used the estate presses Sign in at an app.</p>
<ul>
<li><b>The app asks</b> (1). It sends the person to the Home with a PKCE challenge and keeps the verifier.</li>
<li><b>The Home checks the app</b> (2) against its registry, and finds <b>no session</b> (3).</li>
<li><b>The person proves who they are</b> (4) with Google, YouVersion, an email or phone code, a passkey or a wallet. The Home now has a session for them, good for one hour.</li>
<li><b>The Home makes their account</b> (5): a smart account on the chain that is theirs. This happens once in a person's life at the estate.</li>
<li><b>The sheet asks</b> (6): allow this app? It lists what the app can and cannot do.</li>
<li><b>The person signs</b> a delegation to the app's registered key (7), and <b>the server proves it</b> on chain (8).</li>
<li><b>The Home records the Allow</b> and hands back a single-use code (9), which <b>the app trades</b> for the id_token and the delegation (10).</li>
</ul>
<p>How many prompts that is depends on the credential. A person whose key the Home holds for them (social, email, phone) sees the sheet and presses Allow. A wallet or passkey person also approves on their device.</p>

<h2>A new app, already signed in</h2>
<p>This is single sign-on, the green arc. The person signed in at the Home for one app and, within the hour, opens another.</p>
<ul>
<li>Steps 1 and 2 are the same.</li>
<li>At step 3 the Home finds its session in the <code>ap_sso</code> cookie. The cookie sits on the Home's parent domain, so it is there whichever host of the Home the request lands on.</li>
<li>Steps 4 and 5 are skipped. No credential is asked. No account is made.</li>
<li>The sheet (6) is shown, because this app has never been allowed. Then steps 7 to 10 as before.</li>
</ul>
<p>The session carries identity from one app to the next. It carries no authority. Each app gets its own delegation, to its own registered key.</p>

<h2>Coming back to an app</h2>
<p>What happens depends on what the app still holds.</p>
<ul>
<li><b>A live id_token.</b> Nothing happens at the Home. The app is signed in until the token lapses. How long the app keeps it is the app's choice: this site keeps its session in one tab, so a new tab starts over.</li>
<li><b>A lapsed token and the delegation.</b> The blue arc. The app posts the delegation to <code>/token</code>. The Home proves it on chain, finds the binding from the last Allow, and answers with a fresh id_token. No page, no prompt. Each renewal also renews the binding, so an app that comes back within one token lifetime can go on for as long as the delegation lives.</li>
<li><b>Nothing it can use.</b> The storage was cleared, it is another device, or the binding lapsed because the app stayed away longer than one token lifetime. The app sends the person to the Home. If the person proved a credential at the Home within the last hour, the session is still good and steps 4 and 5 are skipped. Otherwise they prove it again. Either way the sheet is shown again, for an app the person already allowed.</li>
</ul>
<p>That last visit is the one that feels wrong. It is what Paul raised in review, and his points are <a href="#pauls-points">answered at the bottom of this page</a>.</p>

<h2>In Chrome: the browser's own chooser</h2>
<p>Where the browser supports FedCM, an app can ask the browser itself. The browser shows its own account chooser, reads the same Home session, and collects a thin id_token from <code>/fedcm/assertion</code>. The app then asks <code>/fedcm/grant</code> for the delegation. For a person whose key the Home holds, the server has a site delegation signed with no further prompt: choosing the account in the browser's chooser was the gesture. For a passkey or wallet person the server cannot sign, so the app falls back to the popup and the flow in the picture. FedCM is another way to reach the same two things. It adds no authority of its own.</p>

<h2>What is remembered, and where</h2>
<ul>
<li><b>The Home session.</b> The Home's <code>localStorage</code> and the <code>ap_sso</code> cookie. The token lasts one hour and nothing renews it. The cookie that carries it lasts thirty days, so recognition lasts the hour, not the month. Read by Recognize and by FedCM. It is written and read by page script.</li>
<li><b>The request.</b> The Home's <code>sessionStorage</code> and a cookie, twenty minutes. Only so a provider trip can return to it.</li>
<li><b>The ticket.</b> Server, ten minutes, one use.</li>
<li><b>The code.</b> Server, five minutes, one use.</li>
<li><b>The binding</b> from a delegation to its client. Server, one token lifetime, renewed by each silent renewal. Read by <code>/token</code>.</li>
<li><b>The row for an Allow.</b> Server, under the person, the newest row for each app. Read by the Connected Apps page and by credential rotation. Not read by sign-in.</li>
<li><b>The standing delegation.</b> The Home's <code>localStorage</code> in one browser, keyed by person and delegate. Read by Sign, to avoid signing the same bare site delegation twice.</li>
<li><b>The delegation itself.</b> Held by the app, with its digest approved on chain. A site delegation runs 365 days, an ask-as-me wire 30.</li>
<li><b>The id_token.</b> Held by the app. Seven days by default.</li>
</ul>

<h2>Three rules that hold it together</h2>
<ul>
<li><b>Identity is the Home's to state. Authority is the person's to give.</b> The id_token and the delegation are separate on purpose.</li>
<li><b>The registry decides, never the request.</b> An app's name, its return address, its key and what it may receive are read from the registry. The URL is only a hint.</li>
<li><b>Nothing is taken on trust from a page.</b> Every delegation is proved on chain before a code exists, and again each time it renews a session.</li>
</ul>
<p>What an app does with the delegation once it is signed in is the next picture: <a href="/architecture/agent-harness">How an ask runs at an agent</a>.</p>

<h2 id="pauls-points">Paul's points, answered</h2>
<p>Paul reviewed the sign-in and wrote up what he found and what he would do about it. His words are quoted below, a point at a time, each with a direct answer from the code as it stands. File names are under <code>apps/home</code>.</p>

<h3>1. Is consent remembered?</h3>
<blockquote><p>"The Home never checks whether a person has already allowed an app."</p></blockquote>
<p><b>Correct.</b> Nothing on the sign-in path reads a past Allow. The row for an Allow is written by <code>server/oidc/grant.ts</code> and read in two places: <code>server/connect/app-grants.ts</code>, for the Connected Apps page, and <code>src/home/rotation.ts</code>, for credential rotation. No file under <code>src/components/onboarding</code> reads it. The Home says so itself where it handles <code>prompt=none</code> in <code>EntryExperience.tsx</code>: it answers <code>interaction_required</code> to a signed-in person because it keeps no store of remembered consent.</p>

<h3>2. Is the sheet shown every time?</h3>
<blockquote><p>"RecognizedEnroll sends every recognized sign-in straight to the 'Allow &lt;app&gt;?' sheet."</p></blockquote>
<p><b>Correct.</b> Once the session resolves, <code>RecognizedEnroll.tsx</code> goes to the sheet. The only turns before it are a session that fails, a pinned name that does not match, a passkey that needs its own host, and the organization chooser. None of them looks at past Allows.</p>
<p>There is one path with no sheet, and it is not this component. In Chrome's FedCM lane, a person whose key the Home holds gets a site delegation from <code>/fedcm/grant</code> after choosing their account in the browser's own chooser.</p>

<h3>3. Is a new delegation signed every time?</h3>
<blockquote><p>"…and signs a fresh delegation (meaning, every sign-in gets a new delegation)."</p></blockquote>
<p><b>Correct for the Seed Bible Reader. Not for every app.</b></p>
<ul>
<li><b>An ask-as-me wire is signed fresh at every sign-in.</b> There is no reuse for it, whether the app asks for the ask-as-me permission or takes the wire beside a plain sign-in. The reader is such an app, so for the reader every sign-in is the sheet and a new delegation, thirty days each.</li>
<li><b>A bare site sign-in reuses.</b> <code>givePermission</code> in <code>src/home/onboarding.ts</code> first looks for the delegation this browser already made for the same person and delegate (<code>src/lib/grant-cache.ts</code>). If it finds one, the sheet is still shown, but nothing new is signed. A session key or a payment in the request turns the reuse off. So does a vault grant, unless the app's registration opts in to reusing it.</li>
<li><b>The reuse is per browser.</b> Another browser, another device or cleared storage signs a new one.</li>
</ul>
<p>One thing follows that is worth more than the extra prompt. A newer delegation does not revoke the older one. Each stays valid until it expires or the person revokes it on chain.</p>

<h3>4. Is the row from the last Allow there?</h3>
<blockquote><p>"…even though the app-grants row from the last Allow is already there."</p></blockquote>
<p><b>Correct, and the row is thinner than it sounds.</b> It holds the client, the permission template, the delegate, the main delegation and the time. It is written only for an Allow that names no organization, and a newer Allow for the same app replaces it.</p>
<p>What it does not hold: the terms the sheet showed, and an ask wire signed beside a plain sign-in. So the row can say that an app was allowed. It cannot yet say what was agreed, and it does not list every wire that is live.</p>

<h3>5. The fix: store what each Allow agreed to</h3>
<blockquote><p>"If we were to fix it, the best case is that the Home stores what each Allow agreed to…"</p></blockquote>
<p><b>Agreed, and this is the part that is missing.</b> A later sign-in has to compare what the app asks for now with what the person agreed to then. That needs the terms kept in a form that can be compared: the template, the claims the app receives, and every wire signed with it. Two constraints from the code:</p>
<ul>
<li><b>Key it by app, not by delegate.</b> Several apps share one delegate address, and the browser's reuse cache is keyed by delegate.</li>
<li><b>Put the terms in the person's vault.</b> This estate's rule is that the vault is the record and apps hold references. The server row stays a pointer.</li>
</ul>

<h3>6. The fix: when the server may skip the sheet</h3>
<blockquote><p>"…and, on a later sign-in, the server skips the sheet only when the app's registry entry asks for nothing more and the stored delegation still verifies on chain…"</p></blockquote>
<p><b>Agreed. Both checks have their parts already. The place to run them does not exist.</b></p>
<ul>
<li><b>The registry</b> is read on the server (<code>server/_lib/oidc-registry.ts</code>).</li>
<li><b>The chain check</b> is the one step 8 uses (<code>server/_lib/verify-delegation.ts</code>). It checks the signature, revocation and the dates, and it says no when the chain cannot be read.</li>
<li><b>The decision is in the wrong place today.</b> The browser decides to show the sheet. The two grant endpoints take a call from the Home's own pages with no session at all, because a fresh signature is the proof. A skip has no fresh signature, so it needs a new server step that knows who is asking.</li>
<li><b>Nothing may be signed on a skipped sheet.</b> The wires that are signed fresh today must be stored and presented again, or an app that needs them keeps the sheet.</li>
<li><b>The ways back to the sheet must hold.</b> Revoking on chain, forgetting the app in Connected Apps, a registry entry that asks for more, <code>prompt=login</code> and "not you?" each bring it back.</li>
</ul>

<h3>7. The fix: a cookie script cannot read</h3>
<blockquote><p>"…with a server-set HttpOnly cookie proving who is asking instead of the script-readable session token."</p></blockquote>
<p><b>Agreed, and it has to come first.</b> Today the session is a token in <code>localStorage</code> and in the <code>ap_sso</code> cookie, and page script writes and reads both. On a skipped sheet that session is the only proof of who is asking. It should be one that script cannot read. The cookie is also sent on cross-site requests today, which FedCM needs, so the new step must answer the Home's own pages only.</p>

<h3>8. Is any of it built?</h3>
<blockquote><p>"You already have a note about this but it has not been done yet."</p></blockquote>
<p><b>Correct.</b> There are two notes and no code. <code>src/lib/sso-cookie.ts</code> carries a hardening note that a server-set HttpOnly cookie should replace the script-managed one. <code>EntryExperience.tsx</code> notes at <code>prompt=none</code> that there is no remembered-consent store yet. Nothing for either is in this repository. In the picture this is the dashed amber arc, marked proposed and not built.</p>
<p>The design is now written down as spec 445, <i>The Home remembers an Allow</i>: the cookie first, then the stored terms, then the server step that skips the sheet, turned on for one app at a time.</p>

<h3>In short</h3>
<ul>
<li>Points 1, 2, 4 and 8 are right as written.</li>
<li>Point 3 is right for the reader and for any app that takes an ask wire. A bare site sign-in reuses its delegation in the same browser.</li>
<li>Points 5 to 7 are the right fix. The order is the cookie first, then the stored terms, then the server step that skips.</li>
<li>Once it is built, <code>prompt=none</code> can return a code. Today it cannot.</li>
</ul>`;

export const POSTS: Post[] = [
  {
    slug: 'sign-in',
    title: 'How sign-in works: the first time, a new app, and coming back',
    date: '2026-11-05',
    description:
      'The path from pressing Sign in at an app to the app holding a delegation: what the Home checks, what the person signs, what is remembered, and what a second app or a return visit skips.',
    picture: {
      svg: '/architecture/sign-in-flow.svg', png: '/architecture/sign-in-flow.png', alt: SIGNIN_ALT, width: 1460, height: 1020,
      caption: 'Grey arrows are a first sign-in. Green is a new app for a person already signed in. Blue is an app coming back. Dashed amber is proposed and not built.',
    },
    steps: SIGNIN_STEPS,
    byHeading: 'Who acts',
    body: SIGNIN_BODY,
  },
  {
    slug: 'harness-needs-substrate',
    title: 'Great Agent Harness requires Agentic Primitives Substrate',
    date: '2026-11-05',
    description:
      'An agent harness is the loop that turns one sentence into something done. The loop is the easy part. What decides whether it can be trusted is what it stands on.',
    picture: {
      svg: '/architecture/harness-on-substrate.svg', png: '/architecture/harness-on-substrate.png', alt: SUBSTRATE_ALT, width: 1920, height: 1080,
      caption: 'The ten steps of the harness, and what each one takes from the substrate beneath it.',
    },
    body: SUBSTRATE_BODY,
  },
  {
    slug: 'scripture-ask',
    title: 'How the Scripture Agent answers a question',
    date: '2026-11-05',
    description:
      'The path a question takes through the Scripture Agent: what it gathers, how a model drafts and code proves every verse, and the categories of skills that drive it.',
    picture: {
      svg: '/architecture/scripture-ask-flow.svg', png: '/architecture/scripture-ask-flow.png', alt: SCRIPTURE_ALT, width: 1460, height: 900,
      caption: 'Grey arrows are the question. Pink arrows are a skill on its way in. Dashed arrows happen only when needed.',
    },
    steps: SCRIPTURE_STEPS,
    body: SCRIPTURE_BODY,
  },
  {
    slug: 'agent-harness',
    title: 'How an ask runs at an agent',
    date: '2026-11-05',
    description:
      'The path one sentence takes through the agent harness, from the person who asked to the receipt that proves what was done, and where skills enter it.',
    picture: {
      svg: '/architecture/agent-harness-flow.svg', png: '/architecture/agent-harness-flow.png', alt: HARNESS_ALT, width: 1460, height: 960,
      caption: 'Grey arrows are the ask. Pink arrows are a skill on its way in. Dashed arrows happen only when needed.',
    },
    steps: HARNESS_STEPS,
    body: HARNESS_BODY,
  },
];

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const longDate = (iso: string): string => { const [y, m, d] = iso.split('-').map(Number); return `${d} ${MONTHS[m! - 1]} ${y}`; };
const attr = (s: string): string => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

export interface ArchitectureInput { name: string; origin: string }

/** The posts as cards, newest first: the architecture index, and the front page of a visitor who is not signed in. */
export function postCards(limit = POSTS.length): string {
  return POSTS.slice(0, limit).map((post) => `<article class="post-card">
<a class="thumb" href="/architecture/${post.slug}"><img src="${post.picture.svg}" alt="" width="${post.picture.width}" height="${post.picture.height}" loading="lazy"></a>
<h2><a href="/architecture/${post.slug}">${post.title}</a></h2>
<p class="quiet"><time datetime="${post.date}">${longDate(post.date)}</time></p>
<p>${post.description}</p>
<p><a href="/architecture/${post.slug}">Read the post →</a></p>
</article>`).join('\n');
}

export function architectureIndex(p: ArchitectureInput): string {
  return shell({
    name: p.name, current: 'architecture', title: `Architecture · ${p.name}`,
    description: `How ${p.name} works: the agent harness, skills, authority and records, in pictures.`,
    canonical: `${p.origin}/architecture`,
    main: `<h1>Architecture</h1>\n<p class="quiet">How this estate works, in pictures.</p>\n${postCards()}`,
  });
}

const list = (items: string[]): string => `<ul>${items.map((x) => `<li>${x}</li>`).join('')}</ul>`;

/** One step's details: the panel that opens on the right when the step is chosen. `#closed` shuts it. */
function stepPanel(steps: Step[], i: number, byHeading = 'A model, or code'): string {
  const s = steps[i]!, prev = steps[i - 1], next = steps[i + 1];
  return `<aside class="fly" id="step-${s.id}" role="dialog" aria-labelledby="step-${s.id}-name">
<a class="shade" href="#closed" tabindex="-1" aria-hidden="true"></a>
<div class="sheet">
<p class="fly-top"><span class="num" style="--c:${s.color}">${i + 1}</span><span class="quiet">Step ${i + 1} of ${steps.length}</span><a class="close" href="#closed">Close</a></p>
<h2 id="step-${s.id}-name">${s.name}</h2>
<p class="lede">${s.summary}</p>
<h3>Why this step exists</h3>
<p>${s.why}</p>
<h3>What happens</h3>
${s.what.map((x) => `<p>${x}</p>`).join('\n')}
<h3>Where it runs</h3>
${list(s.where)}
<h3>${byHeading}</h3>
<p>${s.by}</p>
<h3>What it reads</h3>
${list(s.reads)}
<h3>What it leaves behind</h3>
${list(s.leaves)}
<h3>How it stops or holds</h3>
${list(s.stops)}
<p class="fly-nav">${prev ? `<a href="#step-${prev.id}">← ${prev.name}</a>` : '<span></span>'}${next ? `<a href="#step-${next.id}">${next.name} →</a>` : '<a href="#closed">Done</a>'}</p>
</div>
</aside>`;
}

export function architecturePost(p: ArchitectureInput, slug: string): string | null {
  const post = POSTS.find((x) => x.slug === slug);
  if (!post) return null;
  const pic = post.picture, steps = post.steps;
  const head = `<p class="quiet"><a href="/architecture">Architecture</a> · <time datetime="${post.date}">${longDate(post.date)}</time></p>
<h1>${post.title}</h1>
<p class="lede">${post.description}</p>`;
  const meta = { name: p.name, current: 'architecture' as const, title: `${post.title} · ${p.name}`, description: post.description,
    canonical: `${p.origin}/architecture/${post.slug}`, image: `${p.origin}${pic.png}`, article: true };
  if (!steps) return shell({ ...meta, main: `<article class="post">
${head}
<figure class="picture wide">
<div class="scroll"><div class="canvas"><img src="${pic.svg}" alt="${attr(pic.alt)}" width="${pic.width}" height="${pic.height}"></div></div>
<figcaption>${pic.caption} <a href="${pic.svg}">Open the picture</a> · <a href="${pic.png}">PNG</a></figcaption>
</figure>
${post.body}
</article>` });
  // the tiles in the picture are links too: one clear rectangle over each numbered tile, in the picture's own units
  const hots = steps.map((s) => `<a href="#step-${s.id}" tabindex="-1"><title>${s.name}</title><rect x="${s.at[0] - 40}" y="${s.at[1] - 40}" width="80" height="80" rx="20"/></a>`).join('');
  const items = steps.map((s) => `<li><a href="#step-${s.id}"><span class="num" style="--c:${s.color}">${steps.indexOf(s) + 1}</span><b>${s.name}</b><span class="sum">${s.summary}</span></a></li>`).join('\n');
  return shell({ ...meta,
    main: `<article class="post">
${head}
<div class="flow">
<figure class="picture">
<div class="scroll"><div class="canvas"><img src="${pic.svg}" alt="${attr(pic.alt)}" width="${pic.width}" height="${pic.height}"><svg class="hots" viewBox="0 0 ${pic.width} ${pic.height}">${hots}</svg></div></div>
<figcaption>${pic.caption} Choose a numbered step for its details. <a href="${pic.svg}">Open the picture</a> · <a href="${pic.png}">PNG</a></figcaption>
</figure>
<nav class="flow-steps" aria-label="The steps of this flow">
<i id="closed"></i>
<h2>The steps</h2>
<p class="quiet">Choose a step to see why it exists, where it runs and what it leaves behind.</p>
<ol>
${items}
</ol>
</nav>
<div class="flys">
${steps.map((_, i) => stepPanel(steps, i, post.byHeading)).join('\n')}
</div>
</div>
${post.body}
</article>`,
  });
}
