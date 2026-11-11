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


const ANSWER_ALT =
  "A flow diagram of the design in testing, not yet live. A question goes through admission to a judge, which works out what is being asked. The verses that carry the answer are chosen and read from the signed corpus before anything is written. A model drafts, citing only those verses, and code proves every one. The draft goes back once if it cites another verse or runs long. Up to three writings that truly bear on the answer are chosen to sit beside it, and a receipt names the skills used. Skills come from the registry through a pinned playbook. Passage kinds, standpoints and reader roles are in grey: tested and not earning their place. A people-group skill is reserved and not built.";
const inherited = (id: string, at: [number, number], over: Partial<Step> = {}): Step => ({ ...SCRIPTURE_STEPS.find((x) => x.id === id)!, at, ...over });
const ANSWER_STEPS: Step[] = [
  inherited('admit', [188, 470]),
  {
    id: 'judge', name: 'Judge', color: '#ef4444', at: [304, 470],
    summary: 'What is the reader asking for? That chooses the skill, or none.',
    why: 'A definition, a question about a verse, a request for practical help and a question about another religion want different answers. The judge reads the question before anything else, so the rest of the run knows what it is for.',
    what: [
      'One call to a small model reads the question against twelve intent cards from the playbook and gives a probability for each, and for "none". Each card names a form, which is the shape of the answer.',
      'Code applies the rule. A clear pick supplies its form. If the judge is unsure, no skill applies and the question still runs answer first.',
      'A reader with a verse open still goes to the short verse companion, by a rule in code, with no judge.',
      'In testing the picks looked sensible, but a deliberately wrong skill did about as well. So the gains so far come from the design around the pick, and this step is still earning its place.',
    ],
    where: [SCRIPTURE, 'Source: <code>src/harness/intent-stage.ts</code> and <code>intent-rule.ts</code>. The judge is <code>selectByJudgment</code> from <code>@agenticprimitives/orchestration</code>, the same one the agent harness uses.'],
    by: 'A small model chooses. A rule in code accepts.',
    reads: ['The question.', 'The intent cards.'],
    leaves: ['<code>intentStage</code>: every probability, the pick, and each skill\'s version and commitment.'],
    stops: ['A failed call or an unreadable registry is a hold. The question is still answered.'],
  },
  {
    id: 'verses', name: 'Choose verses', color: '#14b8a6', at: [432, 470],
    summary: 'The passages that carry the answer, read before anything is written.',
    why: 'Written from memory, answers said things about verses that the verses do not say. Choosing the verses first and handing the writer their real text took errors from 21 to 4 in a 40-question pilot. Choosing them is also a large part of what makes an answer good.',
    what: [
      'A small model chooses two to four passages a careful teacher would open to. It sees what search found, and may add others. Sharing a word with the question does not qualify a verse.',
      'Code resolves each reference and fetches its text from the signed corpus, in the reader\'s edition.',
      'A reference that does not resolve is dropped and recorded.',
    ],
    where: [SCRIPTURE, 'Source: <code>src/harness/answer-links.ts</code> (<code>chooseVerses</code>).', LIBRARY],
    by: 'A small model chooses. Code fetches and verifies.',
    reads: ['The question.', 'The passages found by meaning.', 'The signed corpus.'],
    leaves: ['<code>chosenVerses</code>: each passage and why it was chosen, and any that did not resolve.'],
    stops: ['If this step fails, the writer is not restricted, and the proof still checks every reference.', 'At most ten verses are read.'],
  },
  {
    id: 'draft', name: 'Draft', color: '#f59e0b', at: [560, 470],
    summary: 'Answer the person, from those verses.',
    why: 'Our answers used to read as reports on whatever search returned. A plain question got a study of the sources, and one question was reinterpreted because of what was found. The writer now answers what was asked, as a knowledgeable teacher would to a friend.',
    what: [
      'The writer takes the question in its plain meaning, gives the answer in the first sentence, then the few things most worth knowing. It takes a clear position, and uses what is well established in Scripture and Christian teaching.',
      'It may cite only the verses chosen, and must not say a verse says more than its words do.',
      'It does not mention sources or what it was given, and adds no study exercise and no closing summary.',
      'The chosen form sets the shape of the answer: a definition, counsel with steps, a short list of verses.',
    ],
    where: [SCRIPTURE, 'Source: <code>src/harness/draft-prove.ts</code> (<code>ANSWER_FIRST</code>).'],
    by: 'One model call.',
    reads: ['The question.', 'The chosen verses, in the edition\'s own words.', 'The chosen form.'],
    leaves: ['The draft.'],
    stops: ['A draft cut off by the output limit fails the run and is not shown.'],
  },
  inherited('prove', [676, 470]),
  {
    id: 'revise', name: 'Revise', color: '#0ea5e9', at: [792, 470],
    summary: 'Back to the writer when code finds a problem.',
    why: 'The writer does not reliably follow what it is only told. It ran well past the length it was given. Code can see these failures, so code sends them back.',
    what: [
      'The draft goes back once if the proof found a problem, if it cites a verse that was not chosen, if it talks about what it was supplied, or if it runs well over length.',
      'If a quoted word is still not in the verse it cites, one more call deals with that alone.',
      'A revision is proved again, and kept only if it is no worse.',
    ],
    where: [SCRIPTURE, 'Source: <code>src/harness/draft-prove.ts</code> and <code>answer-links.ts</code>.'],
    by: 'A model call, only when needed. The decision to keep it is code.',
    reads: ['The problems found.', 'The cited verses\' own text.'],
    leaves: ['<code>revised</code> and <code>wordRepair</code>: the problems before and after, and whether the change was kept.'],
    stops: ['What still fails is stated on the receipt.'],
  },
  {
    id: 'further', name: 'Read further', color: '#a855f7', at: [920, 470],
    summary: 'Up to three writings that truly bear on the answer, or none.',
    why: 'The library is what this agent has that others do not, but it was crowding the answer. Moved beside the answer, a writing can be chosen against what the answer actually says, and given a reason.',
    what: [
      'After the answer is proved, a small model looks at the writings found and chooses at most three that are truly about what was asked, each with one line on what the reader will find there.',
      'None is an acceptable result: an unrelated link is worse than no link.',
      'Neither the writer nor the proof depends on them. In the pilot, 4 of 85 chosen writings were graded off-topic.',
    ],
    where: [SCRIPTURE, 'Source: <code>src/harness/answer-links.ts</code> (<code>chooseWritings</code>).', LIBRARY],
    by: 'A small model.',
    reads: ['The question and the answer.', 'The writings found, with their excerpts.'],
    leaves: ['<code>readFurther</code>: each writing, where to find it and why.'],
    stops: ['If this step fails, the answer simply has no list.'],
  },
  inherited('receipt', [1048, 470], { what: [
    'Every answer carries a run manifest (<code>ask-run/2</code>): the run\'s id, the edition, the configuration and its hash, and the versions of the code, the policy and the writer. The question is recorded as a hash.',
    'With it come the signed citations, the proof, the judge\'s choice and each skill\'s version and commitment, the verses chosen and why, what was revised, the cost, and the time each stage took.',
    "The run is kept at the agent, and its provenance is written to the agent's vault. Anyone can check a citation at <code>/verify</code>.",
  ] }),
];

const SCRIPTURE_BODY = `
<h2>Where this stands</h2>
<p>As of 5 November 2026, the picture and steps above are the design we are testing. They are not yet what answers readers. A 300-question run on fresh questions is under way, and the design goes live only if it holds up.</p>

<h2>What readers get today</h2>
<p>Today's path reads what it holds first and writes from that. It has ten steps: admit, route, choose a plan, gather, gate, draft, prove, revise, enrich and receipt. A judge chooses one answer plan or none while the agent gathers. Writings are handed to the writer, and more are added to the answer after the proof.</p>
<figure class="picture"><a href="/architecture/scripture-ask-flow.svg"><img src="/architecture/scripture-ask-flow.svg" width="1460" height="900" alt="${SCRIPTURE_ALT.replace(/"/g, '&quot;')}"></a>
<figcaption>What answers readers today. Grey arrows are the question. Pink arrows are a skill on its way in. Dashed arrows happen only when needed.</figcaption></figure>

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
<p>As of 5 November 2026, two kinds of skill shape live answers: the method for a verse, and one answer plan. The rest of the table is built and in testing. It is not live and not yet in the registry. The picture at the top shows the design being tested.</p>
<div class="table-wrap"><table class="skills-table">
<thead><tr><th>Category</th><th>What it decides</th><th>Chosen by</th><th>Drives</th><th>How many</th><th>State</th></tr></thead>
<tbody>
<tr><td><b>Ask skill</b></td><td>The method for one kind of question</td><td>A rule: a verse is open</td><td>The verse companion</td><td>9; only the verse skill drives live answers</td><td>Live</td></tr>
<tr><td><b>Answer plan</b></td><td>Which writings the writer may see, and how to answer</td><td>The judge</td><td>Gate, Draft</td><td>1: a person, body or event after the Bible</td><td>Live</td></tr>
<tr><td><b>Intent</b></td><td>What the reader is asking for. This is the card the judge reads, and it names one scope and one form</td><td>The judge</td><td>Selects the scope and the form</td><td>12</td><td>Built, not live. Places questions well</td></tr>
<tr><td><b>Scope</b></td><td>What the question is about, so what is gathered and what the writer may rely on</td><td>The intent, with the rule applied to the scope</td><td>Gather, Gate, Draft</td><td>7: a verse or passage, a book, a subject in the Bible, a word, a topic, outside the Bible, this agent</td><td>Built, not live. The answer-first design does not need it so far</td></tr>
<tr><td><b>Form</b></td><td>The shape of the answer</td><td>The intent, or the scope's default when no form clearly leads</td><td>Draft, answer checks</td><td>10: exposition, survey, profile, definition, teaching, counsel, reasoned case, verse list, describe and weigh, agent record</td><td>Built, not live. No gain over a wrong skill so far</td></tr>
<tr><td><b>Passage kind</b></td><td>How to explain this kind of text: wisdom, parable, narrative, vision, song, law</td><td>The judge, for a question about a passage</td><td>Draft</td><td>6</td><td>Built, off. No gain</td></tr>
<tr><td><b>Reader</b></td><td>How the answer is told. It changes the telling, never the teaching</td><td>A rule, from what the reader's context states</td><td>Draft</td><td>11: eight faith-journey roles and three age bands</td><td>Built, off. Most roles did no better than today</td></tr>
<tr><td><b>Standpoint</b></td><td>Whose reading leads, when the reader states a tradition</td><td>A rule, and only for a tradition whose standards the library holds</td><td>Draft</td><td>2: Reformed, Reformed Baptist</td><td>Built, off. Neither beat today</td></tr>
<tr><td><b>People group</b></td><td>The people the reader belongs to or serves</td><td>A rule, from a stable id and never a bare name</td><td>To be decided</td><td>None</td><td>Reserved, not built</td></tr>
</tbody></table></div>
<p>Four things hold across these categories:</p>
<ul>
<li><b>They compose.</b> One question gets one scope and one form, and the reader's context may add a reader and a standpoint. About fifty documents cover the range, with no skill per subject or per doctrine.</li>
<li><b>Scripture comes first.</b> Five scopes are about the Bible itself, and they are built first. The other two take questions from around it and bring them back to Scripture, with no new source or stage.</li>
<li><b>Context is stated, never guessed.</b> Nothing about the reader is inferred from how a question is worded, and a tradition the library holds no standards for is not presented as served.</li>
<li><b>Each one earns its place.</b> A category in testing changes answers only after it beats today's answer in blind comparison by two model families, and then only at the exact version pinned. Until then its choice is only recorded, and a question the judge is unsure of runs today's path.</li>
</ul>
<p>No skill in any category can switch off the proof or change the edition.</p>

<h2>What testing has shown so far</h2>
<p>From a 40-question pilot, as of 5 November 2026, with <a href="/architecture/testing-answers">a stricter test</a>. We tuned on these questions, and a 300-question run on fresh ones is under way, so read these as direction. Earlier results on this page came from weaker judging and are replaced here.</p>
<div class="table-wrap"><table class="skills-table">
<thead><tr><th>Version</th><th>Median words</th><th>Answers with an error (of 40)</th><th>Errors on the main point</th><th>Off-topic verses</th><th>Against a short-answer product: wins, ties, losses</th></tr></thead>
<tbody>
<tr><td>Today's path</td><td>410</td><td>16</td><td>4</td><td>51 of 462</td><td>2, 23, 15</td></tr>
<tr><td><b>Answer first, verses chosen first</b></td><td>about 220</td><td>4</td><td>1</td><td>14 of 244</td><td>2, 31, 7</td></tr>
</tbody></table></div>
<p><b>What worked.</b> The design, not any one skill: take the question in its plain meaning, answer first, choose the verses before writing and hold the writer to them, and keep writings beside the answer. The accuracy check names about two in three planted errors, so the true counts are higher.</p>

<h2>What we tested that did not work</h2>
<ul>
<li><b>Letting the judge choose among form skills, so far.</b> The judge's picks look sensible, but on the same questions a deliberately wrong skill did as well (39 of 40 tied). The first version of this test was also flawed: the general rules were placed after the skill and overrode it. Fixing that, and rewriting the skills to differ, did not change the result.</li>
<li><b>Rules for each kind of passage</b> (wisdom, parable, narrative, vision, song, law). On 40 fresh questions about a text, 36 tied with no rule and 39 tied with a wrong rule, and errors did not fall.</li>
<li><b>Gathering differently by scope.</b> Only questions from outside the Bible showed a modest gain. A first gain on people and places in the Bible (11 better, 2 worse) was level on the rerun (8 and 8).</li>
<li><b>More data by canonical id.</b> Answers about a person bound to a canonical id were no better than others (4 better, 5 worse).</li>
<li><b>Skills for each faith journey.</b> Together, seven role skills came out 2 better and 13 worse than the one line of guidance they would replace. They mostly added length.</li>
<li><b>Skills for a stated tradition.</b> One beat today's path once and lost six times, because the writer dropped the comparison with other traditions. The existing lookup of confessional standards already does the useful part.</li>
<li><b>Writing from memory alone.</b> Without verses in hand, errors about what a verse says went up from 6 to 11. That is why verses are now chosen and read first.</li>
<li><b>Checking paraphrases after the fact.</b> A review added at the end took five more seconds an answer and changed few of them. Choosing the verses first did far more.</li>
<li><b>Asking the writer to be brief.</b> It ran well past the length it was told, so length is now held by code.</li>
</ul>
<p>One promising result is too small to rely on: answers for a child were preferred on all 8 questions by both judges. They wait on an age band in the reader's profile.</p>

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
<li><b>Its plan is one step.</b> The host plans a single step and the flow in these pictures runs inside it. The judge chooses how that step answers, not which step to run.</li>
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
  'person signs, its check on chain, a record with a single-use code, and the code exchanged for an id_token. Arcs run above the row. ' +
  'A new app for a person already signed in goes from Recognize to Allow. An app that still holds its delegation goes straight to Token. ' +
  'A fourth arc goes from Recognize to Verify, for an app the person already allowed: the server skips the sheet when the app asks for nothing more and the stored delegation still verifies on chain, an HttpOnly cookie proves who is asking, and nothing is signed. The sheet still shows for a first Allow, an app with payments, a new session key, a request through a host, an app a member registered, and an app asking for more. ' +
  'Notes say that in Chrome the same rule applies for a key the Home holds, and that signing out ends the Home session and every app\'s silent renewal, then walks the apps with a sign-out page of their own.';

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
      'The page asks the server whether the person allowed this app before. For an app that is on, a yes goes to Verify with no sheet. See The Home remembers an Allow, below.',
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
<p class="callout"><b>From review.</b> Paul's points on remembered consent are quoted and answered one by one at the bottom of this page: <a href="#pauls-points">Paul's points, answered</a>. <a href="#next-design">The Home remembers an Allow</a>, which answers them, comes just before.</p>

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
<p>Where the browser supports FedCM, an app can ask the browser itself. The browser shows its own account chooser, reads the same Home session, and collects a thin id_token from <code>/fedcm/assertion</code>. The app then asks <code>/fedcm/grant</code> for the delegation. For a person whose key the Home holds who allowed this app before, the server hands back the delegation stored at that Allow, and nothing new is signed. Anyone else, including a passkey or wallet person and anyone who has not allowed this app, falls back to the popup and the flow in the picture. FedCM is another way to reach the same two things. It adds no authority of its own.</p>

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

<h2 id="signing-out">Signing out</h2>
<p>Each app keeps its own sign-in, so leaving the Home does not by itself end them. A sign-out at <code>/logout</code> does three things.</p>
<ol>
<li><b>It ends the Home session.</b> The session token, the <code>ap_sso</code> cookie, and the recognition cookie, whose record is deleted on the server. The next app to ask meets a credential.</li>
<li><b>It ends every app's silent renewal.</b> The server deletes the binding of every delegation on the person's records, current and older. This reaches every app with no change to it: its next renewal fails, and it has to send the person to the Home. Delegations stay on chain, because signing out is not revoking. Revoke is in Connected.</li>
<li><b>It walks the apps that can take part.</b> The Home sends the browser to each app's <code>/sso-logout</code>, and each clears its own session and sends the person back. Today that is fourteen apps: faithnet.estate, Heart Coach, Game Night, the Bible reader, Field, Church, Town, Names, Coach, OpenBook Reader, Skills, Workbench, Seed Reader and Publishing. An app is added only once it has been seen to return, because one that does not would strand the person on a page they were not using.</li>
</ol>
<p><b>What this does not do yet.</b> A token an app already holds stays valid until it expires, up to seven days, and the Home cannot recall it. So an app with no sign-out page of its own can still show the person as signed in until that token lapses or it next tries to renew. Commons runs its own but does not send the person back, and a few others have none yet. Each is a small change in that app.</p>
<p>"Not you?" is different. It ends the Home session so the person can choose who to be, and leaves their apps alone.</p>

<h2 id="next-design">The Home remembers an Allow</h2>
<p>This is spec 445, the amber arc in the picture. It went live on 5 November 2026, and it is on for every app in the registry that can use it. Sections above this one that say the sheet is always shown describe how it was before.</p>
<p>A person who allowed an app is not asked again, as long as the app asks for nothing more and what they signed still holds. Nothing is signed on that visit. The app is handed the wires it already had, each checked on chain first.</p>

<h3>Who is asking: a cookie script cannot read</h3>
<p>The server sets a recognition cookie, <code>__Secure-ap_sid</code>: HttpOnly, Secure, SameSite=Strict. It holds a random id that names a record on the server, so it is not a token and nothing can mistake it for one. It says one thing: this browser proved a credential as this person, and when. It cannot sign and cannot read a vault.</p>
<ul>
<li><b>Only where the server checked a credential.</b> A passkey, a wallet, an email or phone code, or a social sign-in. Never from a session token, and never from a link. An invitation link can be forwarded, and would plant its person in someone else's browser.</li>
<li><b>Social sign-in only in the browser that started it.</b> The start marks the browser, and a return link from Google or YouVersion opened anywhere else is refused. This is live.</li>
<li><b>Sign-out ends it on the server.</b> The record is deleted, so a copy of the cookie is worth nothing.</li>
<li><b>It lasts as long as the session, one hour.</b> After the hour a person proves a credential and then passes with no sheet: one prompt where there are two today. Whether it should last longer is still to be decided.</li>
</ul>

<h3>What is stored: what the Allow agreed to</h3>
<p>One function computes the terms from the app's registry entry: the keys the wires name, the claims the app receives, whether it may ask the person's agent, what it may read. The sheet draws its lines from those terms and the server stores them, so what the person read and what a later visit is compared with cannot drift apart.</p>
<p>The row in <code>app-grants</code> keeps the terms and every wire. It is written by the server only, and only beside the cookie of the person whose wire it is. Otherwise an app could replay a wire it already holds and record a consent nobody gave. When a new Allow replaces a wire, the old one is kept in the list until it expires, because it is still live on chain and can still be revoked.</p>

<h3>When the sheet is skipped</h3>
<p>The server decides, at a new endpoint, <code>/oidc/remembered</code>. It takes the cookie and refuses a session token. Every line must hold, and the first that fails names the reason, which is logged and counted.</p>
<ul>
<li><b>The app is switched on for this,</b> one reviewed app at a time. An app members register themselves never is, because its owner can change its key at any time.</li>
<li><b>The sign-in is a plain one:</b> <code>site-login</code> or <code>ask-as-me</code>. Never a payment, a ceremony or act-as-me, and never an app that mints a payment leg as it signs in.</li>
<li><b>No request for a new signature or a new consent:</b> no <code>session_key</code>, since a new leaf must be signed, and no <code>prompt=consent</code>. A <code>prompt=login</code> or <code>select_account</code> asks for a credential and then shows the sheet. So Gather27, which sends a session key every time, keeps its sheet.</li>
<li><b>No request through a host.</b> An Allow for Claude is not an Allow for another assistant.</li>
<li><b>The right person:</b> the person on the page is the person the cookie proved, and any name the app pinned is theirs.</li>
<li><b>An Allow is on record,</b> with no "ask me every time", for a return address the person has been sent to before.</li>
<li><b>The app asks for nothing more.</b> The same keys, and nothing beyond what was agreed. It may ask for less.</li>
<li><b>Every wire still holds, read now.</b> It is this person's, it names the registered key, it carries what the template builds today, it is not revoked, and it outlives the id_token about to be made. A chain that cannot be read means the sheet, and is not called a revocation.</li>
</ul>
<p>When any line fails the person sees the sheet, and sign-in goes on as it does today. If the app now asks for more, the sheet says "<i>App</i> is asking for more" and marks the new lines.</p>

<h3>Silent sign-in</h3>
<p>With <code>prompt=none</code> nothing is on screen, so a code would tell the app who just walked in and a leftover session would go through unseen. So the app must name the person it expects, in <code>login_hint</code>, and only that person passes. Every other outcome is the same <code>login_required</code>, so a probe learns nothing, including whether this visitor has a Home session at all.</p>

<h3>What the person controls</h3>
<p>Connected Apps, under Apps you signed into, lists what each app may do, when it last signed in, and every live wire, each with Revoke. <b>Revoke</b> is on chain, and the next sign-in shows the sheet. <b>Forget this app</b> drops what was agreed and keeps the wires listed. <b>Ask me every time</b> keeps the sheet for that app. Activity lists each sign-in that passed: "Signed in to <i>App</i>. No new permission."</p>

<h3>How it goes live</h3>
<p>It is on for every curated app that signs in with <code>site-login</code> and mints no payment. Two apps with payments and the two Home MCP clients are not. A new app has to be decided on: a test fails until it is. The browser's reuse cache stays for apps members register, which always ask.</p>

<h3>What a second review changed</h3>
<p>Another agent, working on the same problem, reviewed this page. Each point was read against the code.</p>
<ul>
<li><b>The cookie could be planted</b> through a social return link. Correct. That is why it is now bound to the browser, and why links set none.</li>
<li><b>An app's id_token could pass as a Home session.</b> Correct, and worse than it said: reading the code, an app holding a person's id_token could present it to the FedCM lane and receive a token for a different app. A session must now name the credential behind it, and the Home's own audience cannot be an app. Not tried against a live Home. That fix is live.</li>
<li><b>Terms in the vault</b> raised who can read and who writes. The server cannot read them, so it does not decide from them, and the question exposed the replay above.</li>
<li><b>"Asks for nothing more" needed more than claims.</b> The wire's caveats are now compared too.</li>
<li><b>Silent sign-in told an app who the visitor is.</b> Correct. Hence <code>login_hint</code> and the single answer.</li>
</ul>

<h3>FedCM comes under the same rule</h3>
<p>This is live. The FedCM lane used to sign a new delegation for any registered app a person picked in the browser's chooser, whether or not they had ever allowed it, and recorded it nowhere. Now it signs nothing. A person whose key the Home holds gets the wire stored at their last Allow, under the same rules as above. Everyone else goes to the popup, where the sheet is. So a first FedCM connect to an app now shows the sheet, and later ones need no prompt.</p>
<p>The proof here is still the script-readable session, because the recognition cookie is SameSite=Strict and is never sent on FedCM's cross-site requests. That is why a passkey or wallet person stays out of this lane: a stolen token must not be able to collect their wires. A token for a Home-held key could already have the Home sign, so this gives it nothing new. Demo accounts keep their fast path.</p>

<h3>Still open</h3>
<ul>
<li><b>A forwarded link.</b> An invitation link or a <code>#session=</code> link can still open a session in someone else's browser. It sets no cookie, so no sheet is skipped, and the sheet names whose session it is.</li>
<li><b>How long recognition lasts.</b> One hour, decided for now, and looked at again once the shadow numbers are in. Thirty days would mean no prompt at all on return, and a browser left signed in could enter allowed apps for a month.</li>
<li><b>Apps with no sign-out page.</b> See <a href="#signing-out">Signing out</a>.</li>
<li><b>Apps with a session key,</b> Gather27 among them. There is a draft design in spec 445: the right to ask for a leaf becomes part of the Allow. Not built.</li>
</ul>

<h2 id="pauls-points">Paul's points, answered</h2>
<p>Paul reviewed the sign-in and wrote up what he found and what he would do about it. His words are quoted below, a point at a time, each with a direct answer from the code as it stood at his review. Spec 445, <a href="#next-design">above</a>, has since changed that code, and it is live. File names are under <code>apps/home</code>.</p>

<h3>1. Is consent remembered?</h3>
<blockquote><p>"The Home never checks whether a person has already allowed an app."</p></blockquote>
<p><b>Correct.</b> Nothing on the sign-in path reads a past Allow. The row for an Allow is written by <code>server/oidc/grant.ts</code> and read in two places: <code>server/connect/app-grants.ts</code>, for the Connected Apps page, and <code>src/home/rotation.ts</code>, for credential rotation. No file under <code>src/components/onboarding</code> reads it. The Home says so itself where it handles <code>prompt=none</code> in <code>EntryExperience.tsx</code>: it answers <code>interaction_required</code> to a signed-in person because it keeps no store of remembered consent.</p>

<h3>2. Is the sheet shown every time?</h3>
<blockquote><p>"RecognizedEnroll sends every recognized sign-in straight to the 'Allow &lt;app&gt;?' sheet."</p></blockquote>
<p><b>Correct.</b> Once the session resolves, <code>RecognizedEnroll.tsx</code> goes to the sheet. The only turns before it are a session that fails, a pinned name that does not match, a passkey that needs its own host, and the organization chooser. None of them looks at past Allows.</p>
<p>There was one path with no sheet, and it was not this component. In Chrome's FedCM lane, a person whose key the Home holds got a new site delegation from <code>/fedcm/grant</code> after choosing their account in the browser's own chooser. That has since changed: see the next design, above.</p>

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
<li><b>Keep the terms the server decides from on the server.</b> The server cannot read a vault record sealed under the person's key, and a record the page wrote would prove nothing. The row stays a pointer that can be rebuilt, because the wires are the record and losing the row costs one sheet. The person's own copy belongs in their vault, to read. This changed after a second review: this page first said the terms belong in the vault.</li>
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
<p><b>Correct.</b> There are two notes and no code. <code>src/lib/sso-cookie.ts</code> carries a hardening note that a server-set HttpOnly cookie should replace the script-managed one. <code>EntryExperience.tsx</code> notes at <code>prompt=none</code> that there is no remembered-consent store yet. Neither was live at the time.</p>
<p>That has since been done: see <a href="#next-design">The Home remembers an Allow</a>, above.</p>

<h3>In short</h3>
<ul>
<li>Points 1, 2, 4 and 8 are right as written.</li>
<li>Point 3 is right for the reader and for any app that takes an ask wire. A bare site sign-in reuses its delegation in the same browser.</li>
<li>Points 5 to 7 are the right fix. The order is the cookie first, then the stored terms, then the server step that skips.</li>
<li><code>prompt=none</code> can now return a code, but only for the person the app names, for an app that is on.</li>
<li><a href="#next-design">The Home remembers an Allow</a> does all of this, with what a second review added.</li>
</ul>`;

