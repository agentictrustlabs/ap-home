# Spec 375 — Trigger kinds and event-driven coordination: a run that nobody asked for still presents no mandate

**Status:** W1 ✅ shipped + live on faithnet 2026-09-08 (§5); W2 (message) and W3 (Home panel) open · **Kind:** Harness behaviour (playbook triggers), a serving-plane dispatch, one Home surface
**Grounds:** [370](370-harness-parity-ledger-and-program.md) P5 (the agent is the asker; no mandate; an act parks open to stewards — the user's decision) · [365](365-email-as-a-channel.md) (an inbound message never *performs* an act) · [354](354-archetype-driven-agent-behavior.md) (a playbook is behaviour, never authority) · [332](332-coordination-endeavor-core.md)–[334](334-coordination-work-surface.md) (the Endeavor log and its events) · [340](340-agentic-interaction.md) (an Exchange has a profile) · appendix N2 + M9 in [`harness-parity-gap-analysis.md`](../docs/architecture/product-comparison/harness-parity-gap-analysis.md)

## 0. The gap

P5 shipped one trigger kind: `schedule`. A playbook can say *every day, ask what we are working on*; it
cannot say *when someone commits to a step, prepare the allocation*, or *when this address is posted to,
read what arrived*, or *when a request lands in the inbox, draft the reply for the steward*. The field
has all four (Buzz's message · reaction · schedule · webhook; Dapr's pub/sub; CrewAI flows), and every one
of them there is an ACL and a script. Here every one of them is the same thing P5 already is: **a run the
agent starts as itself, holding nothing.**

## 1. The rule, restated for every kind

**A trigger fires a run; it never carries authority.** Whatever fired it — a clock, an Endeavor event, an
HTTP call, a message — the run is `runUnattendedAsk`: the agent is the asker, nothing is presented,
reads answer from what the agent's own records say to that asker, and an act suspends on the mandate it
would need and parks open to the agent's stewards (P5, 372 N1). The trigger's *ask* is behaviour from the
playbook (354 §1); the *event* that fired it is context the planner may read and no verifier ever does.

Spec 365's rule therefore holds for every kind, not only mail: **an inbound message never performs an
act.** It may start a run; the run may prepare an act; a steward performs it.

## 2. The kinds

`TriggerV1` on the compiled definition (`harness-contract.ts`) gains three kinds beside `schedule`. Each
names WHAT fires it in the vocabulary that already exists for that thing — never a string the playbook
author invents:

| Kind | `on` | Fired by | Context the run receives |
| --- | --- | --- | --- |
| `schedule` | `every` (ISO 8601 duration, ≥ 1 h) | the agent's own task object's single alarm (P5) | `{ trigger }` |
| **`event`** | `{ event: <CoordinationEventV1 type> }` — `EndeavorRequestSubmitted`, `PlanAdopted`, `ContributionCommitted`, `PlanStepSatisfied`, `EndeavorRequestDeclined`, `MilestoneAchieved`, … (the Endeavor log's own type names, `packages/coordination/src/core`) | the interactions object, after it COMMITS an Endeavor command whose appended events include that type | `{ trigger, event: { type, endeavorId, at, actor?, … the event's public fields } }` |
| **`webhook`** | — | `POST /harness/hooks/<triggerId>` at the agent's own host, `Authorization: Bearer <token>`; the token is minted per row when the playbook syncs and shown to stewards where the triggers are listed | `{ trigger, payload }` (the JSON body, bounded; named, never trusted) |
| **`message`** (W2) | `{ profile: 'dm' \| 'topic-mention' \| 'application' \| … }` — the Exchange profile kind the agent's inbox admits | the messaging skill, after it ADMITS an inbound exchange of that profile into the agent's inbox | `{ trigger, message: { id, from, profile, text? } }` |

`event` triggers fire at **participants**: the principal whose log the event was appended to (the
organization, team, workspace) and, when the event names an agent (`participant`, `requester`, the
actor), that agent — each under ITS OWN playbook, each only if that playbook declares a trigger for the
type. A person's agent that declares `on: ContributionCommitted` hears about commitments it is party to,
nothing else; an organization's coordinator hears about every commitment on its own log.

## 3. What is stored, where

Trigger rows stay where P5 put them: on the agent's task object (`harness:trigger:<id>`), synced from
the playbook on every ask, rebuildable from the definition digest — serving-plane state (ADR-0055). A row
now carries its `kind` and its `on`; a `webhook` row carries its token. The schedule alarm keeps firing
only `schedule` rows; the other kinds are fired by their sources through one function,
`fireTriggers(agent, { kind, … })`, which lists the agent's rows, matches, and starts one unattended run
per match with `runRef = trigger-<id>-<time>` and the source as context.

Nothing is delivered TO the fired run's asker except through the same doors as any run: the trigger row
keeps `lastRunRef / lastOutcome / lastSaid`, a parked act appears in the stewards' unfinished runs with
`trigger` on its checkpoint, and a completed run's record is on the agent's object.

## 4. Boundaries (the drift to refuse)

- **A webhook token is admission, not authority.** It says *this call may start this trigger's run*; it
  is never presented, never a mandate, never a session. Rotating the playbook rotates the token.
- **No trigger names a mandate.** A playbook that could say "and present this grant" would be a script
  with a key; the contract validator refuses any field that looks like one.
- **No fan-out by trigger.** A fired run is one run at one agent. An event that should reach many
  participants fires at each participant's own agent under its own playbook — never one run acting for
  all of them.
- **The event is context, not an argument the planner may forge.** The run's intent context carries the
  event's public fields for the planner's benefit; a step's arguments are still resolved in the agent's
  own tier, and a party the event names is resolved like any other party.
- **A message trigger never replies on its own.** Its run may draft a reply; sending it is an act that
  parks for a steward (365 §1). The org-assistant turn (spec 327) is not a message trigger — it is the
  organization answering a mention in its own topic under its own steward playbook, and it stays as it is.

## 5. Waves + gates

| Wave | Delivers | Gate |
| --- | --- | --- |
| **W1** ✅ 2026-09-08 | `event` + `webhook` (+ `message` declared) in `TriggerV1` and its validator (sources named in the vocabulary that exists; any authority-looking field refused); rows carry kind/on/token; `fireTriggers` + DO op `trigger-advance`; `onCommitted` on the Endeavor deps at every commit site — the pending request row too, since adoption seeds the log with that event — scheduled off the mutex; `fireEndeavorEventTriggers` at the principal and the agent the event names; `POST /harness/hooks/<agent>/<triggerId>` outside CSRF (its admission is the token); the Coordinator archetype declares `on-request`, `on-commitment`, `status-hook` (digest `0x094dc50e…`, on `playwright-demo-team`). Found on the way: the self-only read rule (366 R3) asked "which organization?" of an organization asking ITSELF — it now holds only when the addressee is a person (`addresseeKind`, read on chain once per ask) | unit `trigger-kinds.test.ts` (matching; a webhook matches its own row with its own token and nothing else; a failed firing is recorded). **Live** `scripts/verify-trigger-kinds.mts`: wrong token → 401, right token → `answered`; alice's request to the team → `EndeavorRequestSubmitted` fired `on-request` at the team → `answered`. `on-commitment` (an act that parks) is declared and unit-covered; its live firing waits on a commitment in the estate |
| **W2** | `message` kind: the messaging skill fires after admitting an inbound exchange of the named profile; the fired run's reply, if any, parks as a draft act | live: a DM to an agent whose playbook declares `on: dm` starts a run; the reply parks for the steward |
| **W3** | Home: the triggers panel shows each trigger's kind, source, last run and — for webhooks — the token, with rotate | screen parity |

## Reference: patterns to port

- smart-agent's intent marketplace fires nothing on its own; matching is pull. Buzz.xyz's YAML triggers
  (message/reaction/schedule/webhook, "pause for approval") are the closest field analogue and the one
  this spec deliberately mirrors in SHAPE — and diverges from in AUTHORITY: Buzz's pause is a click by
  whoever holds the workspace; ours is a mandate signed by a steward against the agent's own custody.
