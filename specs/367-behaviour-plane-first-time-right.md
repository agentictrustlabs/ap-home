# Spec 367 — The behaviour plane, first time right: plan admission, skills that teach the planner, typed cross-agent exchange, the private graph query, and memory from confirmations

**Status:** W1 (plan admission) + W2 (skills teach the planner) shipped 2026-09-07 · W3–W5 open · **Extends:** [spec 350](350-authority-aware-agent-harness.md)
(the loop), [spec 354](354-archetype-driven-agent-behavior.md) (SKILL.md → definition), [spec 355](355-ontology-driven-ask-and-orchestration.md)
(compile, don't interpret), [spec 358](358-semantic-context-plane.md) (the knowledge plane; truthfulness evals; vault memory),
[spec 356](356-ontology-grounded-vault-questions.md) / [357](357-natural-language-questions-of-the-public-kb.md) (the two query tiers),
[spec 366](366-subject-routed-ask.md) (routing an ask to its subject) · **Doctrine:** ADR-0013, ADR-0041, ADR-0044, ADR-0025,
[one-capability-model-generates-both](../docs/architecture/agent-rules/one-capability-model-generates-both.md),
[ontology-drives-behavior](../docs/architecture/agent-rules/ontology-drives-behavior.md).

## 0. Why this spec exists — one day's misses, read as a pattern

On 2026-09-07 four scenarios failed on the first try at `alice.me`, and every one was fixed by hand within the hour:

| Scenario | What happened | Why it could happen |
| --- | --- | --- |
| "how many members are in Missio Nexus" | read Alice's own empty roster and said "none listed" | a plan step with no subject ran anyway; the invoker fell back to the addressee |
| the routed ask's reply | the org answered; the relay read the wrong key and said "needs more" | the agent-to-agent hop had no schema — an ad-hoc POST and an ad-hoc parse |
| "send 10 usdc to David" | planned as a household lookup; the answer said "nothing was sent" | nothing judged the plan's shape; the tool's own prose warning did not bind the planner |
| "what teams am I a part of" | a records query that called a treasury and a workspace "organizations" | the ontology had the classes and nobody had written *that* tool |

The authority plane held in all four (spec 358's verdict again). The misses are the behaviour plane, and they
are not four bugs — they are four *missing gates*: nothing admits a plan, nothing teaches a planner from the
skill, nothing types the exchange between agents, and the private relationship graph has no query tier.
Patching scenarios finds the same gaps again with new names. This spec closes the gaps.

**The principle:** *intelligence may be probabilistic; the shape of what it proposes must not be.* A planner
proposes; **admission** judges the proposal against declarations before anything runs; the mandate judges
authority; the receipt proves. Where a shape has one correct plan it is compiled (355); where it does not,
the model plans and admission catches the plan that is not the sentence. And the declarations a planner is
taught from, admission judges by, and evals replay are **one artifact**: the SKILL.md contract.

## 1. W1 — Plan admission ✅ shipped 2026-09-07

**The port** (`@agenticprimitives/orchestration` `admission.ts`, `OrchestrationPorts.planAdmission`): after the
planner returns and before any step is resolved, `admit({ intent, plan, tools })` → admitted, or a list of
violations `{ code, message, stepIndex?, toolId? }`. Refused ⇒ the loop re-plans **once** with the violation
messages in `intent.context.admission` (the model planner renders context; a compiled planner ignores it, so a
compiled plan that is wrong is refused, visibly); refused again ⇒ `outcome: 'denied'`, `error: plan_refused: …`,
nothing ran. Events: `PlanRefused { violations, replanning }`.

**The rules are declarations, not English.** Each reads only what a tool declares about itself:

| Rule | Reads | Refuses |
| --- | --- | --- |
| `instruction_answered_by_read` | `ToolSpec.verbs` on capability-bearing tools (`send`, `pay`, `create a team`…) | a sentence that OPENS with an act's verb (polite wrappers stripped) whose plan has no capability-bearing step. Which act is not judged — that a step acts is |
| `subject_unnamed` | `ToolSpec.subject` (spec 366) + the asker's OWN link names, supplied by the harness | a subject-bearing step with an empty subject when the sentence contains a name the asker knows (private tier — never a directory name) |
| `placeholder_argument` | the step's args | `<UNKNOWN>`, `TBD`, `n/a`: omit an argument and it is asked for; a placeholder is refused |

**Boundaries.** Admission grants nothing and skips nothing: every admitted step still meets the verifier. It
never resolves a party (that is the resolver's, in the asker's tier) and never repairs a plan (that is the
planner's, told why). A question is never an instruction: "who did I send money to" opens with "who". The
verbs are declared on the tool today and compile from the contract's utterances in W2.

**Evidence.** `packages/orchestration/test/unit/admission.test.ts` (rules + the loop's re-plan and denial);
live: "send 10 usdc to David" reaches the payment capability at `alice.me`.

## 2. W2 — Skills teach the planner (utterances → few-shot → evals) ✅ shipped 2026-09-07

Today a SKILL.md compiles into instructions and one tool description; the planner learns each act from a
paragraph. The contract gains `utterances:` — example sentences, the arguments each yields, and **negative**
examples ("send money to my daughter → `treasury.payment.execute`, NOT `household.roster`"). The `~/skills`
compiler renders them into `DefinitionToolV1.verbs` + a few-shot block in the planner prompt, and the SAME
fixtures are the eval set: `check:ask-scenarios` runs every utterance through classification + admission
(no model where the shape is compiled; a recorded model elsewhere) and fails the build when a scenario
plans wrong. A scenario then ships with the skill and is tested before deploy — not discovered at the prompt.
Spec 358 W2's truthfulness set extends from *answers* to *plans*. **Gate:** the four §0 scenarios are fixtures.

**Shipped:** `SkillExecutionContractV1.verbs` + `utterances[{ says, args? | isNot? }]` with validators (an example may
not name an undeclared input or carry an address; a read declares no verbs) → `DefinitionToolV1.verbs/utterances`
(`~/skills` compiler `669644c`, deployed `skills-ontology-production`) → `mergeContractTool` unions verbs onto the
running tool and `utteranceExamples` renders the few-shot block after the playbook doctrine (same definition ⇒ same
block, so the receipt's digest covers what the planner was taught). All fourteen `agentic-trust` contracts carry
examples (40 scenarios, six of them negative). **`pnpm check:ask-scenarios`** reads the deployed definitions:
offline, every positive example's declared plan passes admission and every negative one is not an instruction for
that act; `ASK_SCENARIOS_LIVE=1` asks each sentence at the deployed agent as a demo persona and requires the reply
to name the tool (an act ⇒ `authority_required`/`prompt` for it; a read ⇒ its evidence). Alice's assignment moved to
digest `0x1418b6b6…` — the person-steward playbook now teaches.

## 3. W3 — The typed cross-agent exchange (spec 366 R2)

The routed ask becomes an `apix:Exchange` (spec 340) in `packages/a2a`: a schema for the step, the presented
standing, and the typed reply; both agents' receipts cite each other's run. Teams, treasuries and workspaces
route by declaration. **Gate:** a second Home answers the Missio Nexus ask with no code in either deployment.

## 4. W4 — The private graph query (the third tier)

Spec 356 queries a vault's records by selector; 357 queries the public KB by generated SPARQL. The person's
**relationship graph** — what they hold, belong to, steward; who is in what; by ADR-0061 class — has no tier,
so each question got a tool (`person.affiliations.list` was today's). One relation-query read over the
asker's own links + the chartered edges, driven by the T-box relations (`charters`, `memberAgent`,
`householdMember`) and the class table, answers the family. Private tier, never joined with the KB in an
engine. **Gate:** "what teams am I on / which treasuries does Missio Nexus hold / who is in my circle" with
no new invoker code.

## 5. W5 — Memory from confirmations

Learned preferences exist (358 W5). What is missing is learning without being told: when a person answers
a resolver's choice ("David" → `david.me`), the answer is remembered for that capability's party; a prompt
answered once is prefilled next time and confirmed, not re-asked. Vault-resident, per person, revocable in
the Home; it fills WHERE, never authority. **Gate:** the second "send 10 usdc to David" asks nothing.

## 6. Order and the drift to refuse

W1 first (done): it turns every future miss into a named refusal instead of a wrong act. Then W2, because
fixtures are what make W3–W5 provable. Refuse: a second model as an admission rule; a regex over English
in the loop; admission that repairs or resolves; a "known names" source that is the public directory.

## Reference: smart-agent patterns to port

`smart-agent` validates a proposal against its schema before it enters the marketplace and rejects with
named reasons (`docs/specs/needs-resources-plan.md`, `round-trip-trust-deposit-plan.md`). Ported: reject
by name before acting, re-propose once. Divergent: admission here reads tool declarations compiled from
skill contracts, never a schema hand-written per feature, and it sits *inside* the run in front of the
verifier rather than at an API boundary.