// ───────────────────────────────────────────────────────────────── the translation harness

const TRANSLATION_ALT =
  'A flow diagram in two rows. Five things are built before any draft and feed the run from above: the frozen source, the knowledge base, ' +
  'the story and meaning of each book, the brief and skills, and the ontology. The first row is one passage: the Bible is cut into passages, ' +
  'and for each one the agent reads only the source, admits what it may use, a model drafts words and an alignment, code aligns and checks every verse, ' +
  'a model revises up to twice if a check fails, the best pass is kept, and it is proposed to the translation store. The second row is the whole edition: ' +
  'the published edition and the proposals are assembled verse by verse, with a reader model. Another model family audits the result, and a confirmed defect ' +
  'goes back to be drafted again. The edition is then published under a signed root, with a defended change row for every changed verse, and reaches the reader as a signed corpus.';

const TR_RUNTIME = 'The translation runtime (<code>apps/translation-runtime</code>), a Cloudflare Worker at <code>translation.faithnet.io</code>. The same code also runs on a local machine, which is where RBS v4.0 was drafted.';
const TR_MCP = 'The translation store and checker (<code>apps/translation-mcp</code>), an internal Worker over D1, reached only through the runtime.';

const TRANSLATION_STEPS: Step[] = [
  {
    id: 'cut', name: 'Cut', color: '#8b5cf6', at: [188, 410],
    summary: 'A book becomes chapters, and chapters become passages a model can hold.',
    why: 'A verse alone has lost its sentence, and a whole book is too much for one call. A passage is the unit where a pronoun can still find its person. Cutting at a fixed count of verses split poems across their stanzas, so the cut follows the text.',
    what: [
      'A driver walks the books in order and cuts each chapter into passages, using the section headings and acrostic marks of the source tables for their positions only, never their wording. A passage longer than 14 verses is split at a paragraph opening. The last whole-Bible cut made 3,817 passages.',
      'Each passage becomes one request to the runtime, as if someone had asked for it: "Translate Jonah 1:1-6 from the Hebrew into American English."',
      'A ledger records every passage, so a stopped run resumes where it stopped, and a passage that failed is recorded and passed over.',
    ],
    where: ['The driver, <code>scripts/translate-bible.mts</code>, on the operator\'s machine.', 'The cut itself: <code>scripts/build-pericopes.mts</code>, written to <code>source/pericopes.json</code>.'],
    by: 'Code only. No model is called.',
    reads: ['The list of books and chapters.', 'The passage boundaries.', 'The ledger of what has already run.'],
    leaves: ['One line per passage in the ledger: cost, what still blocks, and the run it made.'],
    stops: ['A spending cap ends the run (<code>--max-usd</code>).', 'A failed passage is recorded and the run goes on; it is not retried until asked.'],
  },
  {
    id: 'read', name: 'Read', color: '#3b82f6', at: [304, 410],
    summary: 'The source and what is known about it. Never an English Bible.',
    why: 'A model has read every English Bible. If it sees one, or even sees a verse\'s reference, it recites. This step decides what the drafter is shown, and nothing here is another translation\'s wording. Drifting toward an existing Bible is the failure this design is built to avoid.',
    what: [
      'Tools fetch the frozen tokens of the passage (the word, its parsing, its Strong\'s number), the dictionary sense of each word, and the decided rendering of every name through the knowledge base, so that a person\'s name follows the person and not the spelling.',
      'The verses are relabelled <code>v1</code>, <code>v2</code> and so on, so the book and chapter are not there to prompt a memory.',
      'Where the book has a story built, the drafter also gets the scene: who is on stage, who is speaking to whom, and which person each pronoun means, along with what the scene does and leaves open.',
      'Reference editions such as the WEB are held by the store for grading only, and the tool that serves them is marked as evaluation only. A test asserts their wording never reaches the drafter\'s prompt.',
    ],
    where: [TR_RUNTIME, TR_MCP, 'Source: <code>translate-plan.ts</code> in <code>packages/translation-orchestration</code>.'],
    by: 'Code only. These are tool calls.',
    reads: ['The frozen source tokens and the lexicon.', 'The knowledge base of people, places and concepts.', 'The story of the book.'],
    leaves: ['Each result, as a step on the run record.'],
    stops: ['A missing optional layer is skipped, and the record shows it was absent.', 'A request outside this agent\'s work is declined: "Translate X into Irish" is declined by code, because the agent\'s Irish English is not Gaeilge.'],
  },
  {
    id: 'admit', name: 'Admit', color: '#14b8a6', at: [420, 410],
    summary: 'Each piece of evidence is judged before a drafter may read it.',
    why: 'Some of what the agent holds was written by a model and has never been reviewed. Letting that shape a translation silently would launder a guess into Scripture. The drafter therefore reads evidence only through a receipt that says what each piece is.',
    what: [
      'The plan declares each evidence step: where it came from, whether anyone reviewed it, and what it was built from. Code judges each one for the purpose of drafting and writes a receipt.',
      'The drafter, the reviser and the critic all read through that receipt, so a piece that is withheld is withheld everywhere.',
      'Today this runs in <code>record</code> mode: every piece passes, and the receipt says what would have been withheld. An <code>enforce</code> mode withholds it.',
    ],
    where: [TR_RUNTIME, 'Source: <code>evidence-policy.ts</code> and <code>local.admit_evidence</code> in <code>packages/translation-orchestration</code>.'],
    by: 'Code only. No model is called.',
    reads: ['The output of every evidence step.', 'What the plan declares about each.'],
    leaves: ['An admission receipt with a digest, carried on the proposal.'],
    stops: ['In <code>enforce</code> mode, a rejected piece does not reach the drafter. The run continues without it.'],
  },
  {
    id: 'draft', name: 'Draft', color: '#f59e0b', at: [560, 410],
    summary: 'A model writes each verse and says which words render which token.',
    why: 'Words alone cannot be checked against a source by code. Asking the drafter to account for every token as it writes is what makes the next steps possible, because every word of English now has to point at something in the Hebrew or Greek.',
    what: [
      'One model call, on Claude Haiku 5.5, under the brief for American English. It answers with one entry per verse: the text, and one string that maps tokens to English (<code>1=In the beginning; 2-3=God created</code>).',
      'If it stops after the first verse or two, which happened on about 7% of the passages of RBS v4.0, it is now asked once more before any check reads the draft. A verse still missing is put back empty, so the checks block on it and it cannot pass by being absent.',
      'The drafter, the reviser and an optional critic are separate roles, and each can be a different model. Every run names the models it used.',
    ],
    where: [TR_RUNTIME, 'Source: <code>translate-plan.ts</code>, under the published skill <code>skill:bible-translation/translate-from-source</code>.'],
    by: 'A model. Claude Haiku 5.5, about a cent per passage or less.',
    reads: ['What was admitted.', 'The brief.', 'The verses under blind labels.'],
    leaves: ['The draft and its model, tokens and cost on the record.'],
    stops: ['A malformed answer is refused by name.', 'A model that fails fails the run, recorded as an environment failure on that run and not as a fault of the agent.'],
  },
  {
    id: 'align', name: 'Align', color: '#eab308', at: [676, 410],
    summary: 'Code tidies the bookkeeping, and never touches the text.',
    why: 'A drafter often renders a word and forgets to say so, or numbers it against its neighbour. If that went to the checks, a revision would be spent on bookkeeping, and revisions are where errors come from. So code settles what it can first.',
    what: [
      'The labels are mapped back to real verse references.',
      'A token the draft left unaligned, whose English is already in the verse, gets that alignment: a decided name, a word of its dictionary sense, or a rendering our own edition has already used. An entry that names the wrong token by number is moved to the token its own word echoes.',
      'The text is never changed, so this step cannot make a translation worse. Every repair is recorded as the checker\'s and not the model\'s.',
    ],
    where: [TR_MCP, 'Source: <code>repairAlignments</code> in <code>apps/translation-mcp/src/source.ts</code>.'],
    by: 'Code only. No model is called.',
    reads: ['The draft.', 'The source tokens, the lexicon and the knowledge base.'],
    leaves: ['The repaired alignments, each marked with how it was found.'],
    stops: ['This step is optional. If it fails, the draft goes on as written.'],
  },
  {
    id: 'check', name: 'Check', color: '#22c55e', at: [792, 410],
    summary: 'Every verse is held to its source by code, on every arm alike.',
    why: 'What can be decided by code should never be left to a model. A number, a name, a dropped "not" or a word with nothing behind it are facts about the text, and a code check gives the same answer every time.',
    what: [
      '<b>Against the source:</b> every token is accounted for, every English word traces to a token, negatives are carried, numbers compose to the right value, and names and divine names read as decided.',
      '<b>Against the knowledge base:</b> a theological concept keeps its rendering, so faith does not become "trust" because a model wanted variety.',
      '<b>Against the story:</b> speech is quoted and narration is not, a pronoun agrees with the person it means, and a question stays a question.',
      '<b>Against English:</b> a verse must end where a sentence ends. This check was added after an audit found the revision loop tacking on words.',
      'Likeness to an existing Bible is measured and reported, and is never a fault and never a reason to prefer a wording. An edition that merely differs is not better.',
      'The checker is itself tested: errors are planted in a floor text, and the suite counts how many it catches (781 of 839 today). A change to a rule is measured against this before it is kept.',
    ],
    where: [TR_MCP, 'Source: <code>runTranslationChecks</code> in <code>source.ts</code>, with <code>story-checks.ts</code>, <code>meaning-checks.ts</code> and <code>integrity-checks.ts</code>. Word lists and spelling rules are generated from the ontology.'],
    by: 'Code only. No model is called.',
    reads: ['The draft and its alignments.', 'The frozen source, the knowledge base, the story and the crux register.'],
    leaves: ['A result per verse and check: pass, fail or cannot tell, with its severity and the checker\'s version.'],
    stops: ['A blocking or major failure that a revision could fix sends the draft to Revise.', 'A check that cannot decide says so. It does not pass.'],
  },
  {
    id: 'revise', name: 'Revise', color: '#0ea5e9', at: [908, 410],
    summary: 'Up to two rounds, told exactly what failed. The riskiest step.',
    why: 'A failed check names something real often enough to be worth answering. But this is where the worst errors in RBS v4.0 came from, so it is treated with suspicion and nothing it produces is trusted just because the checks now pass.',
    what: [
      'The model sees its own draft beside the checks that failed and the instruction to fix what each names and keep what passed. Its revision goes back through Align and Check.',
      'The measured danger: told "dropped content tokens", the reviser would add a few words after a finished sentence so the token had something to point at. Every check then passed. Confirmed errors per 1,000 verses: 1.4 as first drafted, 3.9 when rewritten, and 55.6 when words were tacked on.',
      'That shape is now refused by a blocking check and named in the instructions. Removing false alarms from the checks is also part of the fix, because every false alarm is a revision that did not need to happen.',
    ],
    where: [TR_RUNTIME, 'Source: the revise loop in <code>translate-plan.ts</code>.'],
    by: 'A model. Claude Haiku 5.5 in RBS v4.0.',
    reads: ['Its draft.', 'The failing checks, under blind labels.', 'The same evidence as the draft, from the prompt cache.'],
    leaves: ['Each round, with its own checks, on the record.'],
    stops: ['This step is skipped when nothing fails that a revision could fix.', 'It stops after its rounds, whatever still fails.'],
  },
  {
    id: 'keep', name: 'Keep', color: '#ef4444', at: [1024, 410],
    summary: 'The pass with the fewest failures wins, then stricter checks read it.',
    why: 'A later revision is not always a better one. Comparing every pass under the same rules means a revision that made things worse is thrown away. Stricter rules then apply once, because a word no token accounts for may be worth a revision but must not be proposed as clean.',
    what: [
      'The draft and each revision are compared by their strict failures, and the best is kept.',
      'The kept pass is checked once more with the strict rules, under which a word no token accounts for blocks. Matthew 10:4 was once proposed with "Judas the son of James", which belongs to Luke\'s list, and this is the check that stops it.',
      'The comparison is per passage, so a good verse can be lost with a bad passage. A per-verse rule that keeps a verse\'s earlier wording unless its revision improved it has been tested on 120 verses, and the result is not yet good enough to turn on.',
    ],
    where: [TR_RUNTIME, TR_MCP, 'Source: <code>local.best_pass</code> in <code>packages/translation-orchestration</code>.'],
    by: 'Code only. No model is called.',
    reads: ['Every pass and its checks.'],
    leaves: ['The kept draft and the strict checks over it.'],
    stops: ['Failures that remain are not hidden. They go with the proposal, and the verse says so.'],
  },
  {
    id: 'propose', name: 'Propose', color: '#a855f7', at: [1164, 410],
    summary: 'A proposal with its evidence. Only a person could ever approve it.',
    why: 'A model\'s output is a proposal and stays one. Recording it with everything behind it means a later reader, or a later release, can ask why any verse reads as it does.',
    what: [
      'The translation is written to the store with a decision record, its checks, its admission receipt and a commitment over its content.',
      'Its status is decided by code: <code>checked</code> when nothing blocks, <code>draft</code> otherwise, and <code>model-reviewed</code> if a second model family also accepted it. <code>approved</code> takes a person, and no verse of RBS has it.',
      'The driver keeps the whole run record, every step with its inputs and cost, outside any repository.',
    ],
    where: [TR_MCP, 'The run records: the operator\'s eval store.'],
    by: 'Code only. No model is called.',
    reads: ['The kept draft, its checks and the receipt.'],
    leaves: ['A proposal in the translation store.', 'A full run record, in the shape of a provenance graph.'],
    stops: ['A proposal for an edition the store does not have is refused.'],
  },
  {
    id: 'assemble', name: 'Assemble', color: '#6366f1', at: [420, 700],
    summary: 'A new edition changes a verse only where it is better on the evidence.',
    why: 'A new draft is not an improvement just because it is new, and every changed verse is something a reader who knew the last edition must be able to trust. So a release starts from the published edition and takes as little as it can.',
    what: [
      'For each verse, the published wording and the new draft are scored under one checker and one reader. The draft replaces it only when nothing blocks, the score is lower, and it is no less clear. Ties keep what was published.',
      'A reader model is shown only our English, never the source or another Bible, and says who does what to whom. It keeps Job 36:33 from reading as passed when it is not a sentence.',
      'Each verse gets three tiers, with no single "passed": <b>accounted</b> (every source word is there), <b>coherent</b> (a reader can follow it) and <b>disclosed</b> (a hard verse has its note, a lost text its gap). A verse is ready only with all three.',
      'A register of known difficulties says what each hard verse owes the reader, and a model writes those notes under code checks: no five-word run of any held English Bible, and no source later than the book.',
    ],
    where: ['Scripts on the operator\'s machine: <code>assemble-v4-release.py</code>, <code>assemble-patch-release.py</code>, <code>edition-tiers.py</code>, <code>coherence-scan.py</code> and <code>build-reader-notes.py</code>.'],
    by: 'Code decides. Models read and write notes: Claude Haiku 5.5.',
    reads: ['The published edition.', 'The proposals.', 'The crux register.'],
    leaves: ['A release: one chosen verse per source verse, each with its tiers, note and open checks.'],
    stops: ['A release is refused if a replaced verse reads less clearly than the one it would replace.'],
  },
  {
    id: 'audit', name: 'Audit', color: '#ec4899', at: [660, 700],
    summary: 'Another model family reads the whole Bible. Fixes pass by rule.',
    why: 'Checks can only find what they were written to find. No person reviews this edition, so the nearest thing to a second reader is a model from another family, and that model is wrong often enough that its findings need checking too.',
    what: [
      'GPT-5.6 Luna reads every passage beside the source and files findings. Claude Haiku 5.5 verifies each serious one, and code separately finds verses that end in a fragment. The whole Bible cost about $21.',
      'For each confirmed defect, the verses around it go back to Read, with the finding put to the drafter as a claim to test against the tokens, not as a fact.',
      'A new verse replaces the published one only if: it passes the code checks with no new failure; the verifier reads the finding as gone, twice; a blind judge of the other family does not prefer the old verse in either order; and the reader finds it no less clear. Refusing a verse in which the judge notes a major error was added on 2026-11-05 and is not yet in the script: it was applied by hand to the last pass, and ten verses published before it carry such a note.',
      'A defect not fixed stays visible: the verse is published as open, with the reason.',
      'This step is the least settled. Given 120 errors planted by code, the verifier confirmed 50, and only 1 of 30 lost negatives, with no false alarms on the unaltered verses. So the defect list is a floor, and a verse can pass and still be wrong. Reading 11 accepted verses against their tokens held 2 back (Job 19:13 had changed the verb\'s person).',
    ],
    where: ['Scripts on the operator\'s machine: <code>verify-suspects.mts</code> and <code>redraft-defects.mts</code>.', 'The list of open defects: <code>docs/bible-translation/rbs-v4-defects-spec-2026-11-04.md</code>.'],
    by: 'Two model families, under a rule written in code.',
    reads: ['The chosen verses and their source.', 'The findings.'],
    leaves: ['Findings and verdicts.', 'Accepted replacements, and an open list with the reason for each refusal.'],
    stops: ['Every paid pass has a quoted cost and a hard cap.', 'A verse that fails the rule keeps its published wording.'],
  },
  {
    id: 'publish', name: 'Publish', color: '#10b981', at: [900, 700],
    summary: 'A signed root over every verse, and every change defended.',
    why: 'A reader should be able to prove a verse is the one this edition published, and see why it differs from the last. Verses are committed one by one so that a single verse can be proved without the rest.',
    what: [
      'Every verse gets a SHA-256 commitment and the commitments form a Merkle tree, whose root identifies the release under <code>rbs-translation.svc</code>. Notes and interpretation records sit beside the verse, outside the tree, so correcting a note does not move the root.',
      'Each changed verse gets a row: before, after, the reason and the evidence, projected from the records.',
      'A small release is imported as only the rows that differ, in one atomic file. Production is then read back and held to the full build row by row. A success response is not treated as proof.',
      'The release is recorded in the ontology and the editions registry, and the reader form is rebuilt from the published verses.',
    ],
    where: ['The library Worker (<code>demo-bible-mcp-faithnet</code>) at <code>rbs.faithnet.io</code>, over D1.', 'The Seed reader, at <code>seed-reader.faithnet.io</code>.', 'Build: <code>build-rbs-corpus.ts</code> and <code>patch-import-sql.py</code>.'],
    by: 'Code only. The owner decides when a release goes out.',
    reads: ['The release.', 'A dump of what production holds.'],
    leaves: ['A signed corpus: verses with proofs.', 'A status on every verse: checks passed, or open and why.', 'Change rows in the workbench.'],
    stops: ['An import that is not a patch is refused.', 'A release is not reported as done until production reads back equal to the full build. A correction is a new release, with its own root.'],
  },
];

