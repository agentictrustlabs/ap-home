# Spec 382 — The committed step runs at the participant: a promise is not authority, and the organization does not keep it for you

**Status:** W1 ✅ shipped + live on faithnet 2026-09-08 (§4); W2 (Home surface, withdraw/reallocate) and W3 (the remaining M6 rows) open · **Kind:** Endeavor conformance (appendix M6, first wave) — one reducer rule, one door widened, one parked-run shape, one guard on the work turn
**Grounds:** [332](332-coordination-endeavor-core.md) §9 rule 1 (allocation and commitment grant nothing; authority remains delegation ∩ entitlement ∩ policy) · [334](334-coordination-work-surface.md) §4 door 4 (plan steps compile to `apexec:ExecutionIntent`s and execute as A2A tasks bound to the commitment) · [350](350-authority-aware-agent-harness.md) W3 (the durable run a steward finishes by granting the mandate) · [370](370-harness-parity-ledger-and-program.md) P4 (an authority-bearing step is work waiting on a person, never a paragraph) · [375](375-trigger-kinds-and-event-driven-coordination.md) (a `ContributionCommitted` event fires the participant's own triggers) · ADR-0054 (coordination between agents is never orchestration within one) · appendix M6 in [`harness-parity-gap-analysis.md`](../docs/architecture/product-comparison/harness-parity-gap-analysis.md)

## 0. The gap

The Endeavor substrate already knew how to record a promise: a participant signs a `ContributionCommitment`
over the exact adopted plan hash, the reducer refuses a stale one, and `compilePlanToExecutionIntents`
turns the committed steps into execution intents, one per participant. Nothing then RAN them as the
participant. The organization's work turn walked every open step of the plan and did the work itself —
which, for a step somebody else had signed for, was the organization keeping another agent's promise with
its own hands, and for a step needing authority, parking a run open to the organization's stewards rather
than to the person who promised it. And a member who offered a contribution was refused by the reducer for
want of a participation nobody could give them: no invite door existed, and adoption asserted only the
coordinator. So the golden path — two participants, one plan hash, two commitments, two runs, one
satisfied outcome — had never been walked end to end.

## 1. The rule, stated once

**A committed step is the participant's run.** When a participant's signed commitment lands, the step it
names is compiled (against the adopted revision hash, fail-closed) and handed to THAT participant as a run
parked on their own agent — addressed to them, asked by them, claimable by nobody else. They finish it by
presenting their own mandate, and the step is recorded satisfied on the organization's log BY THEM, with
their receipt as evidence (the run, the mandate, the transaction, the commitment). The organization's work
turn never runs a step somebody else promised. A participant who holds no mandate for their step is asked
for one and denied it, exactly as anyone else would be — the commitment changed who the step is waiting on,
and nothing about what it may do.

## 2. The shape

| Piece | What | Where |
| --- | --- | --- |
| **the reducer rule** | the managing principal is a steward of its own endeavor (`isSteward`): the organization acting through its own agent may invite and allocate on the endeavor it manages, as its coordinator may. Adoption asserted the coordinator, never the organization | `coordination/core/reducer.ts` |
| **the door widened** | `endeavor.propose` from a MEMBER who is not yet a participant appends `InviteParticipant` (by the organization, role `contributor`) + `AcceptParticipation` (by the member) before the proposal — three commands, one append, each re-validated. Membership is the standing that let them in; the offer is the acceptance | `demo-a2a/src/endeavors.ts` |
| **the hand-off** | `afterEndeavorCommit` (every commit site): triggers fire (375) and, on `ContributionCommitted`, `parkableCommittedSteps(state, events, principal)` compiles the intents and picks the new commitments' steps for actors other than the organization; each becomes `checkpointForCommittedStep` — `addressee = asker = participant`, `openToStewards: false`, `origin { endeavorId, stepId, principal, commitmentRef, planHash }`, the ask "…exercising `<capability>` as `<participant>`" — saved on the participant's task object; the endeavor is told whose promise it is and that the organization will not run it | `demo-a2a/src/endeavor-committed-steps.ts`, `endeavor-authority-steps.ts`, `index.ts` |
| **the guard** | the organization's work turn skips a step an active commitment names for another actor (`internal.endeavor.state` now carries the active commitments) | `a2a-task-do.ts` `runEndeavorWork` |
| **the record** | the participant's finished run satisfies the step through `internal.endeavor.satisfyStep` with `actor = participant` (in-Worker; the reducer re-gates: managing principal or an ACTIVE participant), evidence `urn:ap:receipt:run:… mandate:… tx:… commitment:…` | `index.ts` (the ask route's origin delivery), `interactions-do.ts` (`endeavorSelfDeps.actor`) |
| **the golden fixture** | `committed-steps-run-at-participants.json`: two participants, one hash, a stale commit rejected, a stranger's satisfy rejected, two executions recorded by the participants, one satisfied outcome; `committed-execution.test.ts` compiles it to two intents and reads two step-executions from the PROV projection | `packages/coordination/test` |

