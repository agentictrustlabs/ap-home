# Spec 334 — Coordination work surface: serving plane, Home Request, org Work, My Work

**Status:** draft (2026-07-19) — Track D wave 2 (serving plane) / wave 3 (UX + Home projections) / wave 4 (execution binding + entry-point adapters)
· **Doctrine:** [ADR-0054](../docs/architecture/decisions/0054-coordination-endeavor-doctrine.md) (Endeavor doctrine + normative coverage), [ADR-0044](../docs/architecture/decisions/0044-a2a-is-the-agentic-orchestration-layer.md) (intent-first — first-party web expresses INTENTS, never drives MCP directly), [ADR-0041](../docs/architecture/decisions/0041-web3-authority-not-oauth-on-a2a-to-mcp.md) (Web3 authority), [ADR-0040](../docs/architecture/decisions/0040-knowledge-base-only-public-onchain-data.md) (public-only KB), [ADR-0021](../docs/architecture/decisions/0021-generic-packages-vs-white-label-apps.md) (portable contracts vs app surfaces), [ADR-0013](../docs/architecture/decisions/0013-no-silent-fallbacks.md)
· **Extends:** [332](332-coordination-endeavor-core.md) (semantic core: records, commands, events, reducer, provenance), [333](333-coordination-decisions-profiles-rules.md) (decisions/recommendations/profiles/rules/resources/collections)
· **Coverage ledger:** [coordination-capability-coverage.yaml](../docs/architecture/coordination-capability-coverage.yaml) — the rows this spec advances are tagged `spec: 334` (chiefly the projection + runtime-behavior coverage forms)
· **Surfaces:** `apps/agent-runtime` (`InteractionsDO` `endeavor.*` ops, `A2aTaskDO` execution binding), `apps/home` (person + org portal Work surfaces), `packages/home` (portable coordination projections), `packages/fabric` (`ContextRefV1` kind `'endeavor'`)

---

## 1. What this spec is

Spec 332 defines the Endeavor machinery (records, commands, events, reducer); spec 333 defines decisions, recommendations, profiles, and rules. Neither serves a byte. This spec is the **work surface**: the serving plane that verifies, gates, and appends coordination commands; the four normative entry points that feed it; and the product projections — Home Request, org Work, person My Work — that render it. Everything here is projection and runtime behavior over the 332/333 canon; this spec mints **no** new semantic class.

**Intent-first (ADR-0044) is load-bearing:** every surface below expresses a *goal* (`EndeavorRequest`, signed command) to the serving plane. No portal view calls an MCP tool, names a tool, or sequences calls.

## 2. Scope and non-goals

**In scope:** `endeavor.*` ops on `InteractionsDO` (the reference serving plane); entry-point adapters (Home Request, discussion `@ask`, inbox ask, A2A intent); demo-sso-next Work UX; `packages/home` coordination projection contracts; fabric context linking; agent triage surface; the product-surface projection table; privacy residency.

**Non-goals:**

- Record semantics, reducer, provenance projection → **spec 332**. Decision/recommendation/rule semantics → **spec 333**. This spec adds no command the 332/333 catalogs don't define.
- No new authority surface: the ops below verify and gate; they never mint delegation/entitlement, and no gate reads an `apcoord:` record (ADR-0054 §4).
- Vendor adapters, external runtimes, calendar/email bridges → external repos (ADR-0037).
- Later projections (calendar, timeline/Gantt, workload, portfolio, analytics) are *named and sourced* here (§11) but not built in these waves.

## 3. Serving plane — `InteractionsDO` `endeavor.*` ops

The org/person interactions DO (`apps/agent-runtime/src/interactions-do.ts`) gains an `endeavor.*` op family following the `channels.*` pattern **exactly**: session signature verification at ingress, steward/member gates via the DO's directory listings (`memberName` / `isSteward` with stewardship wire), all reads/writes over the interactions **grant** into the managing principal's vault, shared-doc read-modify-writes inside `serialize()` (ARCH-H1), an **audit row before commit** for every mutation, and vault resource keys from spec 332's record catalog.

