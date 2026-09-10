# Spec 393 — Decisions by declared approvers, and the coordinator's offers and allocations through the Ask

**Status:** W1 ✅ 2026-09-10 (live on faithnet: `verify-endeavor-decision` in the nightly ledger) · W2 open · **Kind:** Endeavor conformance (priorities Tier 1.4; the decisions half of spec 333 §3) — reducer commands + events, three T-box classes, two serving-plane doors, two Ask capabilities with their contracts, the Home's already-built cards lit · **Grounds:** [spec 333 §3](333-coordination-decisions-profiles-rules.md) (`DecisionRequest` / `DecisionRecord` / `ApprovalRequirement`; "actor satisfies the ApprovalRequirement — quorum verified by the gate, not the reducer; record immutable"), [spec 332 §9](332-coordination-endeavor-core.md) rule 1 (nothing coordination-shaped is authority), [spec 382](382-committed-steps-run-at-the-participant.md) (the conformance-wave pattern: one reducer rule, one door, one Ask capability, one live twin), [spec 334 §7](334-coordination-work-surface.md) (My Work), [ADR-0054](../docs/architecture/decisions/0054-coordination-endeavor-doctrine.md), the coverage ledger row `approvals-decisions` (`specified` → `implemented`)

## 0. The gap

The Home has carried decision cards since spec 334 — *A decision is waiting on you — respond below*, an
Approve and a Reject button on My Work and on the endeavor detail — and `recordDecision` posts
`endeavor.decide` to the organization's door, which answers **501: decision recording ships with the
spec 333 wave — the coordination package has no `RecordDecision` command yet**. The detail projection
returns `decisions: []` unconditionally. Every framework's approval step (LangGraph `interrupt`, MAF's
human-in-the-loop, Jira/ServiceNow approvals) records *who clicked*. What the substrate has to answer, and
cannot yet, is **who was declared to decide, whether the one who did was among them, and that the record
cannot be edited afterwards** — with the steward's standing counting for the organization only when the
organization was named, never by itself.

The second half of Tier 1.4 — the coordinator's offers and allocations *through the Ask* — has
capabilities (`coordination.contribution.propose` / `.allocate`, 334 W-era) and contracts, but no live
twin has ever driven them conversationally with the negative beside the positive.

## 1. The rule, stated once

**A decision is recorded by a declared approver, once, and the record is immutable.** A
`DecisionRequest` names its `ApprovalRequirement` — the addresses that may decide (the organization
itself may be one of them, in which case a steward decides *as the organization*). `RecordDecision` is
admitted by the reducer only when the actor is among them; steward standing never substitutes for being
named. The serving plane's door decides WHO the session may act as (a steward acts as the organization,
anyone else as themselves — the same rule as `endeavor.milestone.achieve`); the reducer decides whether
that actor may decide THIS request. `approved` and `rejected` close the request; `deferred` leaves it
pending and is itself a record; a request once closed refuses every further record — a reversal is a
new request citing the old. **Nothing here is authority** (332 §9 rule 1): an approval records that a
decision was made; what any step may then DO is still its mandate at its gate.

## 2. The shape

