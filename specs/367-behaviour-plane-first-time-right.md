# Spec 367 — Contract-Governed Capability Realization: admission, grounding, and fulfillment

**Status:** revised 2026-09-07 after external review · **first draft's W1 (plan admission) and W2 (skills teach the
planner) are live and are mapped below onto the revised waves as partial deliveries** · waves 1–5 open ·
**Normative reference:** [capability-architecture.md](../docs/architecture/capability-architecture.md) — this spec
does not redefine `CapabilityDefinition`, `CapabilityRealizationContract`, `ExecutionIntent`, `ExecutionPlan`,
`AgentHarness`, `ServiceExecution`; it makes them **operational at the points where execution decisions are made**.
**Reconciles with:** [spec 330](330-agentic-execution-ontology.md) (realization contracts §7, runtime provenance
emission §9 — parked; this spec unparks the executable subset it needs, and does not create a parallel contract
system) · **Extends:** [350](350-authority-aware-agent-harness.md), [354](354-archetype-driven-agent-behavior.md),
[355](355-ontology-driven-ask-and-orchestration.md), [358](358-semantic-context-plane.md), [356](356-ontology-grounded-vault-questions.md)/[357](357-natural-language-questions-of-the-public-kb.md),
[361](361-interaction-contract-one-capability-every-surface.md), [362](362-durable-executor-port-and-cloudflare-workflows.md), [366](366-subject-routed-ask.md) ·
**Doctrine:** ADR-0013, ADR-0041, ADR-0044, ADR-0025, ADR-0050/0051/0053, [one-capability-model-generates-both](../docs/architecture/agent-rules/one-capability-model-generates-both.md), [ontology-drives-behavior](../docs/architecture/agent-rules/ontology-drives-behavior.md).

## 0. The diagnosis, revised

The first draft said: "four missing gates — nothing admits a plan, nothing teaches a planner, nothing types the
exchange, no private-graph tier." The external review sharpened it, and the sharper version is the one this spec
is built on:

> **We do not lack an agent harness. We lack consistent enforcement of the capability architecture we already
> designed — from interpreting a request through demonstrating that it was fulfilled.**

The architecture already distinguishes a capability from its definition, its realization contract, the playbook
that supports it, the runtime intent, the plan, the execution and the evidence. The incidents happened where
those distinctions were **descriptive metadata** rather than **runtime obligations**:

| Observed failure (2026-09-07) | Information that did not remain binding |
| --- | --- |
| a roster question read the asker's own vault | the intended principal, resource owner and organizational scope |
| a payment sentence became a household read | the requested outcome |
| the routed reply was misread as "needs more" | the request/result contract across the service boundary |
| "what teams am I on" needed a new tool | the reusable semantics of relations and role assignments |
| a confirmed "David" will be asked again | the meaning and scope of a prior user choice |

**"Authority passed" is not the end of the diagnosis.** In the wrong-vault incident three different things could
have been true, and they need different tests: Alice was authorized for both vaults and got the wrong one
(permission right, behaviour wrong); Alice was authorized for one and the other was read (an authority defect);
the mandate permitted both but this request named one (the missing protection is binding the execution to the
narrower request). Permission is the outer boundary of what MAY happen. It does not say what SHOULD happen for
this request. A behaviour constraint narrows the permitted choices without becoming a source of authority.

**What frameworks give and do not give.** LangGraph, the Microsoft Agent Framework and the OpenAI Agents SDK supply
mechanisms — tool loops, typed workflow graphs, guardrails, application context kept apart from model context,
build-time checks. None establishes that a well-typed step is the correct interpretation of a sentence, which
relationship makes someone "my daughter", or which treasury was meant. FIDES-style label propagation enforces
declared information-flow rules, not recipient intent. The lesson this spec applies: **reliable behaviour comes
from limiting what the model must infer, preserving the information needed to check its choices, and enforcing the
resulting constraints outside the model.** A framework adapter is welcome; the capability semantics, the authority
model and the fulfillment requirements must survive whichever harness executes them.