const TRANSLATION_BODY = `
<p class="quiet">Companion pages: <a href="/architecture/translation-skills">how a passage's category chooses its translation skill</a>, and <a href="/architecture/testing-translations">how we test the quality of a translation</a>.</p>
<h2>How this differs from answering a question</h2>
<p>The <a href="/architecture/scripture-ask">Scripture Agent's ask</a> and this harness share a shape: gather what is held, a model writes, code proves, revise if needed, and leave a record. Three things are different.</p>
<ul>
<li><b>Nobody is waiting.</b> The ask begins with a person and ends with an answer in seconds. Here a driver asks for each of about 3,800 passages, over hours, and the result is read later by people who never asked.</li>
<li><b>The unit is not the deliverable.</b> A run produces a proposal for one passage. What a reader receives is an edition, so there is a second flow above the first, which decides verse by verse what the edition says.</li>
<li><b>The source is a fixed text, and the danger is memory.</b> An ask wants everything relevant. A translator must be kept away from the most relevant thing there is, the existing English Bibles, because a model that sees one recites it.</li>
</ul>
<h2>Books, chapters and verses</h2>
<p>Each level has a job. The <b>book</b> is where the story is built: who the people are, what they are called, and how a book's own key words behave. The <b>passage</b> is what a model drafts, because a sentence and its pronouns need their neighbours. The <b>verse</b> is what everything is judged, chosen, committed and proved at. A passage is drafted whole, and a release can then take one verse of it and leave the rest.</p>
<h2>What is built before any draft</h2>
<ul>
<li><b>The frozen source.</b> Hebrew, Aramaic and Greek tokens with their parsing, kept with a commitment for every verse. A change to the source is a new edition, not an update.</li>
<li><b>The knowledge base.</b> The people, places and concepts of the Bible, in the skills ontology. Consistency is bound to the referent, not to an English word: Simon's son Judas is one entry in all four Gospels, and the patriarch is another.</li>
<li><b>The story and meaning.</b> For each book, the scenes, who is present and who each pronoun means. It is built from the source and sources of the book's own time, and code removes any sentence resting on a later interpretation. It decides structure, such as who is speaking, and never wording.</li>
<li><b>The brief and skills.</b> What the drafter is told, as published skills under the <code>bible-translation</code> domain.</li>
<li><b>The ontology.</b> Spelling rules, number words, free words and check kinds are generated from it, and a repository check refuses any drift.</li>
<li><b>A taxonomy of passage forms.</b> One hundred forms, such as genealogy, lament and case law, are held in the ontology as values. The category of a passage can choose a skill, and the skill can change how the passage is drafted, aligned, checked, revised and kept. The checks chosen this way are measured to work; the drafting rules are not yet, and are off. <a href="/architecture/translation-skills">How a passage's category chooses its translation skill</a> has the whole strategy.</li>
</ul>
<h2>How a change is measured</h2>
<p><a href="/architecture/testing-translations">How we test the quality of a translation</a> has the whole method and the number of verses in each set. In brief: the harness carries its own tests. Experiments run arms side by side over locked sets of passages, including a floor (the tables' word-by-word glosses) and a ceiling (a published human translation), so a score means something. Errors are planted to measure the checker. A change is accepted by a blind judge on a frozen set of hard passages, because this project's own checks have rewarded changes that a blind reader preferred less.</p>
<h2>Where it stands</h2>
<p>The edition is RBS, a draft model-made translation from the Hebrew, Aramaic and Greek under CC BY 4.0. The current release, <code>2026-11-05-v4.0.2</code>, has 31,085 verses, of which 26,445 are ready and 4,640 are published as open, each saying what is open. <b>No person has reviewed it.</b> The status on a verse says what the machine checked and nothing more.</p>
`;

// ───────────────────────────────────────────────────────────────── categories and skills in the translation harness

const TSKILL_ALT =
  'A flow diagram over a grid. Once, on the source, a model reads a passage whole and names its category, one of twelve families, which is kept as data; ' +
  'outside evidence such as study notes reaches that step only and never the drafter. Code selects a skill from the category, or holds at the general plan. ' +
  'The skill sets five steps of the run for one passage: Draft, Align, Check, Revise and Keep, and the run records the skill and why. ' +
  'The grid below has a row for the general plan and for the records, law, poetry and argument skills, and a column for each of the five steps, ' +
  'saying what each skill changes there. A coloured border says whether a cell is as today, built and measured to catch planted errors, built and tested but off, or proposed.';

const TSKILL_STEPS: Step[] = [
  {
    id: 'categorise', name: 'Categorise', color: '#8b5cf6', at: [330, 220],
    summary: 'A model reads the passage whole, in the source, and names what kind of text it is.',
    why: 'A genealogy goes wrong when a relation is turned around. A law goes wrong when a condition is lost. A poem goes wrong when two lines are folded into one. A general plan watches for all of these equally, which means it watches for none of them closely. Knowing the kind of text is what lets the rest of the run look in the right place.',
    what: [
      'A model is shown the whole passage in Hebrew, Aramaic or Greek and returns its units: which verses belong together, which of twelve families each unit is, which of one hundred forms if it can tell, and how confident it is.',
      'It may also be shown outside evidence about the passage, such as section headings and study notes. That evidence goes to this step and nowhere else, so no edition or tradition can lead the wording of a translation.',
      'The category belongs to the source, not to English. It is decided once and serves every language the passage is translated into.',
    ],
    where: ['A script on the operator\'s machine (<code>scripts/select-passages.mts</code>), with the label set and its validation in <code>scripts/lib/passage-forms.mts</code>.', 'The families and forms are values in the skills ontology (<code>scr:LiteraryGenre</code>), generated from a frozen guide.'],
    by: 'A model (Claude Haiku 5.5) proposes. Code validates every unit: a known family, a known form, verses inside the passage, no overlap.',
    reads: ['The source tokens of the whole passage.', 'The list of families and forms, with their cues.', 'Outside evidence, when there is any.'],
    leaves: ['The passage\'s units, each with a family, a form where known, and a confidence.'],
    stops: ['A unit that names an unknown family or form, or verses outside the passage, is dropped.', 'With no valid unit the passage has no category, and the general plan runs.'],
  },
  {
    id: 'select', name: 'Select', color: '#14b8a6', at: [770, 220],
    summary: 'Code turns the category into one skill, or holds at the general plan.',
    why: 'The model is good at saying what a passage is and should not also decide what to do about it. Selection is a small, fixed rule, so the same category always runs the same plan, and a doubtful category runs the plan that is known.',
    what: [
      'The family that covers most of the passage\'s verses chooses the skill. Records choose the records skill; law and procedure choose the law skill; songs and prayers choose the poetry skill; argument chooses the argument skill.',
      'Selection holds at the general plan when confidence is low, when no family covers a majority, or when the family has no skill yet. Narrative, wisdom, teaching, prophecy, vision and letters hold today.',
      'A hold changes nothing about the run. That is tested: a held passage produces the same plan as a passage with no category.',
    ],
    where: ['<code>selectPassageSkill</code> in <code>packages/translation-orchestration/src/passage-skills.ts</code>, beside the table of skills (<code>PASSAGE_SKILLS</code>).'],
    by: 'Code only. No model is called.',
    reads: ['The validated units and their confidence.', 'The table of skills and the families each one serves.'],
    leaves: ['The skill, the reason for it in a sentence, and whether it was a hold.'],
    stops: ['Low confidence, no majority, or a family without a skill: the general plan runs.'],
  },
  {
    id: 'draft', name: 'Draft', color: '#f59e0b', at: [330, 480],
    summary: 'The skill may add a few rules for this kind of text to what the drafter is told.',
    why: 'This is the step where a category could help most, and the step where it has been hardest to show. A drafter that knows it is reading case law might keep each consequence with its condition. A drafter given more to read might also attend less to the source in front of it.',
    what: [
      'Each skill carries a short section, "Rules for this kind of text": four or five rules about what this kind of text must not lose. For records: keep each relation pointing the way the source points it. For law: keep must, may and must not apart. For poetry: never fold a second line into the first. For argument: do not turn a reason into a result.',
      'The rules are added to the drafter\'s instructions for that passage. Nothing is removed, and the drafter still sees only the source, the dictionary and the decided names.',
      '<b>This is off.</b> A first test on 32 passages favoured it (more faithful on 18 verses against 10). A second test on new passages, run twice, did not confirm it: one pair favoured the skill and one favoured today\'s plan. A looser version, a paragraph about the whole family, was clearly worse.',
      'A review of those tests found they were not a fair trial of the idea. What was added was a paragraph of four or five lines, placed after about 30,000 characters of source material, to a drafter that is told to write at once without reasoning. Three of the four paragraphs changed the wording no more than two identical runs differ. Where a rule did change the wording it did harm more often than good: "use the plain word for a ritual term" turned a Nazirite\'s <i>separation</i> into a <i>vow</i>.',
      'So the next form is different: a short sheet taken from the source by code before drafting, with the lines of a poem or the cases of a law already marked, and one or two rules that say how to use it.',
    ],
    where: ['The skill files: <code>skills/bible-translation/translate-records</code>, <code>translate-law</code>, <code>translate-poetry</code> and <code>translate-argument</code>.', 'The plan adds them as <code>formGuidance</code> in <code>translate-plan.ts</code>.'],
    by: 'A model drafts (Claude Haiku 5.5). Code decides which rules it is shown.',
    reads: ['The source tokens, the dictionary and the decided names, as in every run.', 'The skill\'s rules, when the skill plan is on.'],
    leaves: ['A draft and its alignment, as in every run.'],
    stops: ['A hold adds nothing.', 'With the skill plan off, no rules are added for any passage.'],
  },
  {
    id: 'align', name: 'Align', color: '#eab308', at: [550, 480],
    summary: 'The skill names what the alignment must account for, beyond every content word.',
    why: 'The alignment is how code sees a translation: which English words answer which source words. Every check reads it. If a kind of text depends on particular words, those are the words whose owners must be exact.',
    what: [
      'Today the alignment is made the same way for every passage: the drafter returns it with the draft, and code parses it and reports any source word with no English owner.',
      'For records this is already used by kind. The relation check reads the names inside the aligned words on each side of "son of", so a relation turned around is seen even when every name is present.',
      'For the other three skills this is the proposal, not yet built: a law\'s every "if" and "unless", a poem\'s every line, and an argument\'s every connector must each have an owner in the English, and a missing one is named to the reviser.',
    ],
    where: ['Parsing and the missing-owner count: <code>local.unblind</code> in <code>packages/translation-orchestration/src/tools.ts</code>.', 'The category checks that read it: <code>apps/translation-mcp/src/skill-checks.ts</code>.'],
    by: 'Code only. The alignment itself was written by the drafter.',
    reads: ['The drafter\'s alignment, one line per verse.', 'The source tokens and their parsing.'],
    leaves: ['For every verse, which English words answer which source words.'],
    stops: ['A draft that leaves many source words unowned is asked for again before any check runs.'],
  },
  {
    id: 'check', name: 'Check', color: '#22c55e', at: [770, 480],
    summary: 'Each kind of text has checks that only it runs. This is the part measured to work.',
    why: 'A check written for law misreads everything that is not law. Run on every passage, it raises false alarms; run only where the category says, it finds what the general checks cannot.',
    what: [
      '<b>Relation direction</b>, for records. With errors planted by code it caught 33 of 37 turned relations, where today\'s checks caught none, and raised no alarm on 91 clean verses.',
      '<b>Legal condition</b>, for law. It caught 26 of 27 lost conditions, where today\'s checks caught 9, with 2 alarms on 100 clean verses.',
      'Run over 1,886 published verses of every kind, the two raised 17 alarms and all 17 were false: an oath, an "except", a rhetorical question. That is the evidence that the category must choose the check.',
      'The review found a gap the planted errors had hidden. In the law passages of the second test every case opens with the Hebrew word for "when", which the condition check does not count, so it never fired there. The check is being moved from a count per verse to the exact source word: the English aligned to this "when" must say "when" or "if".',
      'Argument uses the connector and question checks that already run on every passage. Poetry has no check of its own yet.',
      'The checks can now run from the category alone, with nothing added to what the drafter is told. That separates the part that measures well from the part that does not.',
    ],
    where: ['<code>apps/translation-mcp/src/skill-checks.ts</code>, called by the checker only when the plan names them.', 'The category-only option: <code>checksOnlyFor</code> in <code>passage-skills.ts</code>.'],
    by: 'Code only. No model is called.',
    reads: ['The draft, its alignment and the source tokens.', 'The list of checks the skill names.'],
    leaves: ['Per verse, what failed and why, in words the reviser can act on.'],
    stops: ['A failing category check sends the draft to revision, as a failing general check does.'],
  },
  {
    id: 'revise', name: 'Revise', color: '#0ea5e9', at: [990, 480],
    summary: 'The skill sets how many rounds a draft may take, and which failures send it back.',
    why: 'Revision repairs some verses and damages others. How much of it a passage should get depends on the kind of text: a list can be corrected word by word, and a poem that is revised twice tends to come back as prose.',
    what: [
      'Records, law and argument take up to two rounds, as the general plan does. Poetry takes one.',
      'A skill may let a check send a draft back that otherwise only reports. For argument, a connector or a question that changed its force sends the draft back; in the general plan those are reported and the draft stands.',
      'The reviser is told what failed and nothing else about the kind of text. A narrower revision, in which only the words a check names may change, was tested and did worse than the full revision (preferred on 9 verses against 22), so the full revision stays.',
    ],
    where: ['The settings per skill: <code>PASSAGE_SKILLS</code> and <code>planOptionsFor</code> in <code>passage-skills.ts</code>.', 'The revise steps: <code>translate-plan.ts</code>.'],
    by: 'A model revises (Claude Haiku 5.5). Code decides whether it runs and how often.',
    reads: ['The draft and the failing checks.', 'The number of rounds the skill allows.'],
    leaves: ['A revised draft, checked again in the same way.'],
    stops: ['No failing check: no revision.', 'The rounds the skill allows are used up.'],
  },
  {
    id: 'keep', name: 'Keep', color: '#ef4444', at: [1210, 480],
    summary: 'The pass with the fewest failing checks is kept, and the skill\'s checks count.',
    why: 'A later draft is not always a better one. Keeping the best pass means a revision that made things worse is thrown away. What "best" means should include the checks that matter for this kind of text.',
    what: [
      'Code compares every pass of the passage by its failing checks and keeps the one with the fewest. A tie goes to the earlier draft.',
      'When a skill names checks, they are part of that count. A records passage whose revision fixed a missing word and turned a relation around does not win.',
      'Two finer rules were tested and are not used: keeping the best pass verse by verse, and drafting three times and picking per verse. Neither beat a second run of the plain plan on a sealed set.',
    ],
    where: ['<code>local.best_pass</code> in <code>packages/translation-orchestration/src/tools.ts</code>.'],
    by: 'Code only. No model is called.',
    reads: ['Every pass of the passage and its check results.'],
    leaves: ['One pass, and which one it was.'],
    stops: ['A pass with a broken sentence can never be kept over one without.'],
  },
  {
    id: 'record', name: 'Record', color: '#a855f7', at: [1390, 480],
    summary: 'The run says which skill it used and why.',
    why: 'A translation made under a skill should be traceable to it. When a verse is questioned later, the record shows whether it was drafted as law or as narrative, and on what evidence.',
    what: [
      'The run\'s record carries the skill, the sentence that explains the choice, and whether it was a hold. It also says when only the checks were chosen by category.',
      'Once a gain is shown, the category itself is stored with the passage in the ontology, so that every later run, in any language, starts from it.',
    ],
    where: ['The <code>selection</code> step of the plan, kept in the run record with every other step.'],
    by: 'Code only.',
    reads: ['The selection.'],
    leaves: ['The skill and the reason, on the run and on the proposal it makes.'],
    stops: ['Nothing stops here.'],
  },
];

