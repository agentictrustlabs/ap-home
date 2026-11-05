// THE ESTATE'S ARCHITECTURE POSTS. Public, static, written here: `/architecture` lists them, `/architecture/<slug>` is one.
// A post is a picture of a flow, the flow's steps listed to the right of it, and prose under both. Choosing a step (in the list or
// on its tile in the picture) opens that step's details in a panel on the right: why the step exists, what happens, where it runs,
// what it reads and leaves, and how it stops. The panel is plain CSS (`:target`), so these pages load no script. Everything is
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
  /** a model, or code */
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
  steps: Step[];
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

export const POSTS: Post[] = [
  {
    slug: 'scripture-ask',
    title: 'How the Scripture Agent answers a question',
    date: '2026-11-05',
    description:
      'The path a question takes through the Scripture Agent: what it gathers, how a model drafts and code proves every verse, and where answer plans from the skills registry enter.',
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

export function architectureIndex(p: ArchitectureInput): string {
  const cards = POSTS.map((post) => `<article class="post-card">
<a class="thumb" href="/architecture/${post.slug}"><img src="${post.picture.svg}" alt="" width="${post.picture.width}" height="${post.picture.height}" loading="lazy"></a>
<h2><a href="/architecture/${post.slug}">${post.title}</a></h2>
<p class="quiet"><time datetime="${post.date}">${longDate(post.date)}</time></p>
<p>${post.description}</p>
<p><a href="/architecture/${post.slug}">Read the post →</a></p>
</article>`).join('\n');
  return shell({
    name: p.name, current: 'architecture', title: `Architecture · ${p.name}`,
    description: `How ${p.name} works: the agent harness, skills, authority and records, in pictures.`,
    canonical: `${p.origin}/architecture`,
    main: `<h1>Architecture</h1>\n<p class="quiet">How this estate works, in pictures.</p>\n${cards}`,
  });
}

const list = (items: string[]): string => `<ul>${items.map((x) => `<li>${x}</li>`).join('')}</ul>`;

/** One step's details: the panel that opens on the right when the step is chosen. `#closed` shuts it. */
function stepPanel(steps: Step[], i: number): string {
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
<h3>A model, or code</h3>
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
  // the tiles in the picture are links too: one clear rectangle over each numbered tile, in the picture's own units
  const hots = steps.map((s) => `<a href="#step-${s.id}" tabindex="-1"><title>${s.name}</title><rect x="${s.at[0] - 40}" y="${s.at[1] - 40}" width="80" height="80" rx="20"/></a>`).join('');
  const items = steps.map((s) => `<li><a href="#step-${s.id}"><span class="num" style="--c:${s.color}">${steps.indexOf(s) + 1}</span><b>${s.name}</b><span class="sum">${s.summary}</span></a></li>`).join('\n');
  return shell({
    name: p.name, current: 'architecture', title: `${post.title} · ${p.name}`, description: post.description,
    canonical: `${p.origin}/architecture/${post.slug}`, image: `${p.origin}${pic.png}`, article: true,
    main: `<article class="post">
<p class="quiet"><a href="/architecture">Architecture</a> · <time datetime="${post.date}">${longDate(post.date)}</time></p>
<h1>${post.title}</h1>
<p class="lede">${post.description}</p>
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
${steps.map((_, i) => stepPanel(steps, i)).join('\n')}
</div>
</div>
${post.body}
</article>`,
  });
}