### 0.1 What the review could not see — where it steers and where the code already differs

The review was written without access to either repository, so it is **directional, not gospel**. Where it
assumed a gap this repo has already closed, the spec says so rather than re-opening it:

| Review assumption | What the code does today | Consequence for this spec |
| --- | --- | --- |
| admission "risks becoming a collection of special cases" | the rules read tool declarations (`verbs`, `subject`, the compiled `inputSchema`) and the asker's own link names — no rule reads English beyond "opens with a declared verb"; the compiled sentence shapes (`orgPhraseOf`, `paymentAskOf`, `affiliationAskOf`) are separate, counted, and named for retirement (§12) | keep admission declarative; retire the shapes into declared domain operations (§7) |
| SKILL.md might be treated as the canonical capability | ADR-0050/0051 and the capability reference already make the playbook guidance that SUPPORTS a capability; the definition (`capability-claims`) is canonical; `verbs`/`utterances` were added to the CONTRACT that compiles into the definition tool, not to the playbook's authority | unchanged; §2 says where each obligation lives |
| the cross-agent hop is "a competing transport" | spec 366 R1 posts the same step to the subject agent's own `/harness/ask` with the asker's session; the receiver re-verifies the session and derives standing from ITS OWN admission record; nothing sender-admitted is trusted | R2 replaces the envelope with an A2A extension profile (§8) — the receiver-side re-verification is already the doctrine |
| application context may live only in the prompt | spec 353's `AskScopeV1` is consumed before the authority stage and reaches no verifier; the realm is a reference, and the session — not the sentence — names the asker | §7's "context separate from model context" is a confirmation, not a change |
| "both receipts cite each other" | that was this spec's first draft's phrase; nothing circular was built — the routed answer carries the receiver's `runRef` in a `via` block | §8's causal chain R→S→T is the construction to build |
| realization contracts exist and can be extended | they exist in the architecture document and in spec 330 §7 as PARKED SHACL shapes; the running contract is `SkillExecutionContractV1` + `DefinitionToolV1` (typed, validated, compiled) | §2 extends the RUNNING artifacts, and unparks only the executable subset spec 330 describes |
| every capability needs its own vertical slice | the payment, invite, team-create, message, revoke, profile and household acts already run through one loop, one verifier, one receipt shape | wave 2's "two capabilities" is an enforcement depth target, not a rebuild |

Where the review is simply right and the code is not yet there — typed unresolved dependencies, outcome classes,
execution binding, causal receipts, idempotent effect identity, sourced grounding, scoped confirmation memory,
held-out evaluations, a planner trace — the waves in §11 carry it.

## 1. The path, and the three questions

```
original request + explicit application context
        ↓
ExecutionIntent — the requested OUTCOME and constraints, with the provenance of every value  (§3)
        ↓
ExecutionPlan — a proposed way to achieve it                                                     (planner)
        ↓
ADMITTED next step, with resolved, checked bindings                                              (§4, §5)
        ↓
existing authority checks → operation                                                            (spec 350 §3.6, unchanged)
        ↓
observed result
        ↓
REALIZATION and FULFILLMENT checks                                                               (§6)
        ↓
continue · ask · refuse · report pending · conclude
```

Meaning must not be reinvented at any arrow. Three questions, first-class and separately answered, straight from
the realization contract's own example (a declined consultation CONFORMS to the contract without fulfilling the
request):

| Question | Asked of | Answer kinds |
| --- | --- | --- |
| **Admission** | the next step | permissible and sufficiently specified toward the requested outcome — or a named violation with a recovery |
| **Execution** | the operation | ran under valid authority and current preconditions — or denied / failed |
| **Fulfillment** | the evidence | what the result ESTABLISHES about the requested outcome — and therefore what may be claimed |

A well-formed refusal is a valid execution that fulfils nothing. An accepted payment task is valid without the
payment having settled. A 200 can carry a business failure.

## 2. The CapabilityDefinition carries the obligations; the playbook references them