const TSKILL_BODY = `
<h2>Where this fits</h2>
<p>This page goes with <a href="/architecture/translation-harness">How the translation agent translates the Bible</a>. That page follows one passage through the whole run. This one is about a single idea inside it: that the kind of text should change how five of those steps work.</p>
<h2>The categories</h2>
<p>The categories come from a guide of one hundred passage forms in twelve families. They are held in the skills ontology as values, not as new classes, so they can be revised without changing the model.</p>
<div class="table-wrap"><table class="skills-table">
<thead><tr><th>Family</th><th>What it covers</th><th>Forms</th><th>Skill today</th></tr></thead>
<tbody>
<tr><td>Records and lists</td><td>Genealogies, censuses, itineraries, inventories</td><td>8</td><td>Records</td></tr>
<tr><td>Law and covenant</td><td>Commands, case law, covenants, transactions</td><td>8</td><td>Law</td></tr>
<tr><td>Procedures</td><td>Sacrifice, purity, building and measuring</td><td>6</td><td>Law</td></tr>
<tr><td>Songs and poems</td><td>Hymns, laments, thanksgiving, love poetry</td><td>12</td><td>Poetry</td></tr>
<tr><td>Prayer</td><td>Petition, intercession, confession, blessing</td><td>7</td><td>Poetry</td></tr>
<tr><td>Argument and exhortation</td><td>Exposition, objection and reply, ethical appeal</td><td>7</td><td>Argument</td></tr>
<tr><td>Narrative</td><td>Events, people, settings, point of view</td><td>12</td><td>General</td></tr>
<tr><td>Wisdom</td><td>Proverbs, instruction, reflection</td><td>8</td><td>General</td></tr>
<tr><td>Teaching</td><td>Parables, sayings, public address, dialogue</td><td>8</td><td>General</td></tr>
<tr><td>Prophetic discourse</td><td>Oracles, disputes, appeals, symbolic acts</td><td>9</td><td>General</td></tr>
<tr><td>Vision and apocalypse</td><td>Dreams, symbolic visions, interpretations</td><td>7</td><td>General</td></tr>
<tr><td>Letters</td><td>Greetings, thanksgivings, requests, closings</td><td>8</td><td>General</td></tr>
</tbody>
</table></div>
<p>There are four skills and not one hundred plans, for two reasons. The model names the family correctly about nine times in ten on clear passages and the form about three times in four, and does worse on hard ones, so one hundred labels are finer than it can hold. And most forms do not need different handling: a census and a genealogy fail in the same way.</p>
<p>Twelve further skills in the guide cut across the families: names and kinship, quantities and dates, legal scope, poetic structure, argument logic, figurative language, wordplay and others. They describe a feature a passage has, not what kind of passage it is. A psalm with a number in it has both.</p>
<h2>What a skill definition contains</h2>
<p>A skill is a short published file and a row of settings. The strategy is that each skill answers the same six questions, one for the selection and one for each step it may change.</p>
<div class="table-wrap"><table class="skills-table">
<thead><tr><th>Question</th><th>Step</th><th>Example: law</th></tr></thead>
<tbody>
<tr><td>When does it apply?</td><td>Select</td><td>Most of the passage is law or procedure, with confidence</td></tr>
<tr><td>What must this text not lose?</td><td>Draft</td><td>Conditions, parties, consequences, and their order</td></tr>
<tr><td>Which source words must each have an owner?</td><td>Align</td><td>Every "if", "unless" and "when" of a case</td></tr>
<tr><td>Which checks are its own?</td><td>Check</td><td>Legal condition</td></tr>
<tr><td>What sends a draft back, and how often?</td><td>Revise</td><td>A lost condition; up to two rounds</td></tr>
<tr><td>What counts when the best pass is chosen?</td><td>Keep</td><td>The condition check, with the general checks</td></tr>
</tbody>
</table></div>
<p>Two rules hold for every skill. It may add care and may not remove anything the general plan requires, so a wrong category costs little. And it may shape structure but never wording: no skill names an English word to prefer, and none is shown an existing translation.</p>
<h2>What has been measured</h2>
<div class="table-wrap"><table class="skills-table">
<thead><tr><th>Part</th><th>Result</th><th>State</th></tr></thead>
<tbody>
<tr><td>Category checks, on planted errors</td><td>Relations: 33 of 37 caught. Conditions: 26 of 27 caught. Few alarms on text of their own kind.</td><td>Kept, scoped to their kind</td></tr>
<tr><td>The same checks on every kind of text</td><td>17 alarms in 1,886 verses, all false</td><td>Never run unscoped</td></tr>
<tr><td>Skill rules for the drafter, first test</td><td>More faithful on 18 verses, less on 10, of 317</td><td>Promising</td></tr>
<tr><td>Skill rules for the drafter, second test</td><td>Two repeats disagreed: 22 to 11 for the skill, then 25 to 20 against</td><td>Not confirmed. Off</td></tr>
<tr><td>A paragraph about the family, in place of rules</td><td>Less faithful on 12 verses, more on 4</td><td>Rejected</td></tr>
<tr><td>Revising only the words a check names</td><td>Preferred on 9 verses, the full revision on 22</td><td>Rejected</td></tr>
</tbody>
</table></div>
<p>Every comparison is read by a blind judge from another model family, in both orders, beside a second run of the unchanged plan. That second run matters: two identical runs reword about nine verses in ten, and differ in score by about as much as some of these arms did.</p>
<h2>What a review found</h2>
<p>The four skills were written quickly, so a stronger model was asked to read them against the verses where they won and lost. It read every run of the second test. Its main findings:</p>
<ul>
<li><b>The test was of a paragraph, not of a plan.</b> The skill's own checks never fired in 56 runs, and the rounds barely differed, so the only thing tested was four or five lines of advice.</li>
<li><b>One open decision outweighed all four skills.</b> In Numbers 6 the source says "a man or a woman". One run wrote "he" and another "they", and the judge charged about one major error a verse for the difference. That single passage produced the law skill's best result in one pair and its worst in the other.</li>
<li><b>The rules restated what the drafter is already told.</b> "Keep every condition" gives a drafter nothing to do that "account for every word" did not. The drafter was already carrying the conditions and relations the rules asked for.</li>
<li><b>The judge disagrees with itself.</b> Scoring the same drafts twice, it agreed on which verses were wrong about a third of the time. Counting errors by verse cannot show a small gain.</li>
</ul>
<h2>The categories proposed in their place</h2>
<p>The one hundred forms say what a text is. Most of them do not change what a translator does: a praise hymn and a thanksgiving song are translated the same way. The proposal is to cut by how the text is built, which code can read from the parsing and the accents, with no model deciding.</p>
<div class="table-wrap"><table class="skills-table">
<thead><tr><th>Way of rendering</th><th>What the translator does differently</th><th>Read by code from</th></tr></thead>
<tbody>
<tr><td>List</td><td>Names, relations and numbers exactly, in list form</td><td>The share of names, numerals and kinship words</td></tr>
<tr><td>Ruling</td><td>Case and consequence; shall, shall not and let; one pronoun for the person the rule is about</td><td>Directive verb forms and the words that open a case</td></tr>
<tr><td>Verse</td><td>Where each line ends; a second line that leans on the first line's verb</td><td>The Hebrew accents</td></tr>
<tr><td>Reasoning</td><td>Each linking word by its kind; sentences longer than a verse</td><td>The Greek linking words and sentence stops</td></tr>
<tr><td>Narrative with speech</td><td>The order of events, who is meant, where a speech opens and closes</td><td>Everything else. This is the default</td></tr>
</tbody>
</table></div>
<p>Law and procedure show why. Leviticus 8 tells a rite as something that was done, and Leviticus 15 gives orders. By subject both are law, and the first selector sent both to the law skill. By verb form the first is narrative and the second is a ruling.</p>
<p>Finer detail comes from features that cross these five and are also read by code: a speech already open at the first verse, quantities, quoted Scripture, the comparison words of a vision. A passage has one way of rendering and as many features as it contains. The one hundred forms stay as vocabulary for selecting and scoring, and do not reach the drafter.</p>
<h2>How a category should act</h2>
<ul>
<li><b>A sheet, not advice.</b> Before drafting, code prints a few lines for the passage: the lines of a poem, the cases and ruling verbs of a law, the names of a list in order. The drafter cannot reason before it writes, so the analysis has to arrive done.</li>
<li><b>Checks at the exact word.</b> "The English aligned to this word says if or when" is exact where a count per verse is not. A category also switches off general checks that misfire on its kind of text.</li>
<li><b>Decided terms.</b> About thirty words for offerings, rites and sacred times drift between runs. Deciding them once removes more difference than any rule did.</li>
</ul>
<p>None of this is proven. Two earlier results in this harness count against adding material to what the drafter reads, and the review does not expect a large gain from any category.</p>
<h2>The approach now taken: decide once, then check</h2>
<p>The review's largest finding was not about categories. The biggest differences between two runs of the same plan were choices that English forces and the source does not make. Left open, each one moved a whole passage, and the judge charged it as an error on every verse. So the first step was to decide them, once, for the whole edition.</p>
<div class="table-wrap"><table class="skills-table">
<thead><tr><th>Where</th><th>The edition now writes</th><th>What happened before</th></tr></thead>
<tbody>
<tr><td>A rule about anyone, man or woman</td><td>they, them, their, with one pronoun through the passage</td><td>Numbers 6: one run wrote "he" 37 times, another "they" 36 times</td></tr>
<tr><td>A people spoken of in the singular</td><td>they and them after the first mention</td><td>Deuteronomy 31: "it", "him" and "them" for one people</td></tr>
<tr><td>Someone speaking to the LORD by name</td><td>"Answer me, LORD."</td><td>Psalm 119: "the LORD" inside nine of twelve addresses, as in "answer me, O the LORD"</td></tr>
<tr><td>The verb of a ruling</td><td>shall and shall not</td><td>Numbers 9: "are to" and "must" six times in one run, "shall" in the other</td></tr>
<tr><td>Quotation marks</td><td>open where a speech begins, close where it ends</td><td>Numbers 29 starts inside a speech; four runs punctuated it four ways</td></tr>
</tbody>
</table></div>
<p>These are in the edition's brief, which is what the drafter is told on every passage, and the blind judge is told them too. On the six passages they came from, one run after the change: Numbers 6 reads "they" 39 times and "he" twice, Psalm 119 reads "answer me, LORD", and Numbers 9 says "shall" throughout. Quotation marks are not solved by an instruction. A drafter cannot know that a speech was already open before its first verse, so that fact has to be printed for it by code.</p>
<p>The second step was a set of false alarms. Each one sent a correct verse back for revision, and a revision rewrites every verse of the passage.</p>
<ul>
<li><b>"They" for one person.</b> The agreement check failed every verse that said "they" of the Nazirite, which is exactly what the edition now asks for. It accepts it.</li>
<li><b>"Its" taken for a person.</b> "Its appointed time" means the Passover's. The check read "its" as a wrong pronoun for the LORD. An English "it" is no longer counted against a person.</li>
<li><b>"Two" from a dual.</b> Hebrew says "between the two evenings" with the ending of one word. The number check called "two" an added number. A dual now carries its own two.</li>
<li><b>An indirect question.</b> "Let me hear what the LORD commands" is not a question. The check wanted a question mark, and one run added "Is it?" to satisfy it.</li>
</ul>
<p>Measured at no cost: all 781 planted errors are still caught, and 14 false alarms are gone from 1,115 replayed verses.</p>
<h2>What comes next</h2>
<ul>
<li><b>Print what the drafter cannot know.</b> Whether a speech is open at the first verse and runs past the last.</li>
<li><b>Decide about thirty terms</b> for offerings, rites and sacred times that drift between runs.</li>
<li><b>The room was measured, free.</b> On a thousand verses already drafted, names are carried 97 to 100% of the time and no case word was found dropped, so the list and ruling categories have nothing to gain there. Only the line breaks of verse have room: 64 to 70% of main pauses are marked in the English.</li>
<li><b>Then one test with a better ruler</b>, described in <a href="/architecture/testing-translations">How we test the quality of a translation</a>.</li>
</ul>
`;

// ───────────────────────────────────────────────────────────────── how translation quality is tested

const TEVAL_ALT =
  'A flow diagram in two rows over a strip of numbers. The first row is one change to the harness: lock the passages, set a floor and a ceiling, plant errors to test the checks, ' +
  'draft the old plan and the new plan, check every verse by code, have another model family judge the two blind, verify a claimed error against the source, and decide against criteria written first. ' +
  'Three guards feed that row from above: a second identical run, a judge from another model family, and criteria written before any draft. ' +
  'The second row is the whole edition: every verse is audited, a finding is confirmed against the source, each fix is read token by token, and release gates mark every verse ready or open with the reason. ' +
  'A confirmed error goes back up to become a planted kind and a check. The strip gives the verses in each set: 327 development, 510 held out, 180 in the hard set, 568 in the skill tests, 839 planted errors, 1,115 stored drafts and 31,085 in the whole edition.';
const TE_LOCAL = 'Scripts on the operator\'s machine, against a local copy of the translation store and checker. Nothing here touches the published edition.';
const TE_STORE = 'A private evaluation store. Drafts, judgements and run records stay there; the repository holds the sets, the numbers and the verdicts.';