| Op | Actor gate | Effect (332/333 command) | Serialized RMW docs |
| --- | --- | --- | --- |
| `endeavor.list` | member or steward | read-only: index rows the caller may see (§12 visibility) | — |
| `endeavor.get` | participant, member (open endeavor), or steward | read-only: one endeavor + adopted plan + participations + decisions | — |
| `endeavor.request` | any authenticated session (requester signs) | `SubmitEndeavorRequest` → `EndeavorRequestSubmitted` | `coordination.requests` |
| `endeavor.create` | steward/coordinator of the managing principal | `AdoptEndeavor` from a pending request (or `DeclineEndeavorRequest`) | `coordination.index` + `coordination.endeavor:<id>` |
| `endeavor.proposePlan` | participant | `ProposePlan` → `PlanProposed` (contentHash computed server-side) | `coordination.plan:<id>` |
| `endeavor.adoptPlan` | coordinator/sponsor only | `AdoptPlan` → `PlanAdopted` (exact revision hash; supersedes prior) | `coordination.endeavor:<id>` + `coordination.plan:<id>` |
| `endeavor.propose` | participant or invitee | `ProposeContribution` → `ContributionProposed` | `coordination.participation:<id>` |
| `endeavor.allocate` | coordinator | `AllocateContribution` → `ContributionAllocated` — **grants nothing** | `coordination.participation:<id>` |
| `endeavor.commit` | the allocated participant themselves | `CommitContribution` → `ContributionCommitted` | `coordination.participation:<id>` |
| `endeavor.decide` | the declared approver (spec 333 `ApprovalRequirement`) | `RecordDecision` → immutable `DecisionRecord` | `coordination.decisions:<id>` |
| `endeavor.post` | participant, member, or steward | fabric CommunicativeAct with `contextRefs: [{ kind: 'endeavor', … }]` — conversation, **not** a coordination event | topic doc (channel pattern) |

Serving-plane rules (normative):

1. **Event append is the only mutation.** Each mutating op validates the corresponding spec-332 command, appends its event(s) to `coordination.endeavor:events:<id>`, re-runs the pure reducer, and writes the projected record docs — inside one `serialize()` block. No op writes a projected doc without its event.
2. **Authority invariants are enforced server-side, never trusted from the client:**
   - **Allocation grants nothing.** `endeavor.allocate` records selection only; the DO asserts no delegation, entitlement, or grant as a side effect.
   - **Commitments are signed by the participant.** `endeavor.commit` verifies the participant's signature (ERC-1271/6492/ECDSA/WebAuthn via the universal paths, fail-closed) over the commitment payload **including the exact adopted plan revision hash**; a stale or mismatched hash is rejected with 409, never coerced.
   - **Decisions require the declared approver.** `endeavor.decide` resolves the `ApprovalRequirement` (spec 333) and rejects any other session — steward status does not substitute for a named approver.
   - **Conversation never mutates state.** `endeavor.post` writes fabric messages only; the DO never infers a coordination event from message text (spec 332 §9.3).
3. **Audit:** every mutating op writes an `audit.write` row (`action: 'interactions.endeavor.<op>'`, actor = session SA, subject = the endeavor/plan/commitment/decision id) with the same before-commit ordering `channels.*` uses.
4. **One mechanism (ADR-0013):** a failed gate or failed command validation returns an error; there is no weaker fallback path, and reads that find nothing return empty.

## 4. Entry points — one engine, four doors (normative, ADR-0054 §2)

Every door produces an `EndeavorRequestV1` (spec 332 §5) and drives the same `endeavor.*` machinery. The door sets `entryPoint` + `intakeContext` + default profile — never a different model.

| # | Door | `entryPoint` | Intake path | Intake context |
| --- | --- | --- | --- | --- |
| 1 | **Home Request** — a person or org agent initiates from Home | `home-request` | Goal posted via the fabric REQUEST rail carrying the `EndeavorRequest` (intent-first, ADR-0044) — **never a tool call** | target principal; optional profile fields |
| 2 | **Discussion question** — `@ask` in a discussion topic | `discussion-ask` | The org-assistant turn (spec 327) converts the ask into an `EndeavorRequest`; the topic's `ContextRefV1` becomes `intakeContext` | the topic + triggering message refs |
| 3 | **1:1 inbox agent ask** — the person-assistant turn (spec 328) | `inbox-ask` | Inbox envelope → `EndeavorRequest`; the envelope ref is the intake context | the inbox message ref |
| 4 | **A2A intent/task response** | `a2a-intent` | An inbound A2A Task/intent is admitted as an `EndeavorRequest` against the managing principal | the A2A task ref |