| Piece | What | Where |
| --- | --- | --- |
| **types** | `ApprovalRequirementV1 { approvers: Address[]; quorum?: number }` (quorum defaults to 1; >1 is W2 — recorded, not yet counted) · `DecisionRequestV1 { decisionId, endeavorId, decisionKind, title, summary?, requestedBy, requirement, scope: { stepIds? }, requestedAt, dueAt?, status: 'pending' \| 'decided' }` · `DecisionRecordV1` exactly as spec 333 §3 (`actor`, `principal`, `outcome`, `rationale`, `evidenceRefs`, `scope`, `decidedAt`) | `coordination/src/decisions/types.ts` (the reserved `DecisionRequestV1` becomes real) |
| **commands** | `RaiseDecisionRequest` (actor: managing principal, a steward, or an active participant; ≥ 1 approver; a request id unused) · `RecordDecision` (actor ∈ approvers — the managing principal counts when the organization is named; request pending; rationale required) | `core/commands.ts`, `core/reducer.ts` |
| **events / state** | `DecisionRequested { decisionId, request }` · `DecisionRecorded { decisionId, record }`; `state.decisionRequests`, `state.decisions` (the closing or latest record per request) | `core/events.ts`, `core/reducer.ts` |
| **T-box** | `apcoord:DecisionRequest`, `apcoord:DecisionRecord`, `apcoord:ApprovalRequirement` ⊑ `prov:Entity` (spec 333's table, finally declared) | `ontology/tbox/coordination.ttl` |
| **doors** | `endeavor.decision.request { endeavorId, title, decisionKind?, summary?, approvers[], stepIds?, dueAt? }` and `endeavor.decide { endeavorId, decisionId, outcome, reason }` — actor = the organization when the session is a steward, else the session; the reducer re-gates | `demo-a2a/src/endeavors.ts` |
| **projections** | `endeavor.get` → `decisions[]` (every request with its latest record); `endeavor.list` `mine.decisions` → the requests PENDING FOR THIS VIEWER (named directly, or the organization named and the viewer a steward) in the `DecisionRow` shape the Home already renders | `endeavors.ts` |
| **Ask** | `coordination.decision.request` and `coordination.decision.record` — tools bound to the doors (`coordination-bindings.ts`), contracts `org-endeavor-decision-request` / `org-endeavor-decide` in `~/skills`, attached to the `coordinator` and `org-steward` archetypes by the registration script | `coordination-bindings.ts`, `harness-run.ts` tables, `~/skills` |
| **Home** | nothing new to build: My Work's decision cards and the detail's "A decision is waiting on you" go live the moment the door answers | — |

## 3. Boundaries (the drift to refuse)

- **Steward ≠ approver.** A steward who is not named, and whose organization is not named, is refused
  by the reducer with those words. The Home's card comment already says it: *steward status never
  substitutes*.
- **The reducer never reads standing.** Whether a session may act as the organization is the door's
  question (the stewardship wire, verified on chain); the reducer sees an actor address and a request.
- **Immutable.** No `UpdateDecision`. A closed request is closed; the record is the record.
- **Quorum is organization/custody machinery** (333 §10 rule 3). W1 records `quorum` and admits the first
  approver's record; counting toward a quorum > 1 is W2 and stays outside the reducer's vote-free design.
- **A decision satisfies nothing by itself.** A decision-kind plan step is satisfied by the coordinator
  citing the record (`urn:ap:decision:<id>`) as evidence, through `endeavor.satisfyStep`, exactly as any
  step. No auto-satisfaction (W2 may add it as a declared consequence).
- **An approval is not a mandate** — the same sentence as 382 §3.

## 4. Waves + gates

| Wave | Delivers | Gate |
| --- | --- | --- |
| **W1** ✅ | the types, commands, events, reducer rules; the three T-box classes; the two doors and both projections; the two Ask tools + contracts + registration; the coverage-ledger row → `implemented` | unit (`reducer.test.ts`): raise by a steward; record by a declared approver → `DecisionRecorded`; a non-approver refused; an un-named steward refused; a second record on a closed request refused; deferred keeps it pending; approved closes it; the request id must be unused. **Live (no model)** `scripts/verify-endeavor-decision.mts` on Missio Nexus: alice (steward) raises a request naming carol → carol decides `approved` → bob refused (not named) → alice refused (steward, not named) → carol again refused (closed) → the detail's `decisions[]` shows the request decided by carol; carol's My Work listed it pending before and nothing after |
| **W2** | the coordinator's offers and allocations THROUGH THE ASK as a live twin: carol says *I'll take the flyer step* (propose), alice says *allocate the flyer step to carol* (allocate); the twins — a non-member's offer refused at the member gate, a member's allocation refused as not the organization's steward. Quorum > 1 counted. A decision-kind step auto-satisfied by its approval as a declared consequence (360) | `scripts/verify-endeavor-offer-allocate-ask.mts` (four asks, two refusals) |

## 5. Not this

Not risks, impediments, health assessments, progress reports, profiles, rules or collections (the rest
of spec 333 — each its own wave). Not a voting system. Not a change to what any capability's mandate
requires.

## Reference: patterns to port

Jira/ServiceNow approvals and MAF's HITL checkpoints record the approver's identity and the outcome;
diverged on: the approver is DECLARED on the request before anyone decides, the record is immutable by
construction (a reversal is a new request), and the organization's standing is a named approver, never
an implicit one. `smart-agent`'s `RoundDecisionWindowEnforcer` (333 §11) informs `dueAt` — a window is
declared, and a late record is refused by the reducer once `dueAt` has passed (W1: refused with the word
*expired*).

## W1 as shipped (2026-09-10)

- `coordination`: `DecisionId` (`dec_`), `ApprovalRequirementV1` / `DecisionRequestV1` / `DecisionRecordV1` (`decisions/types.ts`), `RaiseDecisionRequest` / `RecordDecision`, `DecisionRequested` / `DecisionRecorded`, `state.decisionRequests` / `state.decisions`. The un-named steward is refused with the words *steward standing never substitutes*; a closed request with *already decided — a reversal is a new request*; a late record with *expired*.
- `endeavors.ts`: `endeavor.decision.request`, `endeavor.decide` (steward → `actor` = the organization, `principal` = itself; `approve/deny/defer` synonyms accepted); `decisionRowsOf` feeds both `endeavor.get.decisions[]` and `mine.decisions` (`approver` = the address the viewer decides under, `mayDecide`, `decidesAs`). The Home's decide now carries the stewardship wire.
- Ask: `coordination.decision.request` / `coordination.decision.record` (bindings + harness tables + `NOT_PLAN_STEPS`); contracts `org-endeavor-decision-request` / `org-endeavor-decide` published and attached to `coordinator` + `org-steward` (`~/skills/scripts/register-endeavor-decision.mjs`).
- Ontology: `apcoord:ApprovalRequirement/DecisionRequest/DecisionRecord` in the T-box and `packages/ontology/src/index.ts`; ledger row `approvals-decisions` → `implemented`.
- Found on the way: Missio Nexus's own interactions grant had gone stale (every non-steward read `auth failed — mcp`); re-issued with `scripts/reissue-service-grant.mts`. The live script pauses auto-work and reads `endeavor.list` sparingly — one list is a read of every endeavor's log, and the organization's vault budget (120 verified calls/min) is what fails first.