const TEVAL_STEPS: Step[] = [
  {
    id: 'lock', name: 'Lock passages', color: '#8b5cf6', at: [110, 300],
    summary: 'The passages a change is tested on are chosen and frozen before the change is written.',
    why: 'A change tested on the passages it was tuned on will look good. So the passages are fixed first, drawn by a seeded rule and not by hand, and some are sealed so that nobody reads them while working.',
    what: [
      '<b>The benchmark</b> has 128 passages: 55 for development (327 verses), read freely, and 73 held out (510 verses), written once and locked for a number that will be quoted.',
      '<b>The hard set</b> has 30 passages (180 verses) drawn from 7,525 candidate windows across nine kinds of difficulty: negation, numbers, dialogue, referents, poetry and prophecy, argument, law, rare words and apocalyptic. Twenty are open. Ten are sealed and run only for a final accept or reject.',
      '<b>Two skill sets</b> of 32 and 28 passages (317 and 251 verses) test one idea each. The second was drawn by seed after the first, so that a result on hand-picked passages could be confirmed on passages nobody chose.',
      'A set leaves out everything that could flatter a result: the benchmark, passages used in pilots, verses an outside review named, and curated hard cases.',
    ],
    where: ['The sets: <code>evaluations/bible-translation/</code> in the skills repository (<code>translate-v1.*.src.json</code>, <code>rbs-hard-v1.frozen.json</code>, <code>skill-plan-set*.json</code>).', 'The rule that freezes the hard set: <code>scripts/freeze-hard-set.py</code>.'],
    by: 'Code only. The draw is seeded, so it can be repeated.',
    reads: ['The frozen source, its parsing and the story layer, to find hard windows.', 'The lists of passages already used.'],
    leaves: ['A set file with its seed, its rule and its split.'],
    stops: ['A sealed passage that has been read for a decision is spent. The ten sealed passages of the hard set were used once, on one question.'],
  },
  {
    id: 'bounds', name: 'Floor and ceiling', color: '#3b82f6', at: [290, 300],
    summary: 'A word-by-word gloss and a published human translation are scored beside every arm.',
    why: 'A score with nothing beside it means nothing. The floor is what you get with no translator at all. The ceiling is a careful human translation. An arm should land between them, and a check that fails the ceiling is a faulty check.',
    what: [
      'The floor is the source tables\' own glosses in source order. The ceiling is a public-domain English translation, used here only as a contestant and never shown to a drafter.',
      'This is how the checker\'s rules were set. Its first version blocked 67% of the human translation, on curly apostrophes, on a negation rule that wanted one "not" per negator, and on numbers that did not compose. After tuning, the human translation passes 99%.',
    ],
    where: [TE_LOCAL, 'The arms: <code>evaluations/bible-translation/translate-arms.json</code>.'],
    by: 'Code only. Neither arm calls a model.',
    reads: ['The source tables.', 'The human translation, for scoring only.'],
    leaves: ['Two reference scores on every set.'],
    stops: ['A check that fails the ceiling is repaired before it is trusted.'],
  },
  {
    id: 'plant', name: 'Plant errors', color: '#14b8a6', at: [470, 300],
    summary: 'Code puts known errors into correct text and counts how many the checks catch.',
    why: 'The checks decide what goes back for revision and what a verse is allowed to say it has passed. Their own accuracy has to be measured, and it can be measured for nothing: no model is called.',
    what: [
      'Nine kinds of error are planted, 839 in all: a speaker swapped, a person flipped, a clause added, a name changed, a clause dropped, a theological term added, a negative removed, an emphatic dropped, and a number changed.',
      'Today the checks catch 781 of the 839. The weakest kinds are a flipped person (89 of 111) and a changed name (85 of 96).',
      'The other half of the measure is false alarms. 1,115 stored first drafts are replayed through the checker, and every failure is counted by kind.',
      'A change to the checker is accepted only if it loses no planted error. The latest change kept all 781 and removed 14 false alarms.',
    ],
    where: [TE_LOCAL, '<code>scripts/checker-measure.mts</code>, with the planted kinds in the translation harness package.'],
    by: 'Code only.',
    reads: ['The development passages and the gloss floor.', 'Stored first drafts from earlier runs.'],
    leaves: ['Caught and missed by kind, and every failing verse of the replay, so two versions of the checker can be compared line by line.'],
    stops: ['A planted error that is no longer caught is listed by name, and the change is reworked.'],
  },
  {
    id: 'arms', name: 'Draft the arms', color: '#f59e0b', at: [650, 300],
    summary: 'Today\'s plan and the changed plan each draft the same passages. So does a second run of today\'s plan.',
    why: 'The second identical run is the most important thing on this page. A drafter given the same passage twice rewords about nine verses in ten. Without that run beside it, ordinary variation looks like an effect.',
    what: [
      'Each arm drafts every passage with the same model, the same source material and the same checks. Only the change under test differs.',
      'The second run of today\'s plan is scored against the first exactly as the change is. Its result is the noise: what two arms with no difference between them look like.',
      'Every run has a spending cap, and the cost is quoted before it starts. A comparison on about 300 verses costs about one dollar to draft and half a dollar to judge.',
    ],
    where: [TE_LOCAL, 'The run records: the private evaluation store, one file per passage and arm.'],
    by: 'A model drafts (Claude Haiku 5.5). Code runs the plan.',
    reads: ['The locked set.', 'The plan for each arm.'],
    leaves: ['For every passage and arm: the draft, its alignment, every check result and the cost.'],
    stops: ['The spending cap.', 'A run that fails is recorded as a failure of the environment and left out, not scored as a bad translation.'],
  },
  {
    id: 'checks', name: 'Check by code', color: '#22c55e', at: [830, 300],
    summary: 'Every verse of every arm is held to the same checks, and failures are counted.',
    why: 'Checks are exact and repeatable where a judge is not. They cannot say a translation is good. They can say that a word is unaccounted for, a number changed, a name is wrong or a sentence is broken.',
    what: [
      'The checks read the alignment between each source word and its English: coverage, additions, negation, numbers, names, decided terms, who is speaking, and whether the sentence is whole.',
      'Failing checks are a guardrail, not the verdict. This project\'s own checks have rewarded a change that a blind reader liked less: a revision that satisfied the coverage check by tacking words onto a finished sentence.',
    ],
    where: ['The checker in <code>apps/translation-mcp</code>, the same code that runs in production.'],
    by: 'Code only.',
    reads: ['Each draft and its alignment.', 'The source tokens, the dictionary and the decided names.'],
    leaves: ['Per verse, which checks failed and why.'],
    stops: ['A broken sentence is refused outright, whatever else the verse passes.'],
  },
  {
    id: 'judge', name: 'Judge blind', color: '#ec4899', at: [1010, 300],
    summary: 'Another model family reads the two versions against the source, without knowing which is which.',
    why: 'The model that drafted should not mark its own work, and a judge that knows which version is new will favour it. So the judge is from another family, sees the versions as A and B, and sees them a second time with the labels exchanged.',
    what: [
      'For each verse the judge says which version carries the source more exactly, which reads as better English, and lists each version\'s errors as critical, major or minor.',
      'A preference counts only when the judge gives it in both orders. A verse on which it changes its mind when the labels are exchanged is a tie.',
      'The judge is given the source tokens and a dictionary, and is told to judge against the source and not against an English Bible it remembers.',
      'The judge has limits that are now measured. Scoring the same drafts twice, it agreed on which verses were wrong about a third of the time. Its count of errors on identical text moves by about a fifth.',
    ],
    where: [TE_LOCAL, '<code>scripts/fair-compare.mts</code>.'],
    by: 'A model judges (GPT-5.6 Luna). Code hides the labels, exchanges them and counts.',
    reads: ['The two versions of each passage.', 'The source tokens and the dictionary.'],
    leaves: ['Per verse: the preference on faithfulness and on English, and the errors named.'],
    stops: ['A judge call that fails stops the comparison. It is never counted as a tie.'],
  },
  {
    id: 'verify', name: 'Verify', color: '#0ea5e9', at: [1190, 300],
    summary: 'A claimed error is checked against the source before it counts.',
    why: 'A reader that finds errors also invents them. A finding is a claim until something else agrees, and how far each verifier can be trusted has itself been measured.',
    what: [
      'On 120 planted errors and 120 clean verses, Claude Haiku confirmed 50 of the errors and called no clean verse wrong. GPT-5.6 Luna confirmed 117 and called 22 clean verses wrong, nearly all by treating an ordinary English word as an addition.',
      'So neither is a verifier alone. A lost negation, a wrong number or a wrong name stands on the stronger reader\'s word. A claimed addition needs a second vote.',
      'A "not real" from the weaker verifier clears nothing: it missed 29 of 30 lost negatives.',
    ],
    where: [TE_LOCAL, '<code>scripts/verify-suspects.mts</code>.'],
    by: 'A model verifies. Code decides how many votes a finding needs.',
    reads: ['The finding, the verse and its source tokens.'],
    leaves: ['Real or not real, with the evidence quoted from the source.'],
    stops: ['An unconfirmed finding stays open. It is not treated as cleared.'],
  },
  {
    id: 'decide', name: 'Decide', color: '#ef4444', at: [1370, 300],
    summary: 'The change passes or fails against criteria written before it ran.',
    why: 'With enough ways to read a result, one of them will favour the change. Writing the pass mark first removes the choice.',
    what: [
      'The criteria are stated in a document before any draft is made: how far the change must beat the noise, what it may not make worse, and what it may cost.',
      'A near miss fails. Nothing is tuned on the test passages afterwards.',
      'The verdict is recorded with its numbers whether it passed or failed. Most have failed, and the page below lists them.',
    ],
    where: ['The verdicts: <code>docs/bible-translation/</code> in the skills repository, one note per test.'],
    by: 'Code counts. The rule was written by a person, in advance.',
    reads: ['The judge\'s preferences, the error counts, the failing checks and the cost, for the change and for the noise.'],
    leaves: ['A dated verdict, and the default that follows from it.'],
    stops: ['A change that fails stays off, however promising an earlier run looked.'],
  },
  {
    id: 'audit', name: 'Audit', color: '#a855f7', at: [290, 580],
    summary: 'Another model family reads every verse of the published edition against its source.',
    why: 'The tests above are on a few hundred verses. The edition is 31,085. An outside review found verses marked as passed that were not sentences, so the whole edition is read, not sampled.',
    what: [
      'The audit read all 31,085 verses in 3,968 passages and filed about 60,000 remarks, of which roughly 17,000 verses kept at least one that touched meaning.',
      'Those are suspects, not errors. They are ranked, and the ones a check can decide are decided by code.',
    ],
    where: [TE_LOCAL, '<code>scripts/audit-edition-critic.mts</code>.'],
    by: 'A model reads (GPT-5.6 Luna). Code ranks.',
    reads: ['The published verses and their source tokens.'],
    leaves: ['A list of suspect verses with the claimed error.'],
    stops: ['The spending cap. The audit cost about seventeen dollars.'],
  },
  {
    id: 'confirm', name: 'Confirm', color: '#0ea5e9', at: [470, 580],
    summary: 'A suspect becomes a defect only when it is confirmed, and a defect becomes a test.',
    why: 'Fixing an error once helps one verse. Turning it into a planted kind and a check helps every verse drafted afterwards.',
    what: [
      'The worst suspects were verified against the source, and 134 were traced as confirmed defects with their cause. The largest group, 57 of them, is a wrong meaning at the level of a word.',
      'The causes were counted. Verses whose first draft failed a check hold 85% of the defects in 45% of the edition, so that is where a second reading is spent.',
      'A cause that code can recognise becomes a check. The broken-sentence check came from here, and is now a gate on every release.',
    ],
    where: [TE_LOCAL, 'The record: the defects specification in the skills repository.'],
    by: 'A model verifies. Code and a written rule decide what becomes a check.',
    reads: ['The suspects, the verses and their run records.'],
    leaves: ['Confirmed defects with a cause, and new checks.'],
    stops: ['A suspect that cannot be confirmed is left as it is.'],
  },
  {
    id: 'source', name: 'Read the fixes', color: '#6366f1', at: [650, 580],
    summary: 'A replaced verse is read against its source words before the release is trusted.',
    why: 'A fix can pass every check and still be worse. A drafter answering a finding about words tends to write stiff English, or to trade one error for another.',
    what: [
      'A verse is replaced only by rule: it passes the checks with no new failure, the verifier reads the finding as gone, the blind judge does not prefer the published verse, and a reader of the English alone does not find it less clear.',
      'Each replaced verse is then read against its source tokens. Of the 73 replaced in one release, four read worse than the verse they replaced, and all four had passed every check.',
    ],
    where: [TE_LOCAL, '<code>scripts/redraft-defects.mts</code> and <code>scripts/assemble-patch-release.py</code>.'],
    by: 'Models draft, verify, judge and read. Code applies the rule.',
    reads: ['The published verse, the new verse, and the source tokens of both.'],
    leaves: ['Accepted replacements, and the ones held back with the reason.'],
    stops: ['Any one of the four rules holds a verse back. It then stays as published and is labelled open.'],
  },
  {
    id: 'gates', name: 'Release gates', color: '#10b981', at: [830, 580],
    summary: 'Every verse is published as ready or as open, and an open verse says why.',
    why: 'Nobody reviews this edition, so a verse must not claim more than was checked. The honest output of an evaluation is a label on each verse.',
    what: [
      'A verse is ready when its source is accounted for, it reads as a coherent sentence, and anything a reader needs to be told is disclosed in a note.',
      'In the current release 26,445 of 31,085 verses are ready and 4,640 are open. A confirmed defect that is not yet fixed is published as open with the finding stated.',
      'The gates run on all 31,085 verses at every release, and the published corpus is compared row by row with the build it came from.',
    ],
    where: ['<code>scripts/edition-tiers.py</code> and <code>scripts/check-edition-integrity.mts</code>, then the signed corpus.'],
    by: 'Code only.',
    reads: ['Every verse, its checks, its coherence reading and its notes.'],
    leaves: ['The status on every verse, and the release.'],
    stops: ['A broken sentence blocks the release.'],
  },
];

const TEVAL_BODY = `
<h2>Where this fits</h2>
<p>This page goes with <a href="/architecture/translation-harness">How the translation agent translates the Bible</a> and <a href="/architecture/translation-skills">How a passage's category chooses its translation skill</a>. Those describe how a verse is made. This one describes how we find out whether a change to that process made the verses better.</p>
<h2>How many verses</h2>
<div class="table-wrap"><table class="skills-table">
<thead><tr><th>Set</th><th>Passages</th><th>Verses</th><th>Used for</th></tr></thead>
<tbody>
<tr><td>Benchmark, development</td><td>55</td><td>327</td><td>Everyday comparisons, the floor and the ceiling</td></tr>
<tr><td>Benchmark, held out</td><td>73</td><td>510</td><td>A number that will be quoted. Locked</td></tr>
<tr><td>Hard set</td><td>30</td><td>180</td><td>Accepting or rejecting a change. 120 open, 60 sealed</td></tr>
<tr><td>Skill tests</td><td>60</td><td>568</td><td>The category and skill tests, in two sets</td></tr>
<tr><td>Planted errors</td><td>839 cases</td><td>on the benchmark</td><td>Measuring the checker, at no cost</td></tr>
<tr><td>Stored drafts, replayed</td><td>200 runs</td><td>1,115</td><td>Counting false alarms, at no cost</td></tr>
<tr><td>Verifier test</td><td></td><td>240</td><td>120 planted errors and 120 clean verses</td></tr>
<tr><td>Whole edition</td><td>3,968</td><td>31,085</td><td>The audit and the release gates</td></tr>
</tbody>
</table></div>
<p>A comparison of two plans reads between 180 and 320 verses. That is a small number. It is enough to see a large effect and not enough to see a small one, which is why a result is always shown beside a second run of the unchanged plan.</p>
<h2>What is measured, and by what</h2>
<div class="table-wrap"><table class="skills-table">
<thead><tr><th>Question</th><th>Measured by</th><th>Costs</th></tr></thead>
<tbody>
<tr><td>Do the checks catch errors?</td><td>Errors planted by code: 781 of 839 caught</td><td>Nothing</td></tr>
<tr><td>Do the checks raise false alarms?</td><td>1,115 stored drafts replayed, failures by kind</td><td>Nothing</td></tr>
<tr><td>Is version B more faithful than A?</td><td>A blind judge of another family, in both orders</td><td>About half a dollar for 300 verses</td></tr>
<tr><td>Is it better English?</td><td>The same judge, asked separately</td><td>The same call</td></tr>
<tr><td>Is a claimed error real?</td><td>A verifier, with a second vote for additions</td><td>A tenth of a cent a finding</td></tr>
<tr><td>Is a verse coherent to a reader?</td><td>A reader shown our English only</td><td>Very little</td></tr>
<tr><td>Is it copied from an existing Bible?</td><td>Overlap with held editions, as a guardrail that must not rise</td><td>Nothing</td></tr>
</tbody>
</table></div>
<p>Similarity to an existing translation is never a score to raise. Nothing that decides "better" compares our wording with another Bible's.</p>
<h2>What the tests have decided</h2>
<div class="table-wrap"><table class="skills-table">
<thead><tr><th>Change</th><th>Result</th><th>Verdict</th></tr></thead>
<tbody>
<tr><td>A check that refuses a broken sentence</td><td>Catches the shape behind the edition's worst errors</td><td>Kept, and a release gate</td></tr>
<tr><td>Asking again when a draft leaves many words unowned</td><td>A draft that skipped words is drafted again, not patched</td><td>Kept</td></tr>
<tr><td>Fewer false alarms in the checks</td><td>No planted error lost</td><td>Kept</td></tr>
<tr><td>Checks chosen by the kind of text</td><td>33 of 37 and 26 of 27 planted errors caught</td><td>Kept, scoped to their kind</td></tr>
<tr><td>Rules for the drafter by kind of text</td><td>Two repeats disagreed</td><td>Off. The test was later found to be unfair to the idea</td></tr>
<tr><td>A paragraph about the kind of text</td><td>Less faithful on 12 verses, more on 4</td><td>Rejected</td></tr>
<tr><td>Three drafts, the best picked per verse</td><td>Did not beat a second plain run on the sealed set</td><td>Rejected</td></tr>
<tr><td>Revising only the words a check names</td><td>Preferred on 9 verses, the full revision on 22</td><td>Rejected</td></tr>
</tbody>
</table></div>
<h2>What this ruler cannot do yet</h2>
<ul>
<li><b>It has no human in it.</b> Every reader here is a model. A verse marked ready has passed what a machine checked and nothing more.</li>
<li><b>The judge is unsteady.</b> It agrees with itself on which verses are wrong about a third of the time, so counting errors by verse cannot show a small gain.</li>
<li><b>Verses are not independent.</b> In one passage a single choice, "he" or "they" for "a man or a woman", was charged as an error on ten verses. It decided a whole test in one direction and then the other.</li>
<li><b>The sets are small.</b> A few hundred verses, drafted once or twice.</li>
</ul>
<h2>What changes next</h2>
<ul>
<li><b>The passage is the unit</b>, with three runs of each arm, so that one choice in one passage counts once.</li>
<li><b>Closed questions with answer keys.</b> Code writes questions from the source that have one right answer: who is the father of whom, whether a verse states a duty or a permission, whether a rule applies always or only on a condition. A model answers from the English alone, and the score is the share answered as the key says.</li>
<li><b>A free gate before any spend.</b> A change must first alter the wording more than two identical runs differ. If it does not, there is nothing to judge.</li>
<li><b>Decide what was left open.</b> Five conventions of English that varied between runs are now decided in the brief, so that they stop appearing as errors.</li>
</ul>
<h2>In plain terms: what makes a translation good or bad</h2>
<p>There is no single score. A verse is asked three questions, and each has its own reader.</p>
<div class="table-wrap"><table class="skills-table">
<thead><tr><th>Question</th><th>Who answers</th><th>A bad answer looks like</th></tr></thead>
<tbody>
<tr><td><b>Is everything there, and nothing extra?</b></td><td>Code, word by word against the source</td><td>A source word with no English, an English word with no source, a "not" lost, a number or a name changed</td></tr>
<tr><td><b>Does it mean what the source means?</b></td><td>A model from another family, reading the source and the English together</td><td>The wrong sense of a word, the wrong person doing the action, a reason turned into a result</td></tr>
<tr><td><b>Can a reader follow it?</b></td><td>A model shown our English only</td><td>A sentence that does not finish, or one that says something no reader could make sense of</td></tr>
</tbody>
</table></div>
<p>A verse is <b>bad</b> when any one of these finds a fault that holds up when checked. The faults are graded. A critical fault reverses or loses the meaning. A major fault drops, adds or mistakes a word or a clause. A minor fault is awkward English or a slightly loose word. A verse is <b>good</b> when none of the three finds anything.</p>
<p>That is a narrower claim than it sounds, in three ways.</p>
<ul>
<li><b>Good means no fault was found, not that the verse was approved.</b> The first question is exact. The second is a model's judgement, and that model misses some errors and invents others, which is why a finding is verified before it counts. No scholar has read these verses.</li>
<li><b>Most of our measuring is a comparison.</b> We rarely ask whether a verse is good. We ask whether version B is better than version A on the same verse, read blind. That is a question a model answers more steadily than "how good is this", and it is the one a change to the harness needs answered.</li>
<li><b>Good does not mean familiar.</b> A verse is never scored by how close it is to an existing Bible, and never rewarded for being different either. Sounding like a translation people know is not evidence that it is right.</li>
</ul>
<p>What a reader of the edition sees is the outcome of the three questions: a verse marked <b>ready</b> has passed all of them, and a verse marked <b>open</b> says which one it has not.</p>

<h2>How one version is judged better, and when the new one is taken</h2>
<p>The starting position is that the version we already have stays. A new version has to earn its place, and when the evidence is mixed the old one is kept.</p>
<p>The comparison is the same each time. It has four parts.</p>
<ol>
<li><b>Code checks both versions against the source.</b> A version with a failed check that the other does not have starts behind.</li>
<li><b>A model from another family reads the two side by side.</b> GPT-5.6 Luna sees the source and two versions labelled A and B. It is never told which is the old one. For each verse it says which is more faithful to the source, which is better English, and what errors each one has.</li>
<li><b>It is asked again with A and B swapped.</b> A verse counts as a win only when both readings pick the same version. If they disagree, the verse is a tie.</li>
<li><b>A reader model sees our English only</b> and says whether each version can be followed.</li>
</ol>
<p>Faithfulness decides. Better English never makes up for a meaning that is less faithful.</p>
<p>What it takes to win depends on how much is at stake.</p>
<div class="table-wrap"><table class="skills-table">
<thead><tr><th>What is being decided</th><th>The new version is taken when</th><th>A tie goes to</th></tr></thead>
<tbody>
<tr><td><b>A draft inside one run</b>, after a revision round</td><td>It has fewer failed checks of the kind that hold a verse back, then fewer failed checks of any kind. No model is asked.</td><td>The earlier draft</td></tr>
<tr><td><b>A verse that is already published</b></td><td>All five rules below hold.</td><td>The published verse</td></tr>
<tr><td><b>A change to the harness</b>, such as a new instruction, check or step</td><td>On passages locked before the test, it wins more verses than it loses, by more than two identical runs of the old plan differ from each other. It misses no planted error that the old plan caught. The pass mark was written before any draft was made.</td><td>The harness as it is</td></tr>
</tbody>
</table></div>
<p>The five rules for replacing a published verse:</p>
<ol>
<li>The verse changed, and the fault that was found is gone by its own check.</li>
<li>The new verse fails no serious check that the published verse passed.</li>
<li>A model reading the new verse against the source finds no error of meaning in it.</li>
<li>The blind judge does not prefer the published verse on faithfulness in either order, and reports no dropped, added or mistaken word in the new one.</li>
<li>The reader does not find the new verse harder to follow than the published one.</li>
</ol>
<p>If any rule fails, the published verse stays. It is marked open with the reason, and the failed attempt is kept on record. In release 4.0.1, 134 verses had a confirmed fault. 85 new versions passed the first four rules, the reader held back 12 of those, and 73 verses were replaced. The other 61 were published as open.</p>
<p>A change to the harness is held to the same standard. Seven changes to how the drafter works have been tested this way, and none was taken: none did better than its pass mark, or than the difference between two identical runs. A change to the checks can be measured without a model: it is taken when it still catches the planted errors and raises fewer false alarms on stored drafts. The latest one kept 781 of 839 planted errors and removed 14 false alarms.</p>
<p>These rules lower the risk of a bad replacement. They do not remove it.</p>
<ul>
<li><b>Four of the 73 replaced verses read worse than the verses they replaced</b>, and all four passed every rule. They were found later by reading each replacement against its source words. They are still published, and taking them back is on the list of open decisions.</li>
<li><b>Rule 3 is weak.</b> The model that applies it found 50 of 120 errors planted on purpose. The stronger model found 117, but also called 22 of 120 correct verses wrong. A rule for using the two together is designed and not built.</li>
<li><b>The second half of rule 4 was applied by hand</b> on the last pass. It is not yet in the script.</li>
<li><b>The test sets are small.</b> A comparison reads 180 to 320 verses, so a small real gain cannot be told from chance, and such a change is not taken.</li>
</ul>
`;

const TEST_ALT =
  "A flow diagram. Questions are drawn from a library of articles across every category, and clearly denominational ones are set aside for a later test. A key is built from each article. Today's path and the path with skills answer. A judge compares answers blind, in both orders, with the article and two other products as contestants; planted errors and a noise control test the judge. A second model family confirms any claimed error. Answers are scored against the key, real errors are remembered, and a scorecard per skill says what to change next.";