## 3. Boundaries (the drift to refuse)

- **A commitment is not a mandate.** The parked run presents nothing; the participant's harness asks for
  the mandate its step needs and verifies it like any other. "They committed, so let it through" has no
  path: nothing reads a commitment at a gate (332 §9 rule 1).
- **The organization does not keep your promise.** Its work turn skips what others signed for. A steward
  who wants the step done otherwise withdraws the commitment and reallocates — through the reducer.
- **Recorded by the one who did it.** The satisfying command's actor is the participant; the organization's
  door does not launder it into the organization's own act. The reducer admits it because they are active.
- **One executor per step.** The step is parked once, at commit; the trigger that also fires at the
  participant (375 `on-commitment`) is theirs to declare and adds a clock, never a second run of the work.
- **The invite is the organization's, not the steward's session.** A member's offer is admitted at the
  organization's own door because membership is standing there; a stranger's offer still fails the member
  gate first and the reducer second.

## 4. Waves + gates

| Wave | Delivers | Gate |
| --- | --- | --- |
| **W1** ✅ 2026-09-08 | the rule, the door, the hand-off, the guard, the record, the fixture | unit: fixture replays (stale hash rejected; stranger's satisfy rejected; satisfied with two commitments), `compilePlanToExecutionIntents` → two intents with the participants as actors, PROV shows two step-executions; `checkpointForCommittedStep` is the participant's alone; `parkableCommittedSteps` hands bob his step and the organization nothing of its own. **Live** `scripts/verify-committed-step.mts` on Missio Nexus: alice requests, adopts and proposes a two-step plan (each step a payment); bob and carol offer, alice allocates, both commit (bob's stale-hash commit first → 409); each commit parks a run at its participant; bob claims his in his Ask, is asked for HIS mandate, grants it and approves → done → the step is satisfied on the endeavor with his run, mandate, tx and commitment as evidence; **carol claims hers and presents nothing → `authority_required`, her step stays open**. **Found on the way (all fixed):** `endeavor.commit` was the one op that never called `onCommitted` — no `on-commitment` trigger had ever fired and nothing could have parked; a member's offer was refused for want of a participation nobody could give (adoption asserts only the coordinator, no invite door) — the organization now invites at its own door and the reducer lets the managing principal steward its own endeavor; a member the ROSTER named was refused at the endeavor door because it read only directory listings — the organization's own membership record (`org.membership:member:<sa>`, its grant re-checked on chain) is now the fourth presence proof beside listing, member-access grant and stewardship; steward-gated ops (`proposePlan`/`adoptPlan`/`allocate`/`satisfy*`) acted as the steward's person and were refused by the reducer once the organization had auto-adopted — a steward now acts AS the organization, as adoption already did; demo-mcp's stage-2 throttle (120 verified calls / 60 s per principal) surfaced as "auth failed" from the getMany call sites — the retry now lives under every vault tool in `mcpVaultTool`, honouring `retryAfterMs`, and a persisting throttle is said to be one; `paymentAskOf` read the payee off the whole ask and swallowed the appended "Do this by exercising …" sentence — the payee is on the payment's own line. The demo persons' unnamed treasuries carry no on-chain agent type, so the value rail rightly refused them (spec 373) — alice, a participant as coordinator, pays from her typed treasury; the gate pauses auto-work for its run (its turns spend the same vault budget) and restores it. Live: tx `0x9d51f2f4…` under mandate `0x05d9d138…`, evidence cites run + mandate + tx + commitment, `PlanStepSatisfied.actor` = alice; carol's step open. |
| **W2** | the participant's Home shows "you committed to …" with the parked run beside it; withdraw/reallocate through the same door; `PlanStepSatisfied` carries the receipt refs typed (not a note) | screen parity |
| **W3** | the remaining M6 rows (decisions by declared approvers, milestones, the Coordinator playbook driving offers and allocations through the Ask) | rolling |

## Reference: patterns to port

- MAF's Magentic ledger and CrewAI flows hand a step to a worker agent and let it run on the orchestrator's
  credentials; Linear and Asana record an assignee and trust the assignee's session. We take the assignment
  shape and diverge on the one thing that matters: the assignee runs it on THEIR authority, presented at
  THEIR gate, and the record says so.