Extend `CapabilityDefinition` (the ADR-0051 canonical artifact, `@agenticprimitives/capability-claims`) and its
semantic profile — **not** the playbook's authority — to specify, per capability:

- **Before execution:** required roles (`PARTY_ROLES` today), argument constraints, **acceptable binding
  sources** (user words · validated application context · resolver in the asker's private tier · a prior confirmed
  choice), permitted effects, clarification conditions.
- **During execution:** freshness requirements, effect boundaries, retry behaviour, conditions requiring
  revalidation (changed recipient, changed contract version, revoked mandate, changed approval).
- **After execution:** the possible outcomes, the evidence each requires, and what may truthfully be claimed for
  each (§6).

The SKILL.md playbook teaches strategies, terminology, examples and recovery behaviour. It **references** these
semantics and never privately redefines them (capability-architecture §8 invariant 7, ADR-0050). Dependency
direction is unchanged: semantic profiles and definitions precede playbooks, plans and executions.

**The compiled executable subset.** From compatible structured artifacts the build produces tool schemas, admission
validators, planner examples, UX field requirements and outcome validators. **Engineering limit:** arbitrary
ontology rules or SHACL shapes do not translate losslessly into JSON Schema or a validator. Define the supported
executable subset, version it, **reject** what it cannot express (never drop it), and test agreement between every
compiled validator and its source contract — otherwise the compiler is one more place where semantics silently
disappear.

## 3. ExecutionIntent preserves the request and the provenance of every value

A deterministic gate cannot rescue a wrongly interpreted goal: if the model turns "send my daughter $50" into
`goal: retrieve household information`, a checker comparing plan to goal approves a consistent, wrong pair.
Interpretation stays a separate reliability problem (examples, tool design, context, held-out evaluations,
selective clarification — §10). What the substrate CAN do is refuse to let interpretation overwrite the request:

- The **original request** is kept beside a **versioned interpretation**.
- Every bound value carries its **source**: supplied by the person · obtained from validated application context
  (the selected organization — a reference, never only a sentence in the prompt) · established by a resolver ·
  remembered from a prior confirmed choice · **still unresolved**.
- A re-planner may change the proposed MEANS. It may not silently change "send the payment" into "tell the person
  about payments" to obtain an admissible plan. The requested outcome is a property of the intent, not of the plan.
- `apexec:ExecutionIntent` (runtime) stays distinct from `apint:Intent` (signed, lifecycle-managed); a chat turn
  does not become a durable signed intent object.

## 4. Admission — the next executable portion, with typed unresolved dependencies