const TEST_RUN = 'An evaluation script on the operator\'s machine (<code>apps/demo-bible-a2a/scripts/benchmark.mts</code>). It is not a Worker, and it runs nowhere near a reader.';
const TEST_STORE = 'A private evaluation store. Questions, articles, keys and answers stay there and are not committed or published.';

const TEST_STEPS: Step[] = [
  {
    id: 'draw', name: 'Draw', color: '#8b5cf6', at: [188, 400],
    summary: 'Questions from every category of a large library.',
    why: 'A test on the questions you tuned on flatters you, and a test on one kind of question says nothing about the rest. Every category takes a turn, so rare subjects are present and large ones do not dominate.',
    what: [
      'The library is a large published collection of Bible questions, each answered by a clear, opinionated article. Each category is taken in turn from a seeded shuffle, so the same draw can be repeated.',
      'Questions used in earlier tests are left out, along with very long questions and very short articles.',
      'The draw does not look at which skill a question would reach, so the test shows how often each skill really comes up.',
    ],
    where: [TEST_RUN, TEST_STORE],
    by: 'Code only.',
    reads: ['The articles and the site\'s public category pages.', 'The questions already used.'],
    leaves: ['The list of candidate questions.'],
    stops: ['A category with no question left simply takes no more turns.'],
  },
  {
    id: 'aside', name: 'Set aside', color: '#3b82f6', at: [304, 400],
    summary: 'Clearly denominational questions wait for their own test.',
    why: 'A question that turns on what divides traditions has no single correct answer to score against. Keeping it in the general score would reward or punish a tradition instead of an answer.',
    what: [
      'Two model families read each question and the opening of its article, and say whether it clearly turns on a distinctive that divides Christian traditions.',
      'If either says yes, the question is reserved and the next one from the list takes its place.',
      'The reserved questions are kept for denominational testing, which is not being run yet.',
    ],
    where: [TEST_RUN],
    by: 'Two small models, one from each family. The rule that either one can set a question aside is code.',
    reads: ['The question.', 'The opening of its article.'],
    leaves: ['The questions kept, and the reserved list with the reason for each.'],
    stops: ['The rule errs toward setting aside. In the first run it reserved 12 of 52, a few of them more than it needed to.'],
  },
  {
    id: 'key', name: 'Key', color: '#14b8a6', at: [420, 400],
    summary: 'What a correct answer must say, from the article.',
    why: 'Knowing what a correct answer says turns "which do you prefer?" into "did it get this right?". The articles take clear positions, which makes them good to build from.',
    what: [
      'A strong model reads the article and writes three to six essential points in its own words, the passages that carry the answer, and the position the article takes.',
      'A model from the other family checks that each point really is the article\'s own, and code resolves each passage against the signed corpus.',
      'The article is presumed correct. A point leaves the key only when it is confirmed wrong.',
    ],
    where: [TEST_RUN, TEST_STORE],
    by: 'A model writes it, a second family audits it, and code checks the passages.',
    reads: ['The article.', 'The signed corpus.', 'The errors already confirmed.'],
    leaves: ['A private key for each question.'],
    stops: ['A point the audit cannot find in the article is dropped and listed.', 'A passage that does not resolve is listed.'],
  },
  {
    id: 'answer', name: 'Answer', color: '#f59e0b', at: [536, 400],
    summary: "Today's path and the path with skills both answer.",
    why: 'To learn what the skills do, the only difference between two answers should be the skills. So both run through the same pipeline, with the same library and the same writer.',
    what: [
      'Each question is answered by the path that serves readers today, and again with the intent stage and every scope and form acting, whether or not they have passed before.',
      'The two other products\' answers are captured through their public interfaces, with the date. The article itself is the fifth contestant.',
    ],
    where: [TEST_RUN, 'The library and corpus are the live ones, read over HTTPS.'],
    by: 'The same writer model on both paths, with the proof in code under both.',
    reads: ['The question.', 'The library and the signed corpus.', 'The skill files.'],
    leaves: ['Every answer, with its receipt and the skills it ran under.'],
    stops: ['A hard spending cap on the whole run. Past it, nothing more is spent without the owner.'],
  },
  {
    id: 'judge', name: 'Answering', color: '#ef4444', at: [672, 400],
    summary: 'Blind comparison on one question: did it answer what was asked?',
    why: 'The first judging marked a loss when one small thing was wrong and rewarded answers for citing verses. It said we beat a product whose answers read better to a person reading them. So this comparison asks one thing, and accuracy and links are measured apart.',
    what: [
      'A strong model from a different family compares two answers with their names removed, in both orders. A win counts only when both orders agree.',
      'It is told what decides: did the answer take the question in its plain meaning and give the things most worth knowing. A small flaw does not decide, a clear position is not an error, and length is neither a virtue nor a fault.',
      'It says how large the difference is. Clear and marginal wins are counted apart.',
      'The noise control answers the same way twice, to see how often a winner appears where nothing changed.',
    ],
    where: [TEST_RUN],
    by: 'A model, twice per pair.',
    reads: ['The two answers, without names.', 'The question.'],
    leaves: ['A verdict and a margin for each order.'],
    stops: ['If the noise control finds too many winners, the run does not go on to the full set.'],
  },
  {
    id: 'confirm', name: 'Accuracy', color: '#22c55e', at: [788, 400],
    summary: 'Each answer alone, against the article and the verses it cites.',
    why: 'One wrong fact should not lose a comparison, and it should still be counted. Judges also call things wrong that are not: the owner read answers a judge had called wrong and found most were fine. So accuracy is its own measure, and a claim alone is not an error.',
    what: [
      'A model reads one answer with the reference article and the text of every verse it cites, and lists only what those or a plain fact show to be wrong. A clear position is not an error, and neither is leaving something out.',
      'Planted errors are known mistakes added to an answer. They test this check: in the pilot it named about two in three, so the true error counts are higher for every contestant.',
      'A model from the other family confirms what the head-to-head judge claims, and real errors go on to step 8.',
    ],
    where: [TEST_RUN],
    by: 'A strong model, and a small model from the other family to confirm.',
    reads: ['One answer.', 'The article.', 'The verses it cites.'],
    leaves: ['A list of errors for each answer, marked as mattering to the main point or not.'],
    stops: ['A contestant that cites few verses has less that can be shown wrong. Counts are read with that in mind.'],
  },
  {
    id: 'score', name: 'Links', color: '#0ea5e9', at: [904, 400],
    summary: 'Are the verses and writings it points to the right ones?',
    why: 'Picking the verses and writings is a large part of a good answer, and a who-won verdict barely sees it. There are many good verses for most questions, so an article\'s choices are a guide and not a checklist.',
    what: [
      'Each verse and writing an answer links to is graded for the question: central, supporting, or off-topic.',
      'Code also counts how many of its verses fall in chapters the article uses. That is reported and never held against an answer: a good verse the article did not use still counts as good.',
    ],
    where: [TEST_RUN],
    by: 'A model grades; code counts.',
    reads: ['The question.', 'Each linked verse\'s text, and each writing.', 'The verses the article cites.'],
    leaves: ['A grade for every link.'],
    stops: ['The first product capture did not keep its source lists, so its writings are only graded from the fuller run.'],
  },
  {
    id: 'remember', name: 'Remember', color: '#a855f7', at: [1030, 400],
    summary: 'Real errors are kept, from one run to the next.',
    why: 'A real error found once should never need finding again. An error of ours should stay fixed, and an error in an article should not mark an answer down for being right.',
    what: [
      'A confirmed error in an article takes that point out of the key.',
      'A confirmed error of ours becomes a regression test.',
      'A confirmed error in a product\'s answer is recorded with its capture date.',
      'The owner\'s own marks override the register. It does not wait for them.',
    ],
    where: [TEST_STORE],
    by: 'Code, from the confirmations.',
    reads: ['The confirmed errors.'],
    leaves: ['A permanent private register.'],
    stops: ['Text from an article is not copied into the register.'],
  },
  {
    id: 'card', name: 'Scorecard', color: '#6366f1', at: [1146, 400],
    summary: 'What each skill did, one by one.',
    why: 'A single total hides everything worth knowing. The purpose is to learn how the skills approach works: which skills earn their place, which do nothing, and which do harm.',
    what: [
      'For each intent, scope and form: how often it was chosen, clear and marginal wins and losses against today, points covered, confirmed errors, length and time.',
      'For the judge that picks skills: how often it holds back in each category of question.',
      'A skill that looks good gets its own larger test before it can change what a reader sees.',
    ],
    where: [TEST_RUN, TEST_STORE],
    by: 'Code.',
    reads: ['Every verdict, confirmation and score.'],
    leaves: ['The report, and what to change next.'],
    stops: ['About 300 questions give each scope 20 to 100. That shows a pattern, and does not prove a small gain.'],
  },
];

const TEST_BODY = `
<h2>Where this stands</h2>
<p>As of 5 November 2026, a 40-question pilot has run and the 300-question run is under way. The questions below are the pilot's, and we tuned on them, so they are not yet the score to trust. Most head-to-head comparisons tie.</p>

<h2>What we tested that did not work</h2>
<ul>
<li><b>One verdict for everything.</b> A single who-won judgment marked a loss for one small flaw and credited answers for citing verses. It reported wins that a person reading the answers did not see.</li>
<li><b>Planted errors as a who-won test.</b> Once one small flaw no longer decides a comparison, the judge preferred the correct answer in only 6 of 16. They moved to the accuracy check.</li>
<li><b>Trusting one run.</b> A first win on answers about people in the Bible (11 better, 2 worse) was level on the rerun (8 and 8). The same path judged against itself finds a winner in about one pair in ten.</li>
<li><b>Cheaper judges.</b> One changed its verdict with the order of the answers in nearly half of the pairs, and reported 135 errors where the stronger model reported 21. Another named only half of the planted errors.</li>
<li><b>Grading links as a checklist.</b> Scoring against the article's verses punishes a good verse the article did not use, so overlap is now reported and not scored.</li>
</ul>

<h2>Why it is built this way</h2>
<ul>
<li><b>Earlier judging overstated things.</b> The owner read answers a judge had called wrong and most were not, and answers called best were only marginally best. That is why errors must be confirmed and margins are counted.</li>
<li><b>Chance sets the bar.</b> The same path judged against itself finds a winner in about one pair in ten, so every gain is read against that.</li>
<li><b>Compete on the hard thing.</b> The contestants include clear, opinionated articles and two other products, under one neutral standard.</li>
<li><b>The test does not change what readers see.</b> It reads the live library and writes only to a private store.</li>
</ul>

<h2>What it cannot tell us</h2>
<ul>
<li>These are one publisher's questions. It shows how answers do on what that library covers, not on what readers here ask.</li>
<li>Denominational questions are not scored yet.</li>
<li>A key is one publisher's view of a correct answer. The verses can overrule it, but only where they settle the point.</li>
</ul>`;

// ───────────────────────────────────────────────────────────────── the Bible's ontology (skills: ontology/, scripts/; verifiable-content-demo: apps/demo-bible-mcp, apps/demo-bible-a2a)

const ONTOLOGY_ALT =
  "A diagram in four bands. Band one, made before anyone asks: source words in Hebrew, Aramaic and Greek, canonical ids, the Bible's story, who said what, " +
  'the writings and their retellings, and recorded readings of a verse, joined by one thread of ids. Band two, stored: one graph with two doors, a GraphDB repository and fast ' +
  'tables, and skill artifacts in a registry. Band three, the live Ask harness: judge the question, gather by id, graph research, write and prove. Band four, harness ideas with ' +
  'their status: ASTER, whose pattern is live; SPARQL-LLM, whose schema card is live and whose validator only logs; GTA-RAG, whose exercises are live and whose training is not built; and decide and refuse, tested on altered verses only.';

const BUILD = 'Built ahead of time from the <code>skills</code> repository (<code>ontology/</code>, <code>scripts/</code>), never at ask time.';
const STORE = 'GraphDB repository <code>scripture-kb</code>, read by a read-only delegate user that can read nothing else and write nothing.';
const ASK = 'The Scripture Agent Worker (<code>demo-bible-a2a-faithnet</code>) at <code>scripture.faithnet.io</code>.';
const DOOR = 'The library Worker (<code>demo-bible-mcp-faithnet</code>), reached over a service binding.';