Door 2 also re-expresses the spec-329 consultation flow: `find_members → ask×K → synthesis` becomes a **CoordinationPlan profile** (three step kinds: interaction ×K in parallel, then aggregation) — re-expressed, not rebuilt (ADR-0054 consequences). The 329 fan-out is the wave-4 golden fixture (§14).

Door 4 closes the execution loop in both directions: an Endeavor's `PlanStep`s compile to `apexec:ExecutionIntent`s via the `orchestration` package, which execute as A2A Tasks dispatched by `A2aTaskDO` (spec 269) — each Task bound to its `ContributionCommitment` ref, plan revision hash, and step id per the adapter provenance contract (spec 332 §10), so `projectEndeavorProvenance` can join the run trace to the durable plan.

> **W4 shipped state.** The compile step lives in `@agenticprimitives/coordination/execution` (`compilePlanToExecutionIntents`) with the descriptor shape defined locally to spec 330 §8 (importing `orchestration` from `coordination` would be a back-edge); the binding rides the task input as `endeavorBinding` (`apps/agent-runtime/src/endeavor-intake.ts`). Door 4's intake is LIVE and opt-in: an `orchestrate` task whose input carries `endeavor: true` is admitted as an `EndeavorRequest` against the managing principal (requester = the delegation-verified task sender, via the marker-gated `internal.endeavor.request` op — fail-closed, never a silent skip). Doors 2 and 3 ship as body-builder adapters (`endeavorRequestFromDiscussionAsk` / `endeavorRequestFromInboxAsk`): their live triggers are the spec-327/328 assistant turns, and auto-filing from message prose without a UX affordance would violate §3 rule 2d.

## 5. Home Request UX

The explicit product ask: **posting a request is a first-class Home action.**

- **Person portal:** a "New request" action in Messages (and the global quick-action row). The person picks a target — another person, an organization, or their own org context — writes a free-text goal, and optionally fills intake profile fields (spec 333 `IntakeProfileV1`, when the target declares one). Submission produces an `EndeavorRequestV1` posted over the fabric REQUEST rail to the target's serving plane (`endeavor.request`).
- **Org portal:** the same composer inside the **Work** section (§6), targeting the org itself (member raises work) or an external principal (the org requests coordination elsewhere).

Both composers are **goal-first**: the primary field is the goal statement; no view exposes tool names, plans, or call sequences. The request lands as a pending row in the target's Requests/Triage view and, symmetrically, as a `HomeCoordinationAlertV1` (§8) for the requester when it is accepted, declined, or answered.

## 6. Org Work UX — demo-sso-next

New **Work** nav section in the org workspace: `app/(portal)/org/[org]/work/`.

| View | Route | Contents |
| --- | --- | --- |
| Requests / Triage | `work/requests` | Pending `EndeavorRequest`s + agent `Recommendation`s (spec 333) with explicit **accept / decline** actions; accept runs `endeavor.create`, decline runs the decline command — both audited, never silent |
| Endeavor list / board | `work/` | Endeavors grouped by lifecycle / owner / milestone — a simple list and a lifecycle-column board projection over the same rows |
| Endeavor detail | `work/[endeavor]` | Outcome specification + criteria; adopted plan steps with per-step status (the seven-state facts projected honestly — allocated ≠ committed ≠ performing ≠ satisfied); participants + roles; decisions; provenance/activity trail rendered from the `projectEndeavorProvenance` P-Plan graph (spec 332 §7) via the existing trace visualization |
| New request | `work/new` | the §5 composer |

Visibility reuses the existing org-portal relationship gating (member vs steward, as `OrgDiscussionsView` gates on directory membership + stewardship): **members** see open endeavors and their own participations; **stewards/coordinators** see everything including triage, declines, and allocation actions. Routes, branding, and components stay in the app (ADR-0021); the app renders the §8 portable contracts.

## 7. Person My Work

The person portal projects the principal's own coordination facts into the existing Home surfaces — no new nav section in V1:

- **Messages:** decision requests, allocation offers (commit/decline), and endeavor invitations arrive as `HomeActionCardV1` cards (`cardKind` extended per spec 333's decision kinds); pressing a card action only **proposes** a signed lifecycle transition — it grants nothing (spec 310 §6.3 unchanged).
- **Activity:** commitments made, steps satisfied, decisions recorded, and Task progress appear as `HomeControlEventV1` timeline rows backed by the serving plane's audit rows.
- **My Work summary:** active allocations, signed commitments (with deadlines), running Tasks, and pending decisions — projected from `HomeContributionEntryV1` + `HomeDecisionCardV1` (§8), sorted by deadline.

## 8. Home projections — portable contracts in `packages/home`

New portable, deterministic projection contracts (schema + validation + pure projection functions, exactly the `HomeActionCardV1`/`HomeControlEventV1` discipline — no routes, UI, storage, or branding; ADR-0021):

| Contract | Projects | Primary consumer |
| --- | --- | --- |
| `HomeEndeavorSummaryV1` | one Endeavor: title, lifecycle, outcome progress facts, owner role, deadline | org Work list/board; person overview |
| `HomeContributionEntryV1` | one allocation/commitment for THIS principal: step, plan revision, status among the seven states, deadline | My Work |
| `HomeDecisionCardV1` | a pending `DecisionRequest` for THIS approver (render half; transport is the interactions card) | Messages |
| `HomeAgentRunEntryV1` | a Task/ServiceExecution bound to a commitment: state, checkpoints, artifact refs, receipt ref | Agent Runs; Endeavor detail |
| `HomePortfolioSummaryV1` | an `EndeavorCollection` roll-up (spec 333) | Portfolio (later wave) |
| `HomeCapacitySummaryV1` | the principal's offers/reservations vs active commitments (spec 333 resources) | Workload (later wave) |
| `HomeCoordinationAlertV1` | a coordination notification: request answered, step blocked, deadline near, decision overdue | Messages + Activity |

All seven are projections over 332/333 records + audit rows; none is a source of truth, and none carries authority.

## 9. Fabric integration

- **`ContextRefV1` kind `'endeavor'`.** Messages about an Endeavor carry `contextRefs: [{ kind: 'endeavor', … }]`; the Messages view renders an endeavor **chip** mirroring the existing discussion-topic invite chip, deep-linking to the Endeavor detail. Kinds `'endeavor-step'`, `'endeavor-decision'`, and `'endeavor-artifact'` scope finer (app-defined kinds per the fabric contract — no fabric schema change).
- **Discussion topics link to an Endeavor.** A topic may carry an endeavor contextRef (set at `@ask` intake or attached later by a facilitator); the Endeavor detail's Conversations tab filters fabric discussions by that ref.
- **Comments and updates are fabric CommunicativeActs** context-linked to an Endeavor, PlanStep, decision, or artifact. They may **PROPOSE** commands (a message can render an "adopt this plan" affordance) but grant nothing and mutate nothing — the affordance submits a signed `endeavor.*` command like any other door (spec 332 §9.3).

## 10. Agent triage

The assistant turn (spec 327 org-topic / spec 328 person-inbox harness pattern: post-commit trigger, marker-gated internal dispatch, reply pinned to the agent principal) extends to coordination intake: when an `EndeavorRequest` arrives, the managing principal's agent MAY produce a **`Recommendation`** record (spec 333) — proposed classification, duplicate relation, suggested profile/template, candidate participants by capability match, priority.

Recommendation lifecycle is `proposed → accepted | rejected`, decided by a steward/coordinator in the Triage view. A recommendation is **never auto-applied** unless an explicit org `CoordinationRule` (spec 333) permits that specific recommendation class — and even then its effect is an ordinary signed command through the §3 gates. Accepted/rejected outcomes are recorded (events + audit), feeding the agent's evidence trail.

## 11. Product-surface projection table

Every familiar product surface is a deterministic projection over the canonical records (analysis §8). **V1** = built in waves 2–4 of this spec; **later** = named, sourced, and ledger-tracked but not yet built.

| Surface | Primary source records | Wave |
| --- | --- | --- |
| Requests / Triage | `EndeavorRequest`s + `Recommendation`s | **V1** |
| My Work | the principal's allocations, commitments, Tasks, decision requests, deadlines | **V1** |
| Endeavors | `Endeavor` rows grouped by profile / phase / owner / collection | **V1** (list) |
| Plan | `CoordinationPlan` + steps + edges + allocations + milestones | **V1** (inside Endeavor detail) |
| Board | grouping projection over lifecycle state / owner / milestone | **V1** (simple lifecycle board) |
| List / Table | field-oriented projection over Endeavor rows | **V1** |
| Calendar | milestones, deadlines, availability, scheduled rules | later |
| Timeline / Gantt | PlanSteps, dependencies, dates, milestones, child Endeavors | later |
| Dependency graph | `PlanEdge`s + `EndeavorRelation`s | later |
| Conversations | fabric discussions filtered by endeavor contextRef | **V1** (detail tab) |
| Decisions | `DecisionRequest`s + `DecisionRecord`s | **V1** (cards + detail) |
| Agent Runs | Tasks, ServiceExecutions, checkpoints, artifacts, receipts | **V1** (per-endeavor) |
| Portfolio | `EndeavorCollection` roll-ups | later |
| Workload | capacity offers, availability, reservations, commitments | later |
| Risks / Health | `Risk`s, `Impediment`s, `HealthAssessment`s | later |
| Analytics | derived metrics over events, executions, outcomes, costs | later |
| Activity | unified coordination + fabric + execution + audit + provenance timeline | **V1** (from audit rows + `projectEndeavorProvenance`) |
| Agent Control | managed agents, playbooks, delegations, runs, costs | existing Home surfaces + `HomeAgentRunEntryV1` |

Each row exists in the coverage ledger with coverage form `projection`; a later-wave row stays `mapped`/`specified` until its projection ships with fixtures.

## 12. Privacy

- **Vault-resident under the managing principal.** All `coordination.*` docs live in the managing principal's vault, reached only over the interactions grant — same residency as `conversation.*` docs. Single-writer V1 (spec 332 §9.5).
- **Nothing coordination-derived enters the public discovery KB** (ADR-0040): no endeavor titles, goals, participants, allocations, or activity — not hashed, not temporarily.
- **Entitlement-filtered visibility per participant.** `endeavor.list`/`get` project only what the caller's relationship admits: participants see their endeavors fully; members see open endeavors; stewards see all; external requesters see only their own request's status. Executor context is always a `CoordinationContextSnapshot` (spec 332 §8), never the raw doc set.
- Private chain-of-thought is not stored (ADR-0054 §8).

## 13. Reference: smart-agent patterns to port

Beyond spec 332 §13 (which covers the semantic ports), this spec ports the *surface* patterns from `/home/barb/smart-agent` (branch `003-intent-marketplace-proposal`): the hub `tasks/` inbox becomes the My Work projection (§7); the marketplace's request→proposal→engagement screens inform the Requests/Triage → Endeavor detail flow (§6); the round/decision-window UI maps to the Decisions surface. Diverged: smart-agent renders from mutable work-item rows; we render from event-sourced projections so the activity trail and provenance graph are intrinsic, not reconstructed.

## 14. Waves + gates

| Wave | Contents | Gate |
| --- | --- | --- |
| W2 | serving plane: `endeavor.*` ops on `InteractionsDO` (gates, serialize, audit, event append, reducer wiring) | `pnpm --filter @ap-home/agent-runtime typecheck` + demo-a2a tests + manual op checks (request → adopt → plan → allocate → commit → decide; stale-hash commit rejected; non-approver decide rejected) |
| W3 | UX + Home projections: org Work section, person My Work cards, `packages/home` contracts (§8), endeavor contextRef chips | `pnpm check:demo-sso-next` + `pnpm check:home` |
| W4 | execution binding (PlanStep → `apexec:ExecutionIntent` → A2A Task via `A2aTaskDO`, commitment-bound) + entry-point adapters (doors 2–4) + the spec-329 consultation fan-out golden fixture asserting the full `projectEndeavorProvenance` P-Plan/PROV trace | fixture green in `pnpm check:coordination` + `pnpm check:provenance`; coverage ledger rows advance to `implemented` |