**Shipped 2026-09-07 (first draft W1):** `OrchestrationPorts.planAdmission` in the loop, deterministic rules over
declarations (`instruction_answered_by_read` from `ToolSpec.verbs`; `subject_unnamed` from `ToolSpec.subject` and
the asker's own link names; `placeholder_argument`), one re-plan told why, then `denied`. Kept, and refined:

1. **Admit the next executable step, not only a fully resolved end-to-end plan.** A plan may contain **typed
   unresolved dependencies**; what admission forbids is an executing step that CONSUMES an unresolved value its
   contract requires. "Make a payment" with the beneficiary unresolved blocks the payment — not the authorized
   relationship lookup, the retrieval of eligible source accounts, or the targeted clarification that resolves it.
2. **Violations name the field and a recovery path**, as stable codes: `REQUIRED_ROLE_UNRESOLVED`,
   `RESOURCE_SCOPE_MISMATCH`, `CAPABILITY_UNAVAILABLE`, `UNSUPPORTED_BINDING_SOURCE`, `DEPENDENCY_NOT_SATISFIED`,
   `OUTCOME_NOT_ESTABLISHED` (the fulfillment-side twin, §6). The shipped codes map onto these
   (`instruction_answered_by_read` → `OUTCOME_NOT_ESTABLISHED` at plan time; `subject_unnamed` →
   `REQUIRED_ROLE_UNRESOLVED` with the field named).
3. **Convergence.** A repeated identical violation does not re-plan again; it converges on a clarification, an
   explicit limitation, or a refusal. (Shipped: one re-plan; the rule generalises to "no identical repeat".)
4. **No syntactic special cases.** The verb rule is a stand-in until §6's outcome requirement is compiled from the
   definition: "the plan contains no step whose declared outcome class can discharge the requested outcome" is the
   rule; "the sentence opens with a verb" is today's approximation of it, and the scenario set is what will retire it.

## 5. Execution binding — the operation retains what was admitted

When a protected operation becomes executable, a **checked association** is required among: the ExecutionIntent
and its version · the CapabilityDefinition and version · the principal and acting role · the service agent ·
the resource owner and target resource · the resolved arguments (with sources) · the confirmation / authority
references · the expected outcome · a **stable logical operation identity** (§8). This extends the existing
execution and invocation structures (spec 330 §9's `ToolInvocation` sub-activity, the receipt) rather than
minting new ontology classes. The property that matters: **the executor cannot silently substitute a different
organization, treasury, recipient or operation after admission.** Provenance remains evidence and is never an
authorization input (capability-architecture §8 invariant 13).

## 6. Fulfillment — an outcome requirement, not "the last tool must be a payment"

For "send money to my daughter", a relationship read may be exactly the right preparatory step, and a
notification a legitimate final one. The failure is not that a read occurred; it is that **a read was allowed to
discharge a payment obligation.** The definition therefore classes what each operation ESTABLISHES:

| Outcome class | Establishes | Does not establish |
| --- | --- | --- |
| relationship / roster lookup | who was meant | that anything was sent |
| payment submission | acceptance or pending execution | settlement |
| authoritative payment result | the outcome appropriate to that rail (a receipt, a tx) | — |

Admission asks at plan time whether some step's class CAN discharge the requested outcome; fulfillment asks after
execution what the evidence DID establish, and the composer may claim only that (spec 358 W3's grounded
composition, extended from evidence-bounded prose to outcome-bounded prose). For qualitative outcomes, objective
checks are separated from assessed quality — an evaluator's judgment is never dressed as certainty.

## 7. UX and Ask share command and clarification semantics, not only a transport

A conventional UI supplies meaning through interaction: the person selects an organization, opens a team, picks
a person, clicks. By the time the request reaches the endpoint the ambiguities are gone. Ask receives "add David
to the team", and using the same endpoint reproduces none of that. Both surfaces work toward the same **command**
(`add member: organization · team · person · role`), the UI filling values through controls and Ask through
language, current context, authorized resolution and choices. A missing value returns the same **structured
requirement** (a choice among eligible teams); the UI renders a selector, Ask asks the question, both resume the
same operation. This is spec 361's parity made operational, and it is stronger than deriving a SKILL.md from a
screen.

**Application context stays separate from model context.** The model proposes a named party or candidate; trusted
code resolves and checks the binding; the operation receives the checked binding, never the model's replacement. A
validated current selection may supply a missing organization; "the first organization available" is never an
implicit fallback (ADR-0013). Common actions need no open-ended planning: once capability and parameters are
understood, a tested domain operation supplies the execution structure (the compiled shapes in `harness-run.ts`
are the first, regex-era form of this; they become declared domain operations on the definition).

## 8. Cross-agent coordination — effect semantics, not only a typed envelope (absorbs spec 366 R2)

- **An A2A application profile**, versioned, using A2A's messages/tasks/artifacts and its extension mechanism —
  never a competing transport.
- **Send the externally meaningful delegated request and its causal correlation, not the caller's internal
  plan.** The receiver independently checks the capability request, the addressed principal AND service (a
  treasury's service endpoint is not its enduring principal identity), the resource bindings, current authority
  and preconditions. "The sender admitted this" is never sufficient.
- **Causal, not circular, receipts:** A sends request R; B issues result receipt S referencing R; A records
  acknowledgment T referencing S. Evidence establishes what was requested, what the receiver reported and what the
  caller observed; the contract says which evidence source proves a real-world outcome.
- **Duplicate effects after an uncertain response are the real danger.** A committed payment whose response is
  lost, retried by a durable step, must not be paid twice. A **stable operation identity enforced at the effect
  owner**: the same identity with different contents is a conflict, never a new interpretation. The caller
  distinguishes `failed before effect` · `accepted/pending` · `committed` · `outcome unknown`, and unknown leads to
  **reconciliation**, never to another effect under a new identity. Final authority and state checks happen at
  the resource owner's commit boundary; a changed approval, recipient, contract version or revoked mandate
  requires revalidation; a retry of a committed effect locates the existing result.

## 9. The private graph is a grounding service, not a larger prompt

The T-box and R-box give vocabulary and inference; they do not establish who Alice CURRENTLY belongs to, which
role assignment is active, or whether a relationship is current and disclosable for this request. OWL is
open-world (a missing assertion is not false); SHACL validates structure, not completeness or truth. So the
relationship resolver returns **scoped, sourced bindings**: bounded relation patterns, types, context and time;
constrained depth, fan-out and data sources; results that distinguish asserted from inferred, carry source and
freshness, and say when the answer is partial — so that "I found no accessible membership records" is never
rendered as "you are on no teams". Per-vault projections stay separate from access authority (ADR-0025/0055); no
central relationship database with broader disclosure. **Delivery:** the minimum reliable party-and-resource
resolver the first contracts need, then generalise (`person.affiliations.list` and `resolveParty` are that
minimum today).

## 10. Memory, evaluation, and what the planner actually received

- **A confirmed choice is evidence about a choice, not permission.** When Alice picks `david.me`: *for Alice,
  resolving "David", as a payment recipient, in this context, the last confirmed selection was david.me.* Recorded
  through a trusted interaction event (the resume that supplied the answer), never because a model wrote "the user
  confirmed"; used to prefill or rank; scoped, correctable, revalidated; never a fresh grant. Clarification state
  (a run asking the same question twice because it lost its pending choice) is a run/resume defect, kept separate.
- **Three fixture sets, one format:** planner examples (teach — in the prompt), regression fixtures (reproduce
  known failures), **held-out evaluations** (unseen phrasing, combinations, ambiguity, state change — never in the
  prompt). The first draft's W2 shipped the first two as one set (`utterances` in the definition, replayed by
  `check:ask-scenarios`); the held-out set is a separate file the compiler never sees. Test outcome correctness
  AND invariant preservation (no unrelated vault read, no unconfirmed recipient, no duplicate transfer, no
  settlement claim without evidence) — never one exact tool sequence when several are correct.
- **Capture what the planner actually received.** Before blaming the model, a failing trace answers: was the
  capability exposed; which contract and playbook versions; was a description truncated; which tools survived
  selection; what application context was present; which bindings were unresolved; what did the executor receive.
  The deployed planner consumes the context assembled for that turn, not this document.
- **Test the gates without an LLM:** inject malformed plans, changed resource references, stale approvals,
  replayed requests — separating failures of interpretation from failures of enforcement.
- **Measure safety and usefulness:** wrong-scope operations, duplicate effects, unsupported completion claims;
  successful fulfillment, unnecessary clarification, false refusal, latency. A gate that stops everything has not
  solved the product problem.

## 11. Waves and exit gates

| Wave | Scope | Exit gate | Already in place (first draft) |
| --- | --- | --- | --- |
| **1. Make failures reproducible** ✅ 2026-09-07 | `PlannerTraceV1` on EVERY reply kind (`harness-run.ts`): which planner proposed (supplied / compiled / model), the tool ids exposed, the playbook digest, the prompt digest, examples rendered, every admission verdict, the plan the executor received, each binding with its SOURCE (said / decision / memory / resolver / disclosed); rendered in the Home's How pane (`PlannerTraceView`) | each failure is attributable to interpretation, binding, admission, execution or fulfillment — never "Ask failed" | admission verdicts + `PlanRefused` events; playbook digest on receipts (354 K4); `check:ask-scenarios` |
| **2. Enforce two capabilities end to end** ✅ 2026-09-07 (payment + membership invite) | **outcome classes** `establishes: lookup \| submission \| authoritative` on the contract → definition tool → `ToolSpec` (compiler defaults: read = lookup, act = authoritative; invite and resolution-request declare `submission`); admission's instruction rule is now the §6 outcome rule (`OUTCOME_NOT_ESTABLISHED`: no step can discharge the instruction), plus `DEPENDENCY_NOT_SATISFIED` (a `$ref`/`forEach` no earlier step provides) and `CAPABILITY_UNAVAILABLE`; every violation carries `field` + `recovery`; **execution binding** `ExecutionBindingV1` on every receipt (intent digest, principal, subject, resource, authority, expected outcome, operation id, arg sources); **fulfillment** on the `done` reply — the Home says "Submitted — …" for a submission and "Done — …, on chain" only for an authoritative outcome. Typed unresolved dependencies at execution time are `resolveStepArgs` + `InputRequired` (the consuming step asks; earlier steps run) — already the loop's behaviour, now stated. **Open in this wave:** `RESOURCE_SCOPE_MISMATCH` (the request's scope vs the step's resource, beyond the subject rule); revalidation conditions; a fulfillment check that reads the chain rather than the receipt for `authoritative`. | wrong-scope blocked; missing information requested; an unsupported success claim impossible through the normal completion path | admission rules; `subject` routing; org-side standing |
| **3. Unify UX and Ask** | shared commands, structured missing-information, pinned compiled projections, planner examples + regression fixtures | equivalent UX and Ask requests resolve to equivalent bound operations and outcomes | 361 I4 supplied plans; `utterances` → few-shot; `check:ask-scenarios` |
| **4. Complete distributed semantics** | A2A profile, receiver verification, causal receipts, stable operation identity, unknown-outcome reconciliation (spec 366 R2–R4 absorbed) | two independent Homes work without special-case routing; lost replies and retries do not duplicate effects | 366 R1 routed ask (ad-hoc envelope, to be replaced) |
| **5. Generalise grounding and memory** | bounded private relationship queries; context-scoped confirmation preferences | new relationship questions and a second domain capability arrive mostly through declarations | `person.affiliations.list`; 358 W5 preferences |

Fixtures belong in wave 1, not in a later testing phase. Portable checks and types fit existing Ring-0 boundaries
(`orchestration`, `capability-claims`, `context`, `evaluation`); D1/Cloudflare execution, graph adapters and A2A
transport stay adapters; no new package without an independent boundary (spec 351 §2.4).

## 12. Boundaries (the drift to refuse)

A second model as an admission rule · a regex over English in the loop (today's compiled shapes are named,
counted, and retired by declared domain operations, never extended) · admission that repairs or resolves ·
"known names" from the public directory · planner examples reused as the held-out set · a replan that lowers
the requested outcome · a sender-admitted plan trusted by a receiver · an effect retried under a new identity ·
a remembered alias that grants · provenance consulted by any gate.

## Reference: patterns to port

*smart-agent* (branch `003-intent-marketplace-proposal`) validates a proposal against its schema before it enters
the marketplace and rejects with named reasons (`docs/specs/needs-resources-plan.md`,
`round-trip-trust-deposit-plan.md`); ported: reject by name before acting, re-propose once. *OpenAI Agents SDK:*
local application context kept apart from what the model sees; tool visibility ≠ authorization of arguments.
*Microsoft Agent Framework:* build-time workflow checks (types, reachability, bindings) — the shape of our compiled
validators. *Cloudflare Workflows:* steps retry, so effects need idempotency at the owner. *LangSmith:* evaluate
final response, individual decisions and trajectories separately; exact-trajectory matching is the wrong gate.
*A2A:* extensions carry application semantics; message-level duplicate detection is optional, so exactly-once is
ours to enforce. Divergent throughout: every declaration is compiled from the capability definition and its
contracts, never hand-written per feature; every gate sits inside the run in front of the verifier; provenance
is evidence and never authority.