const ONTOLOGY_STEPS: Step[] = [
  {
    id: 'source', name: 'Source words', color: '#14b8a6', at: [130, 196],
    summary: 'Every word of the Hebrew, Aramaic and Greek, tagged and frozen.',
    why: "If the ontology were read off an English Bible, it would inherit that translation's decisions, and a translator could never check against them. So everything starts from the original words, and the verse ids come from there.",
    what: [
      'The 1,189 chapters are held as frozen tokens: the source word, its transliteration, its parsing, its Strong\'s number and a dictionary gloss.',
      "Grammar comes from Macula's structure and the STEP lexicon. For an Old Testament verse the builder can also see how the Septuagint's translators read it.",
      'A verse has a language-free id such as <code>Gen.22.2</code>. Nothing downstream depends on the wording of any edition.',
    ],
    where: [BUILD, 'Tokens: <code>evaluations/bible-translation/source/tokens/</code>. Licences: <code>docs/bible-translation/manifest.json</code>; a dataset outside the allow-list is refused.'],
    by: 'Code only.',
    reads: ['The source editions, by exact revision.', "STEP, Macula and the Septuagint's text."],
    leaves: ['One token file per chapter.', 'The verse ids every later step uses.'],
    stops: ['A component not in the manifest, or with a licence outside the allow-list, does not enter.'],
  },
  {
    id: 'ids', name: 'Canonical ids', color: '#3b82f6', at: [370, 196],
    summary: 'People, places and words each get one stable id, with a stated confidence.',
    why: 'Names collide. Eight people are called Simon, and Joseph is both a patriarch and the husband of Mary. If a record is joined by name, those people merge silently. So identity is a claim that has to be earned, and it is recorded with how sure we are and why.',
    what: [
      "The knowledge base holds 3,129 people, 553 settlements and more places besides, 5,535 name forms, 5,221 key terms (one per Strong's number) and 184 theological concepts.",
      'An id carries where the person appears, such as <code>skb:person-Isaac_Gen.17.19-Jas</code>, so two people who share a name are two ids.',
      'Every binding records <code>canon_confidence</code>, <code>canon_method</code> and <code>canon_basis</code>. <code>1.0</code> means a native, authoritative id. Anything lower has to say why, and a low-confidence match is never upgraded to look certain.',
      'At ask time a shared name binds nothing: the candidates are listed and none is chosen.',
    ],
    where: [BUILD, 'Graphs: <code>scripture:kb</code> and <code>scripture:kb-sa</code>. Projection: <code>scripts/writings/build-kb-projection.py</code>.'],
    by: 'Code from reference data (TIPNR, OpenBible and curated files). A model does not mint ids.',
    reads: ['The reference datasets, each with its licence.', 'The source words, for Strong\'s numbers and first mentions.'],
    leaves: ['A stable id for each person, place, term and concept.', 'Confidence, method and basis on every binding.'],
    stops: ['A name that cannot be bound to one referent stays unbound and visible. It is not guessed.'],
  },
  {
    id: 'story', name: "The Bible's story", color: '#8b5cf6', at: [610, 196],
    summary: 'Scenes and the state at every verse: who is on stage, who is speaking.',
    why: 'A verse rarely explains itself. "He said to him" means nothing until you know who is on stage. Holding the story as data means a reader, a translator and an agent all resolve "he" the same way, and can see the record.',
    what: [
      'For each book, a model reads the source tokens, their parsing, the lexicon, the grammar and the knowledge base, and proposes 6,857 scenes and 30,965 verse states: the setting, the cast, the current speaker and the audience.',
      'No English Bible wording enters the prompt. The labels are written in English, and an edition\'s section headings are the starting point for scene cuts: those are the two places English remains.',
      'Spend is tiered: a small model builds every book, code assesses the result, and a stronger model rebuilds only the chapters flagged.',
    ],
    where: [BUILD, 'Builder: <code>scripts/build-discourse.py</code>. Graphs: <code>scripture:discourse</code> and <code>scripture:discourse:references</code>.'],
    by: 'A small model proposes (Claude Haiku 5.5), code checks, a stronger model on flagged chapters only.',
    reads: ['Tokens, grammar and lexicon.', 'The knowledge base and period context.'],
    leaves: ['One JSON per book, which a reviewer can edit.', 'Scene and state records in the graph, bound to canonical ids.'],
    stops: ['A cut-off model reply is split and retried, never trusted.', 'A run of words shared with a held English Bible is flagged as a leak.'],
  },
  {
    id: 'said', name: 'Who said what', color: '#ec4899', at: [850, 196],
    summary: 'Acts of speech, commissions, journeys, and the kind of situation each scene is.',
    why: 'Much of the Bible is who said what to whom, and who went where to say it. Those questions cannot be answered by searching for similar text. They need a record that joins a speaker, an audience and a verse.',
    what: [
      '8,404 communication acts: communicator, audience, kind (speech, oracle, teaching, letter and others), place, time and the verse. Plus 336 commissions and 220 journeys.',
      '6,488 of the 6,857 canon scenes carry up to three situation kinds, such as <code>scr:Battle</code>, <code>scr:Prophecy</code> or <code>scr:Judgment</code>. A kind is a class in the ontology, so the same query crosses the canon and the writings.',
      'These are modelled with DOLCE and PROV terms, so a scene is a description a situation satisfies, and every act can say where it came from.',
    ],
    where: [BUILD, 'Graphs: <code>scripture:communication</code> and <code>scripture:situations</code>. Situation typing: <code>scripts/type-scene-situations.py</code>.'],
    by: 'Code from the story states where they decide it; a small model for the rest. Marked unreviewed.',
    reads: ['The story layer.', 'The event classes of the ontology.'],
    leaves: ['Acts and situation kinds, each on canonical ids.', '<code>reviewStatus</code>, which says these were derived, not reviewed.'],
    stops: ['A kind must be an event class. A shape in the ontology refuses anything else.'],
  },
  {
    id: 'writings', name: 'Writings and retellings', color: '#f97316', at: [1090, 196],
    summary: "The same story model over other works, joined by shared episodes.",
    why: 'Which ancient works retell Genesis 22, and how do they differ? That needs the works and the Bible to share one way of describing a story. So a held writing gets the same scenes and speakers as the canon, and points at the same people.',
    what: [
      'Works such as Jubilees, 1 Enoch and 1 Clement get a story built unit by unit: scenes, states and mentions, stored in 154 story files.',
      'These works are held as translated units, so this layer is built from those translations, unlike the canon\'s. Their licence decides their graph: share-alike works live apart from the rest.',
      '405 episodes are stories told in several places. A scene of any work can tell an episode, so a chapter of Genesis reaches the paragraphs that retell it.',
      'An index projected from the writings store holds 342,746 units with their verse links and name mentions, 15.8 million facts. The text is not in the graph: it is read from the store by id.',
    ],
    where: [BUILD, 'Builders: <code>scripts/writings/build-work-story.py</code> and <code>scripts/build_scripture_kb.py</code>. Graphs: <code>writings:story</code>, <code>writings:story-sa</code>, <code>writings:layer</code> and <code>writings:index</code>.'],
    by: 'A small model proposes; code checks. An episode records a confidence and <code>model-proposed</code>.',
    reads: ['The held units of each work.', 'The knowledge base, for every id a name could denote.'],
    leaves: ['Story records per work, bound to the same ids as the canon.', 'Episodes, and the scenes that tell them.'],
    stops: ['A name that could denote several people is passed on as ambiguous, not resolved by code.', 'An episode asserts no order and no truth between tellings. It is an index of tellings.'],
  },
  {
    id: 'readings', name: 'Readings of a verse', color: '#22c55e', at: [1330, 196],
    summary: 'What each reader said about a verse, with the exact quote and a check on it.',
    why: 'Asked how a verse has been read, a model will happily attribute a view to Rashi or Calvin from memory. A reading is only useful if it comes with the words it rests on, so each record keeps its quote and that quote gets checked.',
    what: [
      '9,472 open-licence readings across 437 verses, 295 of them New Testament, plus a share-alike set in its own graph. The verses are chiefly the ones people actually ask about, drawn from a study of 300 questions.',
      'A model proposes each claim with a verbatim quote. Code checks that the quote is really in the source, that the vocabulary is the ontology\'s, and that the date is the work\'s and not the model\'s.',
      'A second, independent call reads only the quote and the claim and says whether one supports the other: entailed, cannot tell, or not entailed.',
      'New Testament readings come from commentaries in our own collection, and only from notes filed exactly at the verse. A catechism that cites a verse as a proof text does not count as a reading of it.',
    ],
    where: [BUILD, 'Extractor: <code>scripts/extract-claims.py</code>. Importers: <code>scripts/sources/</code>. Graphs: <code>scripture:interpretations</code> and <code>scripture:interpretations-sa</code>.'],
    by: 'A small model proposes, code checks, a second model call judges support. People can adjudicate; nearly all are not yet reviewed.',
    reads: ['Commentary passages at the verse, each with its licence, in Hebrew or English as held.'],
    leaves: ['A claim with its source, date, method and quote.', 'A row for a person to adjudicate.'],
    stops: ['A quote not found in the source is quarantined.', 'A failed check keeps the claim in the record. Ask refuses to read it (step 11).'],
  },
  {
    id: 'store', name: 'One graph, two doors', color: '#3b82f6', at: [430, 512],
    summary: 'A graph for any question shape, and fast tables for the common ones.',
    why: 'An agent answering in seconds cannot run an open-ended graph query for every name. But some questions have shapes no fixed table anticipates. So the same data is served two ways, and neither is written to while answering.',
    what: [
      'The <code>scripture-kb</code> repository holds about 22 million facts in nearly 50 named graphs, so a query can say exactly which layer it means. Each graph\'s size and source are described in the repository itself.',
      'A read-only SPARQL door accepts SELECT and ASK only, adds a row limit, and times out at 20 seconds. The agent reads a schema card first, which states only shapes that have been verified.',
      'The commonly needed facts are also projected at build time into D1 tables: names, kin, verse referents, concepts and notes. Answering uses these without touching the graph.',
    ],
    where: [STORE, DOOR, 'Door: <code>apps/demo-bible-mcp/src/sparql.ts</code>. Tables: <code>src/kb.ts</code>.'],
    by: 'Code only.',
    reads: ['The committed Turtle files and exports from the writings store.'],
    leaves: ['A repository the agent can read and cannot change.', 'Counts verified against the source files at each load.'],
    stops: ['Updates and federation are refused, by the door and by the delegate user\'s rights.', 'A slow query gets a timeout and a hint to narrow it.'],
  },
  {
    id: 'skills', name: 'Skill artifacts', color: '#f472b6', at: [1120, 512],
    summary: 'What each kind of question gathers and how its answer is shaped, as versioned files.',
    why: 'The ontology says what is known. It does not say what a particular question needs. Skill artifacts carry that judgement as files that can be read, versioned and tested, without changing the harness code.',
    what: [
      '43 published artifacts, including <b>intents</b> (what kind of question this is), <b>scopes</b> (what to gather), <b>forms</b> (the shape of an answer) and <b>reader</b> artifacts (for example, an age band).',
      'A scope card lists what it gathers. <code>gather: [held, meaning, knowledge, graph]</code> on the Bible-subject scope is what lets graph research run there. The card for a question about a passage leaves <code>graph</code> out.',
      'The agent reads them from the registry at ask time, and admits one only if the Scripture organization owns it, it is the newest published version, and its content matches its commitment.',
    ],
    where: ['The skills registry Worker (<code>skills-mcp</code>), reached over a service binding.', 'Source files: <code>skills/scripture/*/SKILL.md</code>. Reader: <code>apps/demo-bible-a2a/src/scripture-skills.ts</code>.'],
    by: 'People and agents author; code admits.',
    reads: ['The registry row and its content commitment.'],
    leaves: ['On each answer\'s receipt: every skill used, with its version and commitment.'],
    stops: ['A skill that fails admission is listed with the reason and not used.'],
  },
  {
    id: 'judge', name: 'Judge the question', color: '#ef4444', at: [340, 750],
    summary: 'An intent card names a scope, and the scope says what to gather.',
    why: 'A question about a person, about a verse and about a doctrine need different material. Picking the intent first means the gathering suits the question, and the choice is on the record.',
    what: [
      'One small model call sees the intent cards and gives a probability for each. A rule in code accepts a choice only with enough confidence and margin.',
      'A chosen intent names its sources (Scripture, general knowledge or both) and can bring a scope and a form with it.',
      'The intent decides what is gathered from the library. Whether the graph is read at all is now decided by the question\'s own shape (step 11).',
    ],
    where: [ASK, 'Source: <code>src/harness/draft-prove.ts</code>, the intent stage, and <code>src/harness/intent-vocab.ts</code>.'],
    by: 'A small model, then a rule in code.',
    reads: ['The intent, scope and form artifacts.', 'The question.'],
    leaves: ['The intent stage on the receipt: what was offered, the probabilities and what acted.'],
    stops: ['It never stops the run. A hold means no scope acts.'],
  },
  {
    id: 'gather', name: 'Gather by id', color: '#14b8a6', at: [610, 750],
    summary: 'Names bound to ids, notes at the verse, and the original words behind it.',
    why: 'This is where the ids earn their keep. Once a name has become an id, everything held about that person can be reached without a text search that also finds everyone else with the name.',
    what: [
      'Names in the question go to <code>kb_link</code>. One referent binds; several are listed, and none is chosen. A name we do not hold is reported, and can take Scripture off the plan altogether.',
      'A question naming a verse reads the study notes and commentaries filed there, each kept as one tradition\'s reading.',
      'The original words behind a cited verse are read from the source tokens, so the answer can speak about the Hebrew or Greek from data, not memory.',
    ],
    where: [ASK, DOOR, 'Source: <code>src/harness/verse-notes.ts</code> and <code>src/harness/original-context.ts</code>. Tools: <code>kb_link</code>, <code>notes_at</code> and <code>original_context</code>.'],
    by: 'Code, over the D1 tables. No graph query is needed for these.',
    reads: ['The D1 tables, the writings store and the source tokens.'],
    leaves: ['The binding of each name, with confidence, method and basis, on the receipt.'],
    stops: ['A shared name binds nothing.', 'A failed read is recorded and the answer goes on.'],
  },
  {
    id: 'research', name: 'Graph research', color: '#8b5cf6', at: [880, 750],
    summary: 'On how readers took a passage, the model writes a graph query; code runs it, or refuses it.',
    why: 'Fixed tools answer fixed shapes. "What did Naomi say to Ruth, and where?" and "Which writings retell Genesis 3?" are joins across layers that no one wrote a tool for. Here the ontology becomes something the agent investigates.',
    what: [
      '<b>It now runs only on how readers have taken a passage.</b> On 100 questions written for these layers, those were the one shape it never lost on: 4 better, 0 worse, 21 the same. Who said what was 2 better, 4 worse; stories 2 and 3; retellings 4 and 8, where the writer tended to discuss its evidence rather than answer.',
      'The model reads the schema card and the question\'s names as bound in step 10, then decides whether a query is needed at all.',
      'It writes a SPARQL query. The door runs it. On a refusal or an empty result it may rewrite once.',
      'Unit ids in the results are fetched from the store as text, and verses are resolved against the signed edition. Other rows go to the writer named as the graph\'s records, never as Scripture.',
      'Code refuses any query on the recorded readings that does not exclude claims whose quote failed its check. The model is told why and rewrites once.',
    ],
    where: [ASK, DOOR, 'Source: <code>src/harness/graph-research.ts</code>.'],
    by: 'A small model writes the query; code runs and refuses.',
    reads: ['The schema card, the bound names and the graph.'],
    leaves: ['The decision and why, each query, how many rows, and what was handed on.'],
    stops: ['Two tries at most. A failed search does not stop the answer.', 'An empty result reaches the writer only if the question asked what the collection holds.'],
  },
  {
    id: 'write', name: 'Write and prove', color: '#22c55e', at: [1120, 750],
    summary: 'A model writes the answer; code proves every verse it quotes.',
    why: 'The ontology does not write the answer. It decides what the writer has in front of it. What is said still has to be checked, and the check is code, so it cannot be talked out of a result.',
    what: [
      'The writer gets the question, the gathered material and the graph\'s records, under the form the skill chose.',
      'Code proves each quoted verse against the signed edition, and a failed check sends the draft back once.',
      'The answer returns with links to the writings it used and a receipt naming every skill, name binding and graph query.',
    ],
    where: [ASK, 'Source: <code>src/harness/draft-prove.ts</code>.'],
    by: 'A model writes (Claude Haiku 5.5); code proves.',
    reads: ['The signed corpus and everything gathered.'],
    leaves: ['The answer, its citations and its receipt.'],
    stops: ['A verse that fails its check does not stand as quoted.'],
  },
  {
    id: 'aster', name: 'ASTER', color: '#f59e0b', at: [215, 984],
    summary: 'An agent investigates the graph. The pattern is live; the rest is an option.',
    why: 'ASTER is an IBM Research approach to text-to-SPARQL in which an agent resolves entities, explores relationships, writes a query, runs it and revises it from what comes back. It treats a graph as something to investigate, not something to memorize.',
    what: [
      '<b>Live, in step 11:</b> resolve the names first, read the schema card, execute, inspect and refine once. On 110 code-scored exercises this took the agent from 73% to 86%.',
      '<b>How it uses the ontology\'s layers:</b> the schema says which relationships exist and which way they run, the concepts say which senses a question might mean, and the records hold the facts. Our model often declines to query word meanings, where a fixed path still does better (100% against 58%).',
      '<b>Not adopted:</b> ASTER\'s separate, inspectable investigation skills, and exploring the schema step by step during an ask. Those would become skill artifacts in the registry if a test shows they help.',
    ],
    where: ['Live in <code>src/harness/graph-research.ts</code>.', 'Reference: <a href="https://research.ibm.com/publications/aster-agentic-text-to-sparql-with-task-skills-autonomous-exploration-and-refinement">ASTER, IBM Research</a>. Its reported scores are on Wikidata, not on Scripture.'],
    by: 'A model investigates; code runs and refuses.',
    reads: ['The ontology\'s schema, concepts and records.'],
    leaves: ['A trace of every query and result.'],
    stops: ['At most two queries a question today.'],
  },
  {
    id: 'sparqllm', name: 'SPARQL-LLM', color: '#f59e0b', at: [560, 984],
    summary: 'Metadata about the graph and real example queries, then a check before running.',
    why: 'SPARQL-LLM, from the SIB Swiss Institute of Bioinformatics, generates queries using metadata about the graph and human-written example queries, and validates each query against the schema before it runs. A wrong query is cheaper to catch before it reaches the graph than after.',
    what: [
      '<b>Live, in our own form:</b> a schema card stating only shapes we have verified, real example queries, and a machine-readable description of every graph (VoID) in the repository.',
      '<b>Built, and only logging: validating before running.</b> A snapshot read from the graph says what each named graph holds, and a query that cannot return anything is flagged with the reason. Replayed on 236 queries the agent had written, it wrongly flagged none and caught 8 of 32 failures, though it took three attempts on that same history. In 228 fresh runs it fired once, so its gain is not shown, and a stale snapshot could refuse a good query. So it records what it would have refused, and refuses nothing.',
      '<b>Not built: choosing examples by question.</b> The agent reads the whole card every time. Retrieving only the examples close to the question would keep it short as the ontology grows.',
      '<b>Not built: a card from the data.</b> Ours is written by hand and has gone stale twice. Generating its counts and shapes from the graph\'s own description would stop that.',
    ],
    where: ['Live: <code>apps/demo-bible-mcp/src/sparql.ts</code> (the card and the door) and <code>scripts/build_scripture_kb.py</code> (the VoID description).', 'Reference: <a href="https://arxiv.org/abs/2512.14277">SPARQL-LLM</a>. Its reported results are on other graphs, not on Scripture, and the paper is listed as under review.'],
    by: 'A model writes the query, and the graph has the last word. Code logs what the validator would have said.',
    reads: ['The ontology\'s classes and properties.', 'The graph\'s VoID description and the example queries.'],
    leaves: ['In the log, what it would have refused and why.'],
    stops: ['It stops nothing while it only logs.', 'The door gives the server a 17-second limit on every query.'],
  },
  {
    id: 'gta', name: 'GTA-RAG', color: '#f59e0b', at: [905, 984],
    summary: 'The graph writes research exercises, and code marks them. Training comes later.',
    why: 'GTA-RAG takes connected paths through a graph, turns them into multi-step questions, and teaches an agent to fetch the evidence those paths require. Our ontology already holds such paths, and it can mark the work without a model\'s opinion.',
    what: [
      '<b>Live, as a measure:</b> 138 exercises drawn from the graph, such as a person\'s kin, an author on a person, a speech between two people, the readings of a verse and an episode\'s retellings. Each names the verses or units an answer must have opened.',
      'Marking is code: a set intersection over what the run fetched, handed on and cited. It costs nothing to rescore and has no judge noise.',
      '<b>What it already found:</b> on 28 story exercises, the agent passed 25% without graph research and 86% to 93% with it, across repeated runs. It also exposed that only 3% of the writings\' story data had been loaded.',
      '<b>Not built:</b> training on these exercises. The next step is GEPA, which improves prompts and skill text against this score. Training a model comes last, and only if that leaves a gap worth the cost.',
    ],
    where: ['Exercises: <code>apps/demo-bible-a2a/scripts/research-exercises.mts</code>. Scoring: <code>scripts/research-baseline.mts</code>.', 'Reference: <a href="https://arxiv.org/abs/2608.22479">GTA-RAG</a>.'],
    by: 'Code draws and marks the exercises. A model answers them.',
    reads: ['The ontology\'s paths: person to writings, verse to readings, chapter to episode to unit.'],
    leaves: ['A score per kind of question and a list of what was missed.'],
    stops: ['A seed the knowledge base cannot bind to one referent is skipped and printed. It does not become an exercise.'],
  },
  {
    id: 'decide', name: 'Decide and refuse', color: '#f59e0b', at: [1250, 984],
    summary: 'The ontology decides what each word means, a model writes, and code refuses a miss.',
    why: 'Better evidence alone does not stop a model reciting a verse it knows. Given a deliberately changed source word, a drafter followed it only 7% of the time and still reported that it had rendered it. So this idea moves the decision out of the writing.',
    what: [
      '<b>Decide:</b> code builds a skeleton for the verse: clauses, decided names, and candidates per word. Choosing among a word\'s own candidates, a model reads the source. It recited the original on only 2 of 100 changed words.',
      '<b>Write:</b> a model puts the decided meanings into English.',
      '<b>Refuse:</b> code checks that each decided word is present and sends the text back, at most twice.',
      '<b>So far:</b> the draft followed a changed word 67.8% of the time with no false reflections, but only on altered verses, where a strange sentence can be correct. Whether it holds good English on real text is the next test. It is proposed for translation first. Nothing here is live.',
      '<b>For the ontology:</b> each decision would become a reviewable record against a term\'s senses (<code>scr:KeyTerm</code>, <code>btr:TermSense</code>). Each word would be decided once, not again on every run.',
    ],
    where: ['Spec: <code>docs/bible-translation/structural-drafting-spec-2026-11-06.md</code>. Test: <code>scripts/skeleton-enforce.mts</code>.'],
    by: 'Code builds the skeleton, a model picks senses and writes, and code refuses.',
    reads: ['The source tokens, the lexicon, the knowledge base\'s names and concepts.'],
    leaves: ['Today: a test record. Proposed: a sense decision per word that a person can review.'],
    stops: ['Two refusals at most. What stays missing is reported.'],
  },
];

const ONTOLOGY_BODY = `<h2>The short version</h2>
<p>The Scripture Agent does not answer from what a model remembers. Before anyone asks, we build a record of the Bible from its original words: who everyone is, what happens in each scene, who said what to whom, which other works retell each story, and how readers have taken each verse. Every record hangs on a canonical id and says how sure we are.</p>
<p>When a question arrives, skill artifacts decide what it needs, the harness gathers by id, and if the question has a shape no fixed tool serves, the model writes a graph query of its own. A model writes the answer. Code proves its verses.</p>
<h2>Three rules that run through it</h2>
<ul>
<li><b>Identity is earned.</b> A name is not an id. A shared name binds nothing, and every binding has a confidence, a method and a basis.</li>
<li><b>A model proposes; code decides.</b> Models do the reading at scale. Code checks quotes, shapes and ids. Weak records stay visible and marked.</li>
<li><b>Knowing and doing are kept apart.</b> The ontology says what is known. A skill says what a kind of question needs. The harness carries both out and records what it used.</li>
</ul>
<h2>What this does not do yet</h2>
<ul>
<li>Most stories and readings were made by models and have not been reviewed by a person. The records say so.</li>
<li>Readings cover 437 verses, not the whole Bible. About one claim in four failed its quote check; those stay in the graph, and code stops Ask reading them. Others were inconclusive and are still used.</li>
<li>Labels and descriptions are in English, even where they were derived from Hebrew and Greek. The writings' stories are built from translations.</li>
<li>Graph research helps where a question has its shape, and those questions are rarer than we expected. On 100 ordinary questions it changed 9: 3 better, 6 the same, none worse. On 100 real questions drawn to suit it, 75 of them "Who was...", it failed its own test: 2 better, 3 worse, 95 the same. On 100 written for the story and reading layers it failed again: 12 better, 15 worse, 73 the same. So finding evidence, which rose from 25% to as much as 93% on exercises, has not yet made answers better on average, and it now runs only on readings of a passage.</li>
<li>The writer does not rest fully on what it is handed. When we changed well-known facts in its evidence for a test, it followed the change alone in 9 of 38 answers, mentioned both in 17, and kept to what it remembers in 11.</li>
<li>The ideas in the fourth band are at different stages, and each step says exactly where. Measured gains on exercises do not show the same gain on every real question.</li>
</ul>
<p>The harness around all this: <a href="/architecture/scripture-ask">How the Scripture Agent answers a question</a>. How answers are tested: <a href="/architecture/testing-answers">How we test the Scripture Agent's answers</a>.</p>`;

// ───────────────────────────────────────────────────────────────── the Ask evaluation harness (vcd apps/demo-bible-a2a/scripts/assessment)

const EVAL_ALT =
  "A flow diagram. Published answers (study notes, commentaries, articles and writings before 1000 AD) are the source. The candidate is pinned. Questions are formed from what a note or article answers. The gold is the author's own sentences. Five answerers answer: our original-language record, our English answer, the bare model, Product 1 and Product 2. A judge says, for each author sentence, whether an answer stated it, and code checks the judge's quote; the author's own text and a decoy test the judge first. Links are counted by code. A record test changes a name or number in every record the harness reads and asks which word the answer uses. A report keeps each number apart.";
const EV_RUN = "Evaluation scripts on the operator's machine (<code>apps/demo-bible-a2a/scripts/assessment/</code>), run from a copy of the code checked out at the pin. They are not Workers and readers never meet them.";
const EV_STORE = "A private evaluation store. Questions, answers, notes and verdicts stay there. The repository holds ids, counts and digests only, because several of the authors' texts may not be republished.";

const EVAL_STEPS: Step[] = [
  {
    id: 'pin', name: 'Pin', color: '#8b5cf6', at: [216, 410],
    summary: 'The version being tested is frozen, so a result always names the code that produced it.',
    why: 'A number is only useful if you can say which code earned it. An earlier assessment was run from code that was never saved, and could not be reproduced.',
    what: [
      'The candidate is frozen as a named git ref (for example <code>ask-claim-isolation-20261108</code>). Every run happens in a copy checked out at that ref.',
      'The runner hashes the code it runs. If anything changes mid-run, it refuses to continue ("Code changed"), so one study cannot mix two versions.',
      'The judge records its own code hash separately, so the same answers can be re-judged under a corrected grader, and the result says it was re-judged.',
    ],
    where: [EV_RUN],
    by: 'Code only.',
    reads: ['The pinned code.'],
    leaves: ["The study's protocol: pin, code hash, models, spending cap."],
    stops: ['A changed file stops the run.', 'A spending cap stops it, and any call left without a price must be settled before the next run starts.'],
  },
  {
    id: 'questions', name: 'Questions', color: '#3b82f6', at: [348, 410],
    summary: 'Each question is one that a published note or article actually answers.',
    why: "If a question is invented apart from its gold, the gold may not answer it. Starting from the author makes the test fair: the author's text is a complete answer to what was asked.",
    what: [
      'For a verse question, a small model proposes the question a study note answers, for example "What does Paul mean in Romans 3:31 when he says faith does not nullify the law, and how can faith uphold it?" from the note on Romans 3:31.',
      'For a topical question, the question is an article\'s own title, such as "What happens after death?"',
      'For the ancient-language test, the questions ask about one word in one verse: <i>ruach</i> in Genesis 1:2, Immanuel in Isaiah 7:14, <i>nephesh</i> in Genesis 2:7.',
      'A comparison set is drawn by a recorded random seed and refuses any question an earlier test already used.',
    ],
    where: [EV_RUN, EV_STORE],
    by: 'A small model proposes the wording, and code decides what enters the set.',
    reads: ['The notes and articles.', 'The questions already used.'],
    leaves: ['A set of questions, each tied to its source, with a hash of the set.'],
    stops: ['A question already used is refused.'],
  },
  {
    id: 'gold', name: 'Gold', color: '#14b8a6', at: [480, 410],
    summary: "The gold is the author's own sentences, word for word.",
    why: "A judge asked \"is this a good answer?\" grades against what it remembers. Holding the answer to the author's exact sentences makes the test about what the author wrote.",
    what: [
      "For a study note, the gold is the note's sentences. For a longer article or commentary, a small model suggests the central sentences, and code keeps a sentence only if it appears in the text exactly.",
      'Several authors can answer the same question. Romans 3:31 is scored separately against the Tyndale note, against Calvin (1540) and against the Expositor\'s Greek Testament.',
      "For the ancient-language test, the gold is a reading of each early witness, and it must be anchored in the witness's own words. Code admits a reading only if its anchor is in the Greek, Aramaic or Hebrew text. At Genesis 1:2 the Septuagint reads πνεῦμα θεοῦ (\"spirit of God\"), Targum Onkelos reads רוּחָא … מְנַשְּׁבָא (\"a wind … blowing\"), and Pseudo-Jonathan reads \"a spirit of mercies\". Each is kept as its own witness and the test never picks one.",
    ],
    where: [EV_RUN, EV_STORE],
    by: 'A model may propose, and code admits only exact text.',
    reads: ['The notes, articles and early writings.'],
    leaves: ["Each author's claims, each with its source's hash."],
    stops: ['A suggested sentence that is not in the text word for word is dropped.', 'A reading whose anchor is not in the witness is dropped.'],
  },
  {
    id: 'answer', name: 'Answer', color: '#f59e0b', at: [612, 410],
    summary: 'Five answerers take the same question.',
    why: 'A score means little alone. The bare model shows what memory can already do. The products show what a reader could get elsewhere. Our own original-language record shows what we knew before writing in English.',
    what: [
      '<b>Our harness</b>, run from the pin, gives two texts. One is the reading it forms in the original language before any English (its bound native claims). The other is its English answer.',
      '<b>The bare model</b> is the same writer model with the question alone, with no tools and no sources.',
      '<b>Product 1</b> is asked once per question and its answer is saved with the time. <b>Product 2</b> refused every call in November (its monthly quota), so its saved answers from 2 to 5 November are used where they exist, and it is reported as not measured where they do not.',
    ],
    where: [EV_RUN, EV_STORE],
    by: 'Models answer, and code records each answer with its time and cost.',
    reads: ['The question.', 'For our harness, its own live retrieval.'],
    leaves: ["Each answer, with our harness's full run record: what it retrieved, what it gave the writer and what each claim cites."],
    stops: ['A product that refuses is stopped at its first refusal and recorded as unavailable, never scored as wrong.'],
  },
  {
    id: 'judge', name: 'Judge', color: '#ef4444', at: [756, 410],
    summary: 'For each author sentence: stated, differs, contradicted or absent. Code checks the quote.',
    why: 'The judge is never asked which answer is better. It answers a narrow question that can be checked: does this text say what this sentence says?',
    what: [
      "The judge is Claude Haiku 5.5, named on every result. For each of the author's sentences it says <i>stated</i>, <i>differs</i>, <i>contradicted</i> or <i>absent</i>, and gives a quote from the answer.",
      'A verdict counts only if code finds that quote in the answer.',
      'A reading counts as stated when the answer holds the same reading, whether or not it names the witness. "Immanuel means God with us" states Eusebius\'s reading even if Eusebius is never named.',
      'Before any verdict is read, two checks run on every case. The author\'s own text must read as stating its own sentences, at 0.9 or more. Four sentences from another question\'s author must read as not stated, at 0.8 or more. If a track fails either check, it reports no number.',
    ],
    where: [EV_RUN, EV_STORE],
    by: 'A model gives the verdict, and code checks the quote and the controls.',
    reads: ["The author's sentences.", 'Each answer.'],
    leaves: ['One verdict per sentence per answer, with its quote.'],
    stops: ['A verdict whose quote is not in the answer does not count.', 'A failed judgment is retried and the failed attempt is archived.'],
  },
  {
    id: 'links', name: 'Links', color: '#0ea5e9', at: [900, 410],
    summary: "Did the answer reach the author's passages and the earliest witnesses? Code counts it.",
    why: 'An answer can be right and cite nothing useful, or cite well and say little. So links are a second score, never folded into the first.',
    what: [
      "The author's references and the answer's citations are read by the same parser, then compared exactly and within two verses of the same chapter.",
      'For our harness, the run record shows how far each early writing got. It can be <i>retrieved</i> (found), <i>handed</i> (given to the writer) or <i>in a claim</i> (cited as evidence). A product has no run record, so we count the works it names.',
      'For the ancient-language test, the pool for each verse is built by code from everything held before 1000 AD. It is ranked in three tiers: ancient versions (the Septuagint and the Targums), writings that comment on the verse, and passing citations.',
    ],
    where: [EV_RUN],
    by: 'Code only.',
    reads: ["The author's references.", "Our harness's run record.", 'The writings index.'],
    leaves: ['Link counts per answerer, per tier.'],
    stops: ['A weaker source used while a stronger one was missed is flagged.'],
  },
  {
    id: 'record', name: 'Record test', color: '#a855f7', at: [1044, 410],
    summary: 'Change a name or number in every record the harness reads. Does the answer follow the record or memory?',
    why: 'On well-known questions a model answering from memory looks complete. This is the one test memory cannot pass: when the records say something else, which does the answer use?',
    what: [
      'A target is picked by rule: a name or number word that our harness restated, that appears at least twice in what it retrieved, and that is not in the question. Its replacement is another name or number of the same kind (Saul to Ashbel, twelve to fourteen).',
      'A wrapper around the pinned candidate changes the word in every record it receives, and maps requests back so its tools still work.',
      'A run is graded only if its own prompts prove the swap. The new word must reach the writer, and the old word may appear only in text the run itself wrote.',
      'Code counts the result: <i>record</i> (the new word), <i>memory</i> (the old word), <i>conflict</i> (both) or <i>silent</i> (neither). No model judges it.',
    ],
    where: [EV_RUN, EV_STORE],
    by: 'Code only.',
    reads: ['A study already run at the pin.', 'The names in the knowledge base.'],
    leaves: ['One outcome per case, and every claim that cites a record while stating the remembered word.'],
    stops: ['A run whose prompts do not prove the swap is not graded, and the reason is given.'],
  },
  {
    id: 'report', name: 'Report', color: '#6366f1', at: [1188, 410],
    summary: 'Each number on its own, named by who assessed it, with what memory alone scores beside it.',
    why: 'One blended score hides the very things to fix. Kept apart, the numbers show where the answer was lost: in retrieval, in the hand-off to the writer, or in the English.',
    what: [
      "<b>Coverage</b> is the share of the author's sentences stated, per track. <b>Distinctive coverage</b> counts only the sentences the bare model did not state, so memory cannot score them. The <b>lift over the bare model</b> is paired, with a 95% interval.",
      '<b>Links</b> are counted per tier. The <b>record rate</b> carries a Wilson interval.',
      'Every number says whether code, a model (named) or a person assessed it. A judge\'s concern is a lead, never a counted error, until a person confirms it.',
    ],
    where: [EV_RUN, EV_STORE],
    by: 'Code.',
    reads: ['Every verdict, link count and record outcome.'],
    leaves: ['A scores file per study. Ids and numbers are committed, and text never is.'],
    stops: ['A track whose checks on the judge failed reports no number.'],
  },
];

const EVAL_BODY = `
<h2>Why we built it</h2>
<p>Our earlier quality test showed a judge two answers and asked which was better. The judge had no author in front of it, so in practice it graded against what it remembered a good answer should say. On the most familiar questions, a model answering from memory looked complete, and our harness looked worse than the bare model. The owner put it plainly: the test measured whether an answer matched what the model remembers, not what the person who wrote the note actually wrote. This harness measures the second thing.</p>

<h2>Three tests, one ruler</h2>
<ul>
<li><b>The authors' answers.</b> Verse questions are scored against study notes and commentaries, and topical questions against published articles. The gold is the author's own sentences.</li>
<li><b>The ancient languages, before English.</b> For a word in a verse, every writing we hold from before 1000 AD at that verse forms a pool. Each early witness's reading is anchored in its own words. Five answerers are judged against those readings, including our own original-language record before any English is written.</li>
<li><b>Record or memory.</b> A name or number is changed in every record the harness reads, and the test checks which word the answer uses.</li>
</ul>

<h2>Example: one question, one author, five sentences</h2>
<p>The question was "What does Paul mean in Romans 3:31 when he says faith does not nullify the law, and how can faith uphold it?" The gold is the five sentences of the open Tyndale study note on that verse (Tyndale House Publishers, via BibleAquifer, CC BY-SA 4.0). Among them: "However, faith does not cancel the law" and "God gives the Holy Spirit to those who have faith, and the Spirit enables them to do what is right." The judge was Claude Haiku 5.5.</p>
<ul>
<li><b>Our English answer stated 2 of 5.</b> For "faith does not cancel the law" the judge quoted "Paul means that faith does not make God's law irrelevant". It read three sentences as <i>differs</i>, among them the Spirit sentence, because our answer speaks of love fulfilling the law and not of the Spirit enabling it.</li>
<li><b>The bare model stated 3 of 5.</b></li>
<li><b>Product 1 stated all 5.</b></li>
<li><b>The two checks passed on this case.</b> The note's own text read as stating all five sentences, and four sentences from another author's note read as absent from it.</li>
</ul>
<p>The same question is also scored against Calvin's commentary (1540) and the Expositor's Greek Testament, each on its own.</p>

<h2>Example: what the original-language record knew and the English lost</h2>
<p>The question was "What does 'Immanuel' mean in Isaiah 7:14?" The pool held ten writings from before 1000 AD at that verse. The Septuagint (Ἐμμανουήλ) and Targum Jonathan keep the name untranslated. Eusebius, in the <i>Demonstration of the Gospel</i> (about 314), glosses it: "they shall call his name God with us … for Emmanuel signifies this." Our harness's original-language record said the name is conventionally understood as "God with us". Its own review then withheld that line, because its evidence did not establish the gloss, and the English answer dropped it. Eusebius was in the store the whole time and never reached the reading step.</p>
<p>Across 13 word-in-a-verse questions, with 72 anchored readings from 41 witnesses, the judge's controls scored 0.97 and 0.99. The share of witness readings each stage stated:</p>
<ul>
<li>our original-language record: 0.19</li>
<li>our English answer: 0.12</li>
<li>the bare model: 0.12</li>
<li>Product 1: 0.10</li>
<li>Product 2, from saved answers: 0.16</li>
</ul>
<p>Our original-language record stated 14 readings and the English kept 9, gaining none. The harness retrieved 6 of the 23 ancient versions, handed 3 to the writer, and built no claim on any writing from before 1000 AD. The lever is getting those writings to the writer.</p>

<h2>Example: the record says fourteen, the answer says twelve</h2>
<p>In the record test, "twelve" became "fourteen" in every record, so the writer received Matthew 10:5 as "these fourteen Jesus sent out". In another case, "Saul" became "Ashbel" in the records about Doeg. Of 16 cases, 11 passed the check that the swap really reached the writer. The answer followed the record in 6, followed memory in 3, and named neither in 2. That is a record rate of 0.55, with a 95% interval of 0.28 to 0.79, short of the 0.8 bar fixed in advance. Two of the three memory answers were laundered citations: a claim saying "the Twelve" was bound to the very verse that, as the writer saw it, said fourteen. Our binding checks that a claim cites records we hold, not that it says what they say. That is now a fix to make.</p>

<h2>Example: the commentaries now reach their verses</h2>
<p>The first ancient-language run could hardly see the New Testament. Chrysostom's homilies, Cyril of Alexandria on Luke and John, and Theodoret on Romans were all in the store. But a section was placed on a verse only when its text cited one. These authors head each section with the verse they expound, for example "Ver. 29. 'Being filled with all unrighteousness…'" in Chrysostom's fifth homily on Romans, and the index ignored those headings. Code now reads each heading and checks its quotation against the verse. The section is placed only when the quotation is found there, together with up to three paragraphs that follow it. That added 7,668 links for 5,527 sections, and a hand check of 40 found all 40 on the right verse. Cyril on Luke (429) and Theodoret on Romans (410) carry dates, so they now join the pool of writings from before 1000 AD. Chrysostom's homilies reach their verses too, but the index still withholds their dates. The collected volume had been dated from the wrong record, and a date is now given only when it is bound to the homily's own record. Until those bindings are made, his homilies stay out of the pool. They are also the only new material at Romans 3:25, John 14:16 and John 19:30.</p>

<h2>What did not work</h2>
<ul>
<li><b>Cutting a sentence out as a negative control.</b> We removed one of the author's sentences and expected the judge to call it absent. It still read as stated 12 times in 29, and the judge was right: authors restate their point. The decoy took its place.</li>
<li><b>Counting the reading only when the witness was named.</b> The first ancient-language grading turned the reading score into a second link score. The same answers were re-judged under the corrected rule, and the first grading is kept as the record of the error.</li>
<li><b>Checking names in bound claims.</b> The check flagged "Paul" 31 times out of 37, because a verse need not repeat its speaker. It now checks numbers only, and names are tested by the record test.</li>
<li><b>A record test that leaked.</b> The first run left the original word in places the swap did not reach: lines with a colon, and a summary the candidate fetched for itself. The original reached the writer in 11 of 15 runs. That run was withdrawn, and every run must now prove its swap.</li>
</ul>

<h2>What it cannot tell us yet</h2>
<ul>
<li>These are first runs on 13 to 16 questions. They are leads for what to fix, not rates to quote. The product differences are a few readings out of 72 and do not rank the products.</li>
<li>The judge's checks cover the easy edges: the author's text word for word, and an unrelated author. A paraphrase check (an author's sentence reworded should read as stated, and negated as contradicted) is next.</li>
<li>The readings are a model's statement of each witness. They are anchored in the witness's words by code, but no person has reviewed them.</li>
<li>Some authors' notes may not be republished, so their text stays in the private store. This page quotes only open and public-domain sources.</li>
</ul>`;

export const POSTS: Post[] = [
  {
    slug: 'eval-harness',
    title: 'How we measure an answer against what its author wrote',
    date: '2026-11-08',
    description:
      "Our answer-quality test used to grade against what a model remembers. Now the gold is the author's own sentences, the earliest witnesses are read in their own languages, and a record test checks whether the answer follows its sources. How questions and answers are formed, how they are scored, and what the first runs found.",
    picture: {
      svg: '/architecture/eval-harness-flow.svg', png: '/architecture/eval-harness-flow.png', alt: EVAL_ALT, width: 1460, height: 960,
      caption: 'Grey arrows are the questions, gold and answers. Pink arrows are checks on the judge. Purple is the record test.',
    },
    steps: EVAL_STEPS,
    body: EVAL_BODY,
  },
  {
    slug: 'bible-ontology',
    title: "How the Bible's ontology is made, and how Ask and new harness ideas use it",
    date: '2026-11-07',
    description:
      'How canonical ids, stories, situations and readings are built from the Hebrew and Greek, how the Ask harness and its skill artifacts use them, and where ASTER, SPARQL-LLM, GTA-RAG and decide-and-refuse fit.',
    picture: {
      svg: '/architecture/bible-ontology-flow.svg', png: '/architecture/bible-ontology-flow.png', alt: ONTOLOGY_ALT, width: 1460, height: 1190,
      caption: 'Grey arrows are the build and the ask. Pink arrows are skill artifacts. Dashed amber is work at different stages: each tile says how far it has got.',
    },
    steps: ONTOLOGY_STEPS,
    body: ONTOLOGY_BODY,
  },
  {
    slug: 'testing-answers',
    title: "How we test the Scripture Agent's answers",
    date: '2026-11-05',
    description:
      'How answers are compared blind against clear, opinionated articles and two other products, why answering, accuracy and links are measured apart, and what we tested that did not work. A 300-question run is under way.',
    picture: {
      svg: '/architecture/ask-testing-flow.svg', png: '/architecture/ask-testing-flow.png', alt: TEST_ALT, width: 1460, height: 930,
      caption: 'Grey arrows are the questions and answers. Pink arrows are checks on the judge. Dashed arrows happen only when needed.',
    },
    steps: TEST_STEPS,
    body: TEST_BODY,
  },
  {
    slug: 'translation-harness',
    title: 'How the translation agent translates the Bible',
    date: '2026-11-05',
    description:
      'The path from a book of the Bible to a signed verse: what a drafter may see, how code holds every verse to its source, why revision is the riskiest step, and how an edition is built with no person reviewing it.',
    picture: {
      svg: '/architecture/translation-flow.svg', png: '/architecture/translation-flow.png', alt: TRANSLATION_ALT, width: 1460, height: 1040,
      caption: 'Grey arrows are the text. Pink arrows are what a run stands on. Dashed arrows happen only when needed.',
    },
    steps: TRANSLATION_STEPS,
    body: TRANSLATION_BODY,
  },
  {
    slug: 'translation-skills',
    title: "How a passage's category chooses its translation skill",
    date: '2026-11-05',
    description:
      'A genealogy, a law, a poem and an argument fail in different ways. How the category of a passage chooses a skill, what a skill may change at five steps of a run (draft, align, check, revise, keep), and what has been measured so far.',
    picture: {
      svg: '/architecture/translation-skills-flow.svg', png: '/architecture/translation-skills-flow.png', alt: TSKILL_ALT, width: 1460, height: 1150,
      caption: 'Grey arrows are the text. Pink arrows are what the skill sets. The grid shows the four skills as first built, and the border of each cell says how far that part has got. The categories proposed in their place are below.',
    },
    steps: TSKILL_STEPS,
    body: TSKILL_BODY,
  },
  {
    slug: 'testing-translations',
    title: 'How we test the quality of a translation',
    date: '2026-11-05',
    description:
      'No person reviews RBS, so every change to the harness is tested on locked passages, beside a second run of the unchanged plan, by a blind judge from another model family. How many verses, what is measured, what the tests decided, and what this ruler cannot do yet.',
    picture: {
      svg: '/architecture/translation-eval-flow.svg', png: '/architecture/translation-eval-flow.png', alt: TEVAL_ALT, width: 1460, height: 1040,
      caption: 'Grey arrows are the test. Pink arrows are guards on the test itself. Dashed arrows happen only when needed.',
    },
    steps: TEVAL_STEPS,
    body: TEVAL_BODY,
  },
  {
    slug: 'sign-in',
    title: 'How sign-in works: the first time, a new app, and coming back',
    date: '2026-11-05',
    description:
      'The path from pressing Sign in at an app to the app holding a delegation: what the Home checks, what the person signs, what is remembered, and what a second app or a return visit skips.',
    picture: {
      svg: '/architecture/sign-in-flow.svg', png: '/architecture/sign-in-flow.png', alt: SIGNIN_ALT, width: 1460, height: 1020,
      caption: 'Grey arrows are a first sign-in. Green is a new app for a person already signed in. Blue is an app coming back. Amber is an app the person already allowed: no sheet, and nothing signed.',
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
      'The answer-first design being tested for the Scripture Agent: the verses chosen before writing, code proving every one, the writings beside the answer. Also what readers get today, the categories of skills, and what we tested that did not work.',
    picture: {
      svg: '/architecture/scripture-intent-flow.svg', png: '/architecture/scripture-intent-flow.png', alt: ANSWER_ALT, width: 1460, height: 960,
      caption: 'The design in testing, not yet live. Grey arrows are the question. Pink arrows are a skill on its way in. Grey tiles were tested and have not earned their place.',
    },
    steps: ANSWER_STEPS,
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
