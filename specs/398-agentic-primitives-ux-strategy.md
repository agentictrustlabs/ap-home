# Spec 398 — The Agentic Primitives UX strategy: Home Work, Home Build, and the Developer Kit

**Status:** Draft 1 — product brief + spec, 2026-09-10 · **G0 census LANDED 2026-09-11** (`pnpm check:home-census`, ledger `docs/architecture/home-census.json`, projection `home-census.md`; a CI step) · **Kind:** program spec (UX + developer tools) · **Companion
brief:** `[docs/architecture/ux-strategy-product-brief.md](../docs/architecture/ux-strategy-product-brief.md)`
**Grounds:** [350](350-authority-aware-agent-harness.md) (the harness) · [351 §9](351-agentic-primitives-substrate-program.md)
(no run UI in Ring 0) · [352](352-ask-capability-program.md)/[353](353-app-scoped-ask.md) (Ask, `AskScopeV1`) ·
[354](354-archetype-driven-agent-behavior.md) (compiled harness definitions) · [361](361-interaction-contract-one-capability-every-surface.md)
(the Interaction Contract, five parities) · [334](334-coordination-work-surface.md)/[382](382-committed-steps-run-at-the-participant.md)/[393](393-decisions-by-declared-approvers.md)
(Work) · [344](344-team-and-workspace-ontology.md) (workspace) · [310](310-agentic-trust-home-control-plane-and-inbox.md)/[313](313-interactions-ia-chats-channels-find-networks.md)
(Home control plane, inbox IA) · [348](348-unified-agent-workspace-navigation.md) (one nav shape) · [381](381-run-export-spans-retention-provenance.md) (run timeline) ·
[391](391-context-management-for-long-runs.md) (`run.artifact`) · [395](395-public-provenance-projection.md) · [396](396-do-economics-measured.md) ·
[397](397-home-mcp-claude-entrance-to-the-person-agent.md) (Home MCP) · ADR-0021 (generic packages, white-label apps) ·
ADR-0044 (first-party web → A2A) · ADR-0055 (the vault is the record) ·
[harness-feature-priorities §3.4](../docs/architecture/harness-feature-priorities.md) (what the UX phase inherits).
**Inputs reconciled:** the external research package of 2026-09-10 (*Agentic Primitives Home — Competitive Analysis*

- *Inventory and Roadmap* workbook: 52 inventory rows H01–H52, 48 environments C01–C48, 26 capability comparisons
M01–M26, 75 backlog items APUX-001…075, 25 tooling decisions D01–D25, 36 acceptance scenarios T01–T36). Its author
could not see this repository; §1 is the census it asked for.

---

## 0. Why this spec exists, in one paragraph

The harness program is closing (harness-feature-priorities §3: seven gaps G1–G7, three transitions T1–T3, then
"the transition IS the UX and developer-tools phase"). What we have is an authority plane that held in every incident
and a knowledge plane that is now bounded by its evidence — and a Home that exposes both through ~111 routes, an Ask
flyout, a Work surface, an Agent Card Studio, a Playbook page and a run timeline, none of which a newcomer can find
their way through in the order the work happens. The external review names the target correctly: **make the work
visible, governable, and easy to extend.** This spec turns that into three products with one spine — **Home Work**
(a person and their team direct agents on accountable work), **Home Build** (build the application the work needs,
inside the same authority), and the **Developer Kit** (build WITH the primitives, from a clean machine, with a
coding agent) — all projections of the one capability model this repo already compiles (SKILL.md contract →
`AgentHarnessDefinitionV1` → `InteractionBindingV1`). The strategy's one rule is inherited unchanged: **being a
participant does not authorize an action; the requested effect must be within the acting principal's current,
scoped delegation** — and every screen must make that sentence legible to a non-developer.

### 0.1 Where this spec lives after the repository split (ADR-0063 · spec 399)

This is a **cross-repo program**. Ring 0 keeps packages, contracts and the Developer Kit; the products move to their
own repositories ([spec 399](399-repository-split-program.md)). Each section below has an owner repository; the
spec itself moves to `ap-home` at 399 W2 and Ring 0 keeps a pointer in `specs/INDEX.md`.

| Section | Owner after the split | Why |
| --- | --- | --- |
| §1 census, §4–§6 Home Work, §8 `~/skills` fold-in (Home half), §12 gates (Home rows), §13 demonstration | **`ap-home`** (cut from Ring 0 by `scripts/split/extract-ap-home.sh` once the Ring-0 half lands — handoff §7) | surfaces, states, ceremonies — product |
| §9 Home Build (services + the Build route group), §12 G4 | **`ap-build`** ([created 2026-09-11](https://github.com/agentictrustlabs/ap-build)) | §9.1 stands — Build is a workspace mode, not a second identity system; the separate repository decides CODE ownership only: identity, session, nav and every authority ceremony remain Home's, and `ap-home` mounts the route group |
| §7.2 contract additions (`idempotency`, `result.kind`, client/CLI projection, parity generation) | **Ring 0** (`capability-claims/harness-contract`, `harness`) | schema + pure projections |
| §7 crosswalk, §3 invariants | Ring 0 (doctrine) — projected into every product repo by `ap doctor --rules` | one source |
| §8.1/§8.4 corpus contracts, domain packs | `~/skills` (authoring) + Ring 0 Developer Kit (consumption) | 354 §7 |
| §10 Developer Kit, §11 build/buy decisions that are kit-level (AG-UI adapter, ACP adapter as Ring-1) | **Ring 0** | the packages' front door |
| §11 Home stack choice (CopilotKit / assistant-ui / own), Sandbox bake-off | `ap-home` | product dependency choices |
| §12 G0 census script (`check:home-census`), `check:golden-journey` | `ap-home` CI, built on `packages/evaluation` runner | 399 §2.3 |

Until 399 W2 cuts, work on §4–§9 continues in `apps/demo-sso-next` / `apps/demo-a2a` here, importing promoted
symbols from published packages as 399 §4 lands them — never adding new app-resident primitives.

---

## 1. Census: what the review could not see (its G0, done here)

The review marked 25 of 52 Home rows *Unverified* or *Design*. Against the tree (`apps/demo-sso-next/app/(portal)/*`*,
`src/components/portal/nav.ts`, `src/home/*`, harness endpoints called from Home) the honest picture is:

### 1.1 Shipped, and the review under-counted it


| Review row                                           | Reality             | Where                                                                                                                                               |
| ---------------------------------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| H08–H11 Workspaces, membership, roster (Design)      | shipped             | `/workspaces`, `/org/[org]/membership`, `/members`, `/agents`; charter team `organization.team.create` (344/346/318)                                |
| H12 Shared task board (Unverified)                   | shipped             | `/work`, `/org/[org]/work/*` — endeavors, allocations, commitments, decisions (334/382/393)                                                         |
| H13 Channels / artifact-linked discussion (Design)   | shipped             | `/org/[org]/discussions`, `/channels`, unified `/messages` (312/313)                                                                                |
| H14 Huddles (Unverified)                             | shipped             | `HuddleProvider`/`HuddleDock` on topics (378)                                                                                                       |
| H15 External agent invitation (Design)               | shipped             | `/connect/org-invite/agent`, `/external-agent`                                                                                                      |
| H17 UI and Ask share a contract (Design)             | partial → §7        | `InteractionBindingV1` (361 I1), `check:interaction-coverage` (I3), Edit-in-form (I5), selection (I6); execution parity per family (I4) in progress |
| H18 Deterministic UI without model planning (Design) | partial             | invite/fund/profile/household/payee screens post structured intents to `/harness/ask`; deploy/custody still legacy `/session/*`, `/account/*`       |
| H20 Capability discoverability (Partial)             | shipped             | `/harness/vocabulary` → command picker; playbook examples (354 K5)                                                                                  |
| H23 Run checkpoints / resume (Partial)               | shipped             | 350 W3 durable runs; `GET /harness/run` + resume with edited plan                                                                                   |
| H25 Durable approval waits (Partial)                 | shipped             | parked runs (382), decisions by declared approvers (393), remembered choices (385 W2)                                                               |
| H26 Run inspector / task stream (Design)             | shipped             | `/activities` → `ActivityTimeline` + `RunHistory`/`RunTimeline` (310 W4, 381 W3); progress long-poll (370 P2); "How" pane with `AskEvidence`        |
| H27 Routines / scheduled work (Unverified)           | partial             | `TriggersPanel` on Playbook (375 W3); no routine-as-product page                                                                                    |
| H28 Attention inbox (Partial)                        | shipped, merged     | `/messages` (inbox redirects); approve ceremonies `/approve-*`                                                                                      |
| H31 User-editable memory (Unverified)                | partial             | remembered choices + clear, standing instructions + clear (385/394) in the flyout; no personal-memory page                                          |
| H33 Artifact library, versions (Design)              | shipped             | `/library` with versions tab                                                                                                                        |
| H38 Portable signed receipts (Partial)               | shipped             | receipts on run rows; `POST /harness/provenance` JSON-LD/PROV-N (389); public projection (395 W1)                                                   |
| H39 Plain-language authority (Design)                | shipped             | `describeRequirement`, authority cards, error phrasing (350, 310 W5)                                                                                |
| H40 Tracing / evaluation UI (Partial)                | shipped substrate   | OTel semconv spans (390), `check:ask-truth`, run timeline; no replay UI                                                                             |
| H46 Local capability inspector (Unverified)          | partial             | Card Studio `Inspector.tsx` (347) inspects cards, not runs                                                                                          |
| H47 Component registry (Unverified)                  | absent as a product | components exist locally; no registry                                                                                                               |
| — `packages/home` "planned"                          | exists              | portable control-plane contracts (310)                                                                                                              |


### 1.2 Truly absent (the review was right)


| Review row                                                                                      | Absence                                                                    | This spec             |
| ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | --------------------- |
| H41–H45 `create-app`, `agentic.lock.json`, coding-agent rules projection, Developer MCP, doctor | nothing published, nothing generated                                       | §10                   |
| H48–H52 Home Build (repo workspace, sandbox, preview, review, promotion, rollback)              | nothing                                                                    | §9                    |
| APUX-026 steer / pause / cancel / revoke as one control set                                     | no cancel/steer client surface; revoke exists on delegations, not on a run | §5.3                  |
| APUX-033 run cost visibility                                                                    | headers exist (396: `x-ap-vault-calls`, `x-ap-ms`); no UI                  | §5.4 (and harness G3) |
| APUX-009 outcome-led Today                                                                      | Overview is a status page, not a decisions-first page                      | §4.2                  |
| APUX-012 attention inbox distinct from unread                                                   | decisions live in Messages with approve ceremonies; no filter model        | §5.5                  |
| APUX-035 personal vs shared memory views                                                        | no view separates personal facts, workspace context, projections           | §6                    |
| M06 fleet isolation shown (compute + credential boundary)                                       | agent avatar only                                                          | §4.4                  |
| presence                                                                                        | none (and not wanted before the roster is right)                           | §4.5                  |


**Consequence for the gates (§12):** G0 is this section, kept current by `check:home-census` (§12.1) — landed 2026-09-11 as data (`docs/architecture/home-census.json`: 27 rows, every one of the Home's 117 page routes and 21 harness endpoints claimed by a row whose status is earned by bindings in the tree; the projection `docs/architecture/home-census.md` is generated, never edited). The tables above are the census as it stood on 2026-09-10; the ledger is the census as it stands. G1's journey
does not start from zero; most of its screens exist and the work is *ordering, states and parity*, not construction.

---

## 2. Position and promise

### 2.1 Three competitive spaces, one substrate

The review's taxonomy avoids false parity and we adopt it:


| Space                    | Peers                                                                                                       | What they establish                                               | What we must show, in the UI                                                                     |
| ------------------------ | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Human + agent workspaces | Buzz, Grok Bot, Genspark GenTeam, Dust Pods, Taskade, LangSmith Fleet, Perplexity Computer, Hermes, LobeHub | rooms, rosters, shared work objects, persistent agents, attention | the same objects — plus **who may do what, shown at the act**, not at the door                   |
| Coding command centers   | Codex, Claude Code, Cursor, Antigravity, Copilot app, OpenHands Canvas                                      | worktrees, sessions, review queues, browser evidence              | attach them through a thin adapter; **AP effects enforced independently of harness permissions** |
| Prompt-to-app builders   | Replit, Lovable, Bolt, v0 (Flowise EOL 2026-08-31)                                                          | preview → review → publish loops                                  | the loop, with **promotion bound to commit+config+env** and recovery scopes named                |


Enterprise work systems (Notion custom agents, Slack, M365 Copilot Cowork, Workspace Studio, ClickUp, Asana, Rovo)
have real scoped identity and agent permissions (M25). **We do not claim competitors have "only prompts or OAuth".**
The difference is narrower and provable: their approval is a click recorded in their store; ours is a signature over
an intent digest, verified per step against a revocable on-chain grant, leaving a receipt a third party can verify
without trusting us (harness-feature-priorities §1.1 C1–C5, each with a falsifier).

### 2.2 The promise (the sentence a screen has to earn)

> Describe an outcome. Your agents and your team do the work. You can see it, steer it and approve it. The result
> stays yours to inspect, extend and move.

Every surface in §4–§10 is judged by which clause of that sentence it earns, and the acceptance set (§13) has a
negative twin for each clause.

### 2.3 The differentiator, stated as the review states it

*Being a participant does not authorize every action. The requested effect must be within the acting principal's
current, scoped delegation.* Buzz gates on membership; Notion's agent may read what the triggering user may not;
Grok's bots under one user share a computer. Our UI must therefore show, at every act: **who is acting** (principal),
**where they stand** (workspace context — a projection, never a token), **what this act needs** (the mandate
requirement in plain words), and **what it left** (receipt). A room, a role name, a prompt or an installed component
grants nothing (spec 353 §4, 354 §1, 361 §1).

### 2.4 What the authority model cannot establish (said on the screen, too)

From the review §14, adopted as UI doctrine: a signature proves an attributable assertion, not that an answer is true
or a browser action succeeded; intent binding prevents substitution, not misunderstanding; on-chain enforcement covers
only effects routed through it — a raw SaaS token is another route. So: no unqualified green badge. "Verified"
labels name *what* was verified (signer, digest, scope, chain state at step time) and link to the evidence
(`/harness/provenance`, 395's public projection).

---

## 3. Invariants (inherited; none new)

1. **First-party web expresses intents to an A2A agent; it never drives MCP** (ADR-0044). Every button in §4–§9 posts
  a structured intent to `/harness/ask` or `/harness/run`; the legacy relayer verbs (`/session/*`, `/account/*`)
   are retired per feature family under 361 I4/I7, never extended.
2. **Scope is honesty; the mandate is authority** (353 §4). `AskScopeV1` and `InteractionBindingV1` narrow what is
  offered and how it renders; no verifier reads either.
3. **Behaviour is generated; authority never is** (354 §1, one-capability-model rule). The UI action, the Ask tool,
  the review card, the CLI arguments and the parity tests are projections of one contract (§7). Hand-wiring a screen
   to a verb is the anti-pattern the coverage gate exists to catch.
4. **The vault is the record; DO storage is the serving plane** (ADR-0055). Nothing in this spec adds a Home-local
  store of work, memory, artifacts or decisions. A Home export (§6.4) is a vault export.
5. **Ring 0 ships data and events; the UX consumer renders them** (351 §9). Run inspector, review cards, roster and
  registry components live in `apps/demo-sso-next` (and the Developer Kit's templates), never in `packages/*`.
   `packages/home` carries portable *contracts* (310), not React.
6. **Packages are generic; white-label lives in apps** (ADR-0021). The Developer Kit's starter is vertical-free; the
  Home component registry is an app-level artifact.
7. **Approval binds to the resolved, typed action** — the intent digest over the plan step and its resolved parties
  and resource versions (350 §3.6, 336 §8.3) — never to the sentence. A changed recipient, amount, commit or record
   version is a new digest and the old approval is void (T06, T29).
8. **Resolution is not authority; disclosure is a policy** (ADR-0056; M14). Reaching an agent, seeing a preview link,
  or being in a workspace discloses nothing by itself; a recipient/purpose policy governs what an agent that can
   read more than the asker may say (T15).

---

## 4. Home Work — information architecture

### 4.1 The nav stays one shape (348); the labels earn the promise

The review proposes *Today · Workspaces · Inbox · Library · Build* and says exact labels are a hypothesis. Spec 348
already fixes the grammar (top band of four "watch or take part" places · Work · Stewardship → · Records ·
Attestations · Settings →) and forbids per-class rearrangement. We keep the grammar and change what the places
answer:


| 348 slot today               | Becomes                                                                             | Answers                                                             |
| ---------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Overview (status)            | **Today** (outcome-led, §4.2)                                                       | what needs my decision · what is active · what finished · what next |
| Messages                     | **Messages** + the **Attention** filter model (§5.5)                                | unread ≠ decision ≠ exception ≠ finished artifact                   |
| Activities                   | **Activities** — run timeline first, control-plane events under it (381 W3 already) | what ran, what it left                                              |
| Library                      | **Library** — source · owner · version · access method (§6)                         | what we hold and how we hold it                                     |
| Work                         | **Work** — the accountable work item is the unit (§4.3)                             | who is doing what, what is blocked                                  |
| (new, conditional)           | **Build** — shown only when a repository project exists in this workspace (§9)      | the application this work needs                                     |
| Stewardship / Settings panes | unchanged                                                                           | how the agent behaves and who may change it                         |


`Workspaces` is not a nav slot: the topbar switcher (315) is the workspace list, and the review's rule that
*changing workspace never silently changes the acting principal or widens access* is already how the switcher
works (URL scope changes the Ask **addressee**; login identity stays the person; caption "acting as you / as
custodian / member · no custody"). §4.4 makes that caption load-bearing.

### 4.2 Today

Order, fixed: **decisions awaiting me** (393 decision requests, parked runs 382, approve ceremonies) → **active
goals** (runs with `waiting`/`running`, endeavors I am allocated to) → **recent artifacts** (`run.artifact`, Library
releases in the last N days) → **routine exceptions** (375 triggers that failed or paused) → **one suggested next
act** drawn from the vocabulary the playbook offers this realm (K5-narrowed; never from a hand list). Message
counts and infrastructure statistics are not on Today. Onboarding (299) reaches a harmless concrete result on
synthetic data before any identity concept is explained; chain, registry and archetype choices are deferred to the
first act that needs them.

### 4.3 The accountable work item

The Endeavor / work item (334 §2, 393) already carries goal, allocation, commitment, decision and parked run. The
UI contract for one item, on every surface that shows it (board row, detail, inbox card, Ask "done" reply):

`goal · accountable owner (a person or org SA) · executor (person or agent SA) · status (§5.1) · linked conversation (312 context-linked topic) · output artifacts (391` run.artifact `refs, Library versions) · acceptance condition and who accepts (393 approver) · what it cost (396 headers, §5.4)`.

A **hand-off** names the successor participant and the transferred context (a `ContextSnapshot` digest, 340) and is
a coordination act (ADR-0054) — Home represents it; it never schedules it (H24). An exclusive claim is accepted once
(T19); the reducer, not the UI, rejects the duplicate.

### 4.4 Principal ≠ workspace context, made visible

Every mutation screen and every review card shows two facts side by side: **acting as** (the principal SA, with its
class icon — person/org/service, ADR-0046) and **in** (the workspace context). When the two differ ("you, in Missio
Nexus"), the card says on what basis the act may proceed (custody · membership grant · delegation in hand) using
`describeRequirement` — words already in Home. A role name ("researcher") is a responsibility (344
`ResponsibilityAssignment`) and is rendered as such: it never appears in the *basis* line. M06's fleet boundary is
shown on the agent roster: for each managed agent, **where it runs** (deployment / DO), **what it may spend** (its
wires, 329) and **what it holds** (its vault) — three lines, not an avatar.

### 4.5 Roster, invitations, presence

The roster (`/members`, `/agents`) gains, per participant: type · sponsor (who admitted them and under what
situation, 324) · responsibility · permissions summary (its grants, plain words) · active work (items where it is
executor). Invitations remain recipient-bound with expiry and a POST-only redemption (T18: a scanner's GET never
mutates — audit `/connect/*-invite` routes under G2). **Presence is deliberately not built** before G3: a green dot
is not task state (APUX-021) and today it would be the only live signal on a page that should be showing work.

---

## 5. Execution supervision — states, controls, inspector, attention

### 5.1 One state vocabulary, everywhere

Runs (350 `RunRecordV1`), tasks (A2A Task in `A2aTaskDO`), endeavors (334) and triggers (375) are shown through one
projected state set: `drafted · queued · running · awaiting-input · awaiting-approval · blocked · recovering · completed · failed · canceled · expired` **plus an orthogonal flag `effect-uncertain`** (a step whose external call
timed out after it may have succeeded). The mapping from each record's native state is a pure function in Home
(`src/home/run-state.ts`, new) with a table test; the review's APUX-024 is met when every surface renders from it.
`effect-uncertain` is never collapsed into `failed` (T10, APUX-031): the UI says *unknown — reconciling*, and the
retry is gated on reconciliation of the provider's evidence, not on a click.

### 5.2 The run inspector is artifact-first

Order on `/activities/<run>` and in the Ask "How" pane: **outcome** (the `done` reply and its bound result component,
361 `interaction.result`) → **artifacts** (391) → **decisions taken and pending** (393, approvals with their digests)
→ **plan and per-step authority** (the plan as admitted, each step's `verifyMandateForStep` verdict with the chain
state it read) → **execution detail** (spans 390, tool calls, timings, cost) → **provenance** (link to
`/harness/provenance` JSON-LD/PROV-N; 395 public projection if published). Model reasoning is not shown and is not
evidence. This is a re-ordering of `RunTimeline` (381), not a new component.

### 5.3 Pause · cancel · revoke · undo are four things


| Control    | Semantics                                             | Mechanism                                                                                                           | Shown as                                                        |
| ---------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| **Pause**  | scheduling: no new step starts; state kept            | trigger pause (375); run park (382)                                                                                 | "paused — resumes on …"                                         |
| **Cancel** | ask the run to stop; completed effects stand          | A2A `tasks/cancel` on `A2aTaskDO` → run `canceled`; in-flight step finishes or is marked `effect-uncertain`         | "stopped after step N; steps 1–N happened"                      |
| **Revoke** | remove FUTURE authority; the run may still be running | delegation revocation on chain (existing `/security` DelegationsList); the next `verifyMandateForStep` denies (T07) | "authority withdrawn — next step will be refused"               |
| **Undo**   | a domain-specific compensating act, if one exists     | a NEW intent (e.g. `payment.refund`), with its own mandate                                                          | never offered where no compensation exists; the receipt says so |


Cancel is the one control absent today (§1.2); it is a G1 item. The review's harder point stands: **a source rewind
in Build is not an undo of a deployed effect** (T11, T30) and the UI never labels it one.

### 5.4 Cost

396 already stamps `x-ap-vault-calls`, `x-ap-vault-throttled`, `x-ap-ms`, `x-ap-vault-tools` on every op. Home shows a
run's bill on the inspector (§5.2) and a routine's budget on its trigger (375): budget exhaustion **pauses** (T31),
never widens a mandate or tops up silently. Harness G3 (the run's bill on `RunRecordV1`) is the prerequisite for
showing it on Today.

### 5.5 Attention, not notifications

Messages keeps one durable decision record per decision (393) however it is delivered (Home, email via `hear`,
mobile). The filter model on `/messages`: **needs my decision · needs my input · blocked · failed routine ·
finished artifact · unread**. A card is one object with one action set; approving from email and from Home resolve
the same record (T16: no duplicate or stale cards). Presence, mentions and subscriptions are G2+ (APUX-021).

---

## 6. Memory, artifacts and the Library

### 6.1 Three stores, never one label

The review's warning (I07): do not hide personal facts, shared knowledge and run context under "workspace memory".
Home renders three views, each bound to its vault record kind (`packages/ontology/src/vault-records.ts`):


| View          | Record                                                                              | Owner                    | Actions                                                                                                   |
| ------------- | ----------------------------------------------------------------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------- |
| **Personal**  | remembered choices (385), standing instructions (394), learned preferences (358 W5) | the person's vault       | list · correct · forget (with the retained-evidence exception shown: a receipt that cited the fact stays) |
| **Workspace** | endeavor context, topic snapshots (340), Library releases                           | the org/service vault    | list · who can see it · publication state                                                                 |
| **Run**       | `run.artifact`, `run.provenance`, checkpoints                                       | the acting agent's vault | ephemeral by default; promote to Library explicitly                                                       |


A personal fact never becomes workspace knowledge without a sharing act that leaves a record (T14). Promotion from
Run to Workspace is an act with a receipt, not a drag.

### 6.2 Artifact identity

Every artifact shows: exact version · author (SA) · sources (391 context refs) · scope (which vault, which grant) ·
linked work item (§4.3) · access method — **owned locally · live remote · authorized replica · derived copy**
(the four the review names; map to 338 publications and 316 delivery tiers). Share, publish and replicate are three
distinct acts (APUX-038): sharing a preview never grants vault or sandbox access.

### 6.3 Stale is a state

When a vault is unreachable or a projection is behind (396 index rebuild pending; 358 W6 tier boundaries), the UI
shows freshness and partial results and **never renders unknown as zero** (T32; the "no organizations of 37"
incident). Writes fail closed with the reason.

### 6.4 Portability

A Home export is a vault export plus the portable control-plane contracts (310 `packages/home`), with grants and
credentials **not** included (T36). The cross-Home twins in harness G4–G6 are the test that a second Home reads it.

---

## 7. One capability contract — the convergence path

### 7.1 What the review proposed vs what we compile

The review proposes a versioned descriptor (`id · version · requiredRoles · inputSchemaRef · effect · approval · idempotency · resultKind · ui{form,review} · examples · negativeExamples`) generating five projections (typed client
op · Ask/tool description · form + review card · CLI argument validation · positive/negative tests). We already have
most of it under other names; the crosswalk fixes the vocabulary so we do not build a second contract:


| Review field                              | AP field (owner)                                                                                                      | State                                                  |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `id`, `version`                           | capability id (ADR-0051) · SKILL.md contract version · definition digest (354)                                        | ✅                                                      |
| `requiredRoles`                           | contract `inputs` with `resourceArg`/`authorityArg`; parties bound to `ap:` party roles by IRI (355)                  | ✅                                                      |
| `inputSchemaRef`                          | contract `inputs`/`required` → `DefinitionToolV1.inputSchema`                                                         | ✅                                                      |
| `effect`                                  | contract `effects` (360 declared effects) + risk tier                                                                 | ✅                                                      |
| `approval{bindNormalizedAction, expires}` | mandate requirement + intent digest (350 §3.6) — bound to the resolved step by construction; expiry on the delegation | ✅ (binding is structural, not a flag)                  |
| `idempotency`                             | intent-derived single-use nonce (350)                                                                                 | ✅ structurally; **not declared per capability** → §7.2 |
| `resultKind`                              | `interaction.result` component name (361) + `declaredEffects`                                                         | ◐ name only                                            |
| `ui{form, review}`                        | `interaction.editor` / `interaction.review` / `navigationTarget` (361 I1–I2)                                          | ✅ schema · ◐ Home registry coverage                    |
| `examples` / `negativeExamples`           | playbook examples (354 K5); `check:ask-truth` eval set (358 W2)                                                       | ✅ / ◐ negatives are eval cases, not contract fields    |
| typed client operation                    | —                                                                                                                     | ❌ §7.2                                                 |
| CLI argument validation                   | —                                                                                                                     | ❌ §7.2                                                 |
| generated parity tests                    | per-feature tests; `check:interaction-coverage` checks edges, not behaviour                                           | ❌ §7.2                                                 |


### 7.2 What this spec adds to the contract (Ring-0, `capability-claims/harness-contract`)

1. `**idempotency` declaration** — `one-per-request | one-per-resource-version | replay-safe`; informs the UI's retry
  affordance and the CLI's `--idempotency-key`; verified by the existing nonce, never a second mechanism.
2. `**result.kind**` — a small closed set (`artifact | receipt | membership | message | decision | listing`) beside
  the `interaction.result` name, so a generated client and CLI know what comes back without the component.
3. **Client + CLI projection** — `generateCapabilityClient(definition)` emits a typed operation
  (`invoke<Id>(args, {surface, selection}) → RunRef`) and a CLI argument schema from `inputSchema`; both post to
   `/harness/run`. Lives beside the A2A projector as a pure function; Home and the Developer Kit consume it.
4. **Parity test generation** — `generateParityCases(definition)` yields, per capability, the positive pair
  (screen intent vs Ask sentence → same normalized plan digest) and the negative pair (forged `surface` standing
   rejected; changed resolved party after approval → digest mismatch). `check:interaction-coverage` gains a
   `--behaviour` mode that runs them against the live vocabulary (APUX-051, T02/T05/T06).

Nothing here is authority: a wrong `result.kind` costs a worse render; the gate that verifies a mandate reads none
of these fields (361 §1 invariant restated).

### 7.3 The execution path, one drawing

```
Screen button ─┐                       ┌─ resolve parties (private tier, 352; selection 353 I6)
Ask sentence ──┼─► /harness/ask|run ──►┼─ plan admission (K5-narrowed vocabulary; ambiguous target STOPS, T04)
CLI / devkit ──┤   (A2A boundary,      ├─ per-step verifyMandateForStep (chain state now; T07)
External MCP ──┘    ADR-0044)          ├─ tool / agent invocation (MCP behind admission; A2A hop = governed act)
                                       └─ task state · artifact (391) · receipt · provenance (389) · spans (390)
```

A deterministic button carries its arguments; it skips entity resolution and planning but converges on the same
admission, mandate verification and execution (T03: with the model provider down, supported manual actions still
complete). Ask adds resolution and planning in front of the same boundary. The Developer MCP (§10.4) is *not* on this
drawing: it reads release knowledge, never the runtime.

---

## 8. The `~/skills` plane — behaviour is an authored, verifiable, assigned artifact

§7's contract is *authored* somewhere, and that somewhere is `~/skills`: the archetype corpus, the compiler that turns
a SKILL.md contract into an `AgentHarnessDefinitionV1` by digest (354 K1–K3 shipped), the domain ontologies, and
the transparency log that makes every version provable. The external review saw none of this (its M10 "routines",
M16 "machine-readable developer knowledge" and APUX-034/073 are the nearest rows) and it is where most of our
*behavioural* differentiation lives. This section folds it into the three products. Boundary first, unchanged from
354 §7: **the compiler never enters Ring 0; `~/skills` imports `@agenticprimitives/`*, never the reverse; a playbook
changes what an agent knows how to do and grants nothing.**

### 8.1 What it brings that no surveyed peer has


| Differentiator (`~/skills`)                                                                                                                                                                                                                               | What ships                                                                                                                   | UX consequence                                                                                                                                                   |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Verifiable behaviour** — canonical id `skill:<ns>/<name>`, SHA-256 content commitment, append-only Merkle log, an independent validator that trusts nothing the producer says                                                                           | `skill-content`, `skills-corpus`, `skill-validator`; `skill-provenance/v1` on A2A artifacts; `skillRef` on receipts (354 K4) | "*which playbook version shaped this act*" is a provable fact on every receipt — the behaviour dimension no framework's trace has (354 §5)                       |
| **Archetypes** — one harness, many archetypes over typed agents (`person-steward`, `org-steward`, `treasury-steward`, `coordinator`, `content-catalog`, `exemplar-curator`, …)                                                                            | `archetype-compiler`; `ArchetypeAssignmentV1` vault record; the assignment ceremony with its DIFF (K3)                       | "what kind of agent" is a first-class choice; a *specialist* IS an archetype assigned to a chartered agent                                                       |
| **Domain libraries** — per-domain ontology in four layers (T-box · SHACL · C-box · A-box), skill folders owned by a **domain org**, the domain's knowledge base seeded into that org's vault, its specs as an `at:DocumentCollection`                     | `ontology/<domain>.*.ttl`, `skill-folders`, `skills-a2a` publish, `specs/<domain>/`                                          | vertical content has a home that is neither `packages/`* nor a hand table (ADR-0021): the Library gains a **Domain** facet; the Ask's vocabulary is the domain's |
| **Authoring loop** — draft · lint · publish (custodian-signed, multi-steward) · version · verify                                                                                                                                                          | `skill-web`; `POST {A2A}/publish` under the domain org's steward                                                             | Build has a **behaviour mode** that lands before the code mode (§8.3)                                                                                            |
| **Coordination with provenance** — intent → plan (DAG of specialist steps) → wave-by-wave execution → streamed EP-Plan trace                                                                                                                              | `skills-a2a` conductor                                                                                                       | the multi-specialist demonstration's plan view is this, rendered through §5.2 — coordination-plane (ADR-0054), never a second scheduler                          |
| **Developer skill packages** — `author-tbox-class`, `author-shacl-contract`, `sync-ontology-graphdb`, `cite-specs-in-evidence`, … plus one package per Home capability (`person-membership-invite`, `org-endeavor-decide`, `treasury-payment-execute`, …) | `skill-packages/`*, `skills-mcp`                                                                                             | the Developer Kit's "canonical developer skills" are corpus artifacts with digests, not a folder of markdown (§8.4)                                              |


### 8.2 Where it lands in Home Work (five places)

1. **Roster and agent creation.** Chartering an agent asks *what kind* — an archetype filtered to the agent's class
  (born-with-playbook onboarding, K3). Each roster row (§4.5) shows **playbook · version · verification state**
   beside type, sponsor and responsibility. "Add a specialist" in the demonstration is exactly: charter a service
   agent under the workspace + assign an archetype + mint its wires (329) — three acts, three receipts, no authority
   from the archetype.
2. **The inspector and receipts.** §5.2's per-step authority block gains the behaviour tuple the receipt already
  carries: *intent · mandate · playbook version · step · outcome*. Each step's `skillRef` links to the playbook body
   at that version and to **Verify inclusion** (the validator, embedded — 354 §4.1). An artifact received from
   another agent shows its `skill-provenance/v1` verdict (*resolvable · digest-match · version-match · inclusion*).
3. **Ask and Today.** The vocabulary, the example prompts and Today's "one suggested next act" (§4.2) come from the
  assigned definition (K5 narrowing) — deferred-style, names first, body on selection. An agent with no playbook
   says so; it never guesses (354 §4.3).
4. **Library — the Domain facet.** Beside Personal / Workspace / Run (§6.1) a fourth view, **Domain**: the domain
  org's skill folders (read in place, `content.catalog` → `content.artifact.<id>`), its knowledge base, its specs
   collection, its archetypes — with the domain org's stewards as custodians. A person sees the domains their agents
   are assigned from; a domain steward sees the authoring loop (§8.3). The four ontology layers are **never** shown
   on a first-use screen (the dossier's onboarding-steepness risk): a domain is presented as *a vocabulary, a
   library and a set of specialists*.
5. **Attention.** A new corpus version of an assigned playbook is an attention item (§5.5: *needs my decision*)
  with the DIFF — skills gained/lost, tools exposed, mandate types the agent would start asking for — and is
   **never auto-applied**; the reassignment is the same ceremony as the first assignment.

### 8.3 Build has two modes; behaviour comes first

Home Build for **code** is G4 (§9). Build for **behaviour** lands in G2–G3 because every piece exists: author a
playbook in the domain org's library (skill-web's loop, embedded in Home's Library or linked), lint against the
domain's SHACL, publish under the steward's signature, assign through the ceremony, run, and watch the receipt cite
the version. This is the review's three rows made concrete:


| Review row                                                         | Behaviour-Build reading                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| APUX-034 save successful work as a reusable recipe                 | a completed run → a **draft SKILL.md** in the domain library: the admitted plan as steps, the capability ids used, the parties as roles; secrets excluded by construction (the draft is compiled from the definition and the plan, never from the keyring); authority requested anew at assignment |
| APUX-073 routine and skill release lifecycle                       | corpus versions + assignment records give `draft · reviewed · published · assigned · superseded · withdrawn`; a withdrawn version stays provable (append-only) and stops being offered                                                                                                             |
| M10 "routine = versioned skill + trigger + fresh authority policy" | literally: a playbook version + a 375 trigger + a mandate the steward signs; the trigger's card names all three                                                                                                                                                                                    |


The layout is §9.2's three regions with the code area replaced by the SKILL.md editor + lint + DIFF-against-current;
the inspector shows the last run under the current version. External harness hand-off (§10.6) applies here too: a
coding agent may author the playbook through `skills-mcp` and the same publish path.

### 8.4 The Developer Kit consumes the corpus

- The kit's **canonical developer skills** (§10.5) resolve from the corpus by canonical id + version; the generated
`AGENTS.md` / `CLAUDE.md` / `.cursor/rules` are projections of pinned digests recorded in `agentic.lock.json`
(§10.4 gains a `skills` entry); `ap doctor` reports projection drift by digest, not by diffing prose.
- The **Developer MCP** (§10.4) resolves `skill_reference` and domain ontology terms from the corpus/GraphDB — read
only; it is the same "resolve, never guess" the review asks for, backed by a verifiable source.
- **Domain packs** are installable domain libraries (faith, family-office, commerce, publishing, incident-response,
field-circles…): a generated app declares the domains it grounds on; the pack brings vocabulary, archetypes,
SHACL and seed A-box. This is how a vertical arrives in a generic app without touching `packages/*`.
- **A capability added by a developer** (§13's last row) is authored as a skill package in the domain library —
contract, `interaction:` block, examples — published, compiled, assigned; the button and the Ask action appear
because the definition changed, not because anyone wired a screen.

### 8.5 Cautions the dossier already names — adopted as UX rules

- **"Verifiable" must ship its crypto.** Author signing via the delegation ceremony + the anchored log (`~/skills`
next-steps P1.1) is a G2 prerequisite for any *Verified* label on a playbook. Until then the label is **Logged**
(inclusion proven against our log) — §2.4's rule against the unqualified green badge applies to behaviour too.
- **Hide the RDF.** T-box / SHACL / C-box / A-box appear only in the domain steward's authoring loop and the
Developer MCP, never on Today, the roster, the inbox or the inspector.
- **Latency.** A conductor run is minutes; §5.1's `running` / `recovering` states, partial outcomes and artifacts as
they land (391) are the answer, not a spinner.
- **Two products share one spine** (govern/verify behaviour vs coordinate agents). In Home they are one surface
— the roster and the inspector — and the wedge decision stays with `~/skills`' own program; this spec only fixes
where each lands.

### 8.6 Gate additions (folded into §12)


| Gate | `~/skills` deliverable                                                                                                                                                                         | Exit evidence                                                                                                                               |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| G1   | roster shows playbook · version · state; inspector's behaviour tuple with Verify inclusion; Today's suggested act from the definition                                                          | the demonstration's two specialists are archetype-assigned agents; every step receipt carries `skillRef`; `check:golden-journey` asserts it |
| G2   | Behaviour Build loop on the domain org (author → lint → publish → assign → run → receipt cites it); author signing shipped; Library Domain facet; devkit skills + domain packs from the corpus | a domain steward publishes v2 and reassigns; the next run's receipt cites v2; `ap doctor` catches a drifted projection by digest            |
| G3   | save-as-recipe; lifecycle states; new-version attention item with DIFF; trigger card names playbook + trigger + mandate                                                                        | a withdrawn version is no longer offered but still verifies; a recipe installed elsewhere asks for authority anew                           |
| G5   | K6: card-release digest binding — a second Home verifies an assigned playbook against the corpus root without trusting the first                                                               | cross-Home twin: the counterparty's Home shows *Bound to release r-N · Verified* from its own validator run                                 |


---

## 9. Home Build

### 9.1 A workspace mode, not a second identity system

Build appears in a workspace's nav only when a **repository project** is attached (§4.1). Repository access is
verified independently of membership (T26): attaching a repo is an act by the workspace steward that binds a
repository identity (a deploy key or app installation held as a wire, never a personal token in the DO) to the
workspace's service agent; a member sees Build only if a grant names them.

### 9.2 Layout and loop

Three regions: **work/task panel** (the §4.3 item this build serves) · **code and artifact area** (file tree, diff,
preview, tests, changes, deployment) · **contextual inspector** (§5.2, for the build run). Lifecycle states are
distinct and named: `preview · reviewed · promoted · reconciled`. Start with an **external-editor hand-off** (branch

- PR; Codex / Claude Code / Cursor attach through §10.6's adapter) and embed more of the loop only when the golden
journey improves (review §11).

### 9.3 Isolation and credentials

Per-task worktree/branch and non-colliding ports (file isolation) are separate from process, network and credential
isolation (a separate decision). Dependency installation and generated shell run as **untrusted code** in a sandbox
(first candidate: Cloudflare Sandbox, SDK and image pinned together, benchmarked before commitment — D14), with
minimal mounts, egress control, and production credentials outside the model's reachable environment; a broker
issues short-lived scoped access where needed (T24). A sandbox id proves nothing about the principal; task and
authority semantics stay in the AP runtime (D15).

### 9.4 Review, promotion, recovery

A reviewer sees the diff **and recorded test evidence** (T28: an agent's assertion that tests passed is rendered as
an assertion, distinct from a test artifact). Promotion approval binds the tuple `(commit, deployment config, environment, permitted migration)` — its intent digest; any change voids it (T29). Recovery controls are three:
**code restore · data recovery · external compensation** (T30) — and a restore never says "undone" about a deployed
effect (§5.3).

### 9.5 Home Build is gate G4

Nothing in §9 starts before G1–G2 exit (§12). The review's caution against a new IDE is adopted: no editor of our
own beyond diff/file view; the loop is the thing.

---

## 10. The Developer Kit

### 10.1 Principle

Build **with** AP before asking anyone to build **inside** Home. The first distribution is one small, verified,
full-stack starter — Next.js app + A2A service agent + local/testnet authority path — that demonstrates a **real
authorized act and a real denied act** on synthetic data, not a page render.

### 10.2 Where it lives

Tooling that generates against `@agenticprimitives/*` is part of the Operations offering (351) and belongs in this
repo as generic, vertical-free packages: `packages/create-app` (the generator), `packages/devkit` (commands,
doctor, lock, inspector server), and a `templates/` tree the generator consumes. White-label content stays out
(ADR-0021; `check:no-domain-in-packages` applies). The Home **component registry** (§10.5) is an artifact served by
`apps/demo-sso-next` (it contains React), not a package.

### 10.3 Commands (each with `--json` for coding agents)


| Command                                                       | Result required                                                                                                                                                      |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npx @agenticprimitives/create-app@<verified-release> my-app` | resolve one compatible release; generate a runnable project with `agentic.lock.json`, env example, capability definitions, coding-agent setup, tests, inspector      |
| `ap dev`                                                      | start app + A2A boundary + safe local deps, with status; local/testnet only by default — **never asks for a private key, never broadcasts to production** (APUX-044) |
| `ap inspect`                                                  | normalized intents, context, policy verdicts, task state, artifacts — over AP events (390 spans, 381 timeline), not a second trace store                             |
| `ap doctor`                                                   | incompatible versions, missing deployment, stale skill projections, invalid bindings — stable error codes, redacted output (T22)                                     |
| `ap test`                                                     | capability behaviour + generated UI/Ask parity cases (§7.2) + negative authority cases                                                                               |
| `ap upgrade`                                                  | semantic + dependency diff; updates locks; **stops for review when a contract's authority or effects change**                                                        |
| `ap publish`                                                  | promote exact reviewed source/config to an explicit environment; retains the receipt; no standing production grant is created by install or publish                  |


### 10.4 `agentic.lock.json` and the release manifest

A package-manager lock cannot pin what AP depends on. The lock binds: package versions · contract deployment
artifact set (addresses per chain) · ontology import closure digests · SKILL.md / definition digests (354) ·
template revision · standards pins (`docs/standards-lock.json`). `ap doctor` verifies it; a clean-machine CI job
installs **packed tarballs, not workspace aliases**, creates the sample project, runs an authorized and a denied
act, and verifies output (T21, APUX-043).

**Developer MCP** (read-only, public): resolves package exports, ontology terms (T-box IRIs and comments), contract
deployments, recipes, examples and diagnostics for a coding agent. It holds no signing key, reads no vault, mints
no authority, invokes no production effect (T23). It is a third MCP, distinct from (a) the runtime's private MCP
behind admission (ADR-0057) and (b) **Home MCP** (spec 397, a person's entrance to their own agent). Confusing the
three is the failure the review warns of; the Developer MCP's manifest says so in its first line.

### 10.5 Coding-agent projections and the component registry

One canonical source — the repo's `docs/architecture/agent-rules/` and the release's developer skills — projects to
`AGENTS.md`, `CLAUDE.md` and `.cursor/rules/*.mdc` in the generated project; drift between projections is a `doctor`
finding. Always-loaded rules stay short; task skills load on demand; the agent queries the Developer MCP rather than
guessing exports.

The **Home component registry** is shadcn-compatible (registry JSON + MCP) and distributes: principal/workspace
switcher · work item view · roster · scoped search · artifact viewer · action review card · approval/resume card ·
authority explanation · result receipt. Each item ships with the capability contract it expects (§7) and an
executable example. **Installing a component never installs authority**: a component carries no keys, no grants,
no verbs — it renders a contract's projections and posts to the app's A2A boundary (D07).

### 10.6 External harness adapter

A thin **ACP adapter** with a documented A2A boundary attaches Claude Code, Codex, Cursor (then OpenCode, Goose,
Hermes, Letta): streams progress and artifacts into a Build run, requests scoped tools, never receives broad runtime
credentials (APUX-052). ACP is not A2A, not MCP, not a delegation verifier; a successful handshake grants nothing
(D19). The adapter is Ring-1 (a leaf binding, `check:optional-package-boundaries`).

---

## 11. Build / adapt / buy


| Concern                      | Decision                                                                                                                                          | Boundary                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Frontend run transport       | **prototype** an AG-UI adapter over `/harness/progress` + spans                                                                                   | A2A and authority semantics stay behind it                                        |
| React interaction stack      | **evaluate** CopilotKit vs assistant-ui external-store vs the thin client we have (AskFlyout) — pick ONE after testing against the AP state model | no second planner; no client-side state mutation that implies authority           |
| Presentation components      | AI Elements, **selective**                                                                                                                        | presentation only                                                                 |
| Dynamic forms / result views | A2UI-style **catalog-bounded** rendering, later                                                                                                   | never execute model-generated privileged UI; bound to `interaction.`* names       |
| External assistant UI        | MCP Apps via Home MCP (397), **later**                                                                                                            | host support negotiated; admission still mandatory                                |
| Sandbox compute              | Cloudflare Sandbox **first bake-off candidate**                                                                                                   | pin SDK + image; test isolation, egress, cold start                               |
| Execution state              | **preserve** AP runtime ports + DO bindings                                                                                                       | Home projects; never replaces orchestration                                       |
| Visual workflow canvas       | **defer**                                                                                                                                         | visibility before authoring; a canvas is a projection, never the store of meaning |
| Flowise                      | **do not adopt** (EOL 2026-08-31)                                                                                                                 | historical UX reference only                                                      |


---

## 12. Delivery gates (evidence gates, not dates)


| Gate                                      | Deliverable                                                                                                                                                                                                                                                                                                 | Exit evidence (scripts, not screenshots)                                                                                          |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **G0 baseline**                           | §1 census as `check:home-census` (route → contract → endpoint → test, per capability); release + protocol manifest page (`/.well-known/agentic-home` gains versions of UI, A2A profile, packages, definitions)                                                                                              | every P0 capability row has a source binding and a current test result; census diff is a CI finding                               |
| **G1 one governed work journey**          | Today (§4.2) · state vocabulary (§5.1) · cancel (§5.3) · artifact-first inspector (§5.2) · attention filters (§5.5) · work item contract (§4.3) · acting-as/in on every mutation (§4.4) · §7.2 (1)(2)(4)                                                                                                    | the §13 positive journey + its negative twin pass end to end under `check:golden-journey`; T01–T13, T16–T17, T19, T34–T35         |
| **G2 shared workspace + developer entry** | roster fields (§4.5) · invitation audit (T18) · three memory views (§6.1) · share/publish/replicate (§6.2) · `create-app` + lock + doctor + Developer MCP + inspector (§10) · §7.2 (3) · parity suite (APUX-051)                                                                                            | another developer succeeds outside the monorepo (T21–T23); another member participates without privilege confusion (T14–T15, T18) |
| **G3 reuse + operations**                 | routines as versioned skill + trigger + fresh authority (375 → product page) · save-as-recipe (excludes secrets, requests new authority on install) · component registry (§10.5) · cost on Today (§5.4; needs harness G3) · coverage dashboard (documented / implemented / tested / passing) · safe upgrade | repeatable work runs under fresh authority; T31–T32                                                                               |
| **G4 Home Build**                         | §9                                                                                                                                                                                                                                                                                                          | a generated application reaches an approved deployment with source and effect evidence; T24–T30                                   |
| **G5 federation + portability**           | external specialist grants (APUX-022) · verified export/import (§6.4) · cross-Home twins (harness G4–G6) · counterparty receipt verification (harness G2 as CLI)                                                                                                                                            | a second deployment interoperates without treating membership as a grant or cloning authority; T20, T33, T36                      |


Developer Kit work runs in parallel with G1 once §7.2 lands. Home Build waits for G2. Presence, huddle expansion
and any marketplace wait for G3.

### 12.1 The harness hand-off

harness-feature-priorities §3.4 listed what the UX phase inherits; it maps here: timeline "publicly verifiable"
badge → §2.4 + §5.2; memories by room → §6.1; fan-out pacing → §5.1 `recovering`; failure view → §5.1
`effect-uncertain`; cross-Home graph → G5; playbook ceremony re-skin → §4.4 basis line. Dev tools: Ring-1 OTel
exporter → `ap inspect`; PROV walkthrough → Developer MCP recipes; counterparty verification as CLI → G5; nightly
dashboard → G3 coverage dashboard; `~/skills` authoring app → G3 recipe lifecycle; connector install path → 397.

---

## 13. The first demonstration and its negative twin

**Positive (G1):** *"Create a workspace for our recurring group, prepare the first event with two specialists, and
build an event page. Draft the invitations and page; ask before sending or publishing."*


| Step                                                                                                                                              | What Home shows                                                                      | Existing rail                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------- |
| the person's agent resolves "our recurring group" in the private tier; ambiguity stops (T04)                                                      | Today → Ask; resolved target on the card                                             | 352 F2, 353 I6                     |
| charter the workspace under the person's org                                                                                                      | acting as *you*, in *your org*; basis: custody                                       | 344/346 `organization.team.create` |
| create the accountable work item "first event"                                                                                                    | Work item (§4.3) with owner = you, acceptance = you                                  | 334                                |
| allocate research and drafting to two specialist agents                                                                                           | roster shows the two agents' boundaries (§4.4); allocations on the item              | 334 allocation; 329 wires          |
| specialists produce artifacts (brief, invitation draft, page draft)                                                                               | Library, Run view; artifacts linked to the item                                      | 391, Library versions              |
| the run **asks** before sending: a decision request                                                                                               | Messages → *needs my decision*; review card names recipients, message digest, expiry | 393, 361 `interaction.review`      |
| approve = sign; send happens; receipts                                                                                                            | inspector: outcome → artifacts → decisions → per-step authority → provenance         | 350 §3.6, 389                      |
| "build an event page" — G1 form: publish the page **artifact** to the org site via a publication act; G4 form: generate the page as code in Build | Library publish (§6.2) / Build (§9)                                                  | 338 publication / §9               |
| a developer adds a capability to the same app with a coding agent via the devkit; a UI action and an Ask action appear under one contract         | `ap test` parity pair green                                                          | §7, §10                            |


**Negative twin (same fixtures):** revoke the sending grant while the run waits for approval → resume re-verifies
and refuses the send (T07); after approval, change a recipient → digest mismatch, no send (T06); the publish call
times out after it may have succeeded → `effect-uncertain`, reconcile before retry, no duplicate page (T09/T10);
cancel after the first invitation went out → later steps stop, the sent one is not labeled undone (T11); forge the
client's acting-as field → server refuses regardless of the UI (T05); the drafting specialist's brief contains
"grant yourself sending rights" → content is data, nothing widens (T13).

---

## 14. Measures

Time to first verified outcome · time to first usable preview (G4) · setup steps and human interventions per
accepted result · duplicate or ambiguous effects (target 0) · recovery success after induced failure · approval
burden (decisions per accepted result) · disclosure failures (target 0) · cost per accepted result (396 numbers,
model + vault + gas) · operator repair time for the devkit. Medians and tails; a common workload run against the
reference products with the same goals, fixtures and intervention rules before any parity claim (review §14).

---

## 15. What we do not build

A new IDE · a general chat platform · a generic workflow engine · a model-specific coding harness · an agent graph
as the default workspace view · a Home-local store of anything durable · a second contract beside the SKILL.md
contract · a second planner in the frontend stack · presence before the roster is right · a "parity" label for any
feature that has not run through the real UI and Ask, survived failure, and respected the same authority boundary.

---

## 16. Acceptance mapping

T01–T36 of the workbook map onto gates in §12; the ones that already have a script: T05/T06/T07 (`check:ask-truth`
authority cases; 350 W3 tests), T09 (intent nonce tests), T13 (358 W3 composer bounds), T17 (370 P2 cursor), T33
(395 W1; the counterparty script is harness G2). New scripts this spec names: `check:home-census`,
`check:golden-journey`, `check:interaction-coverage --behaviour`, the devkit clean-machine CI. None is marked passed
here; the workbook's "Not executed" stands until the script says otherwise.

---

## 17. Reference: smart-agent patterns to port

`/home/barb/smart-agent` (`003-intent-marketplace-proposal`): the org selector and role-based dashboards (its
`apps/web` org context) are the ancestor of the 315 switcher — port its *caption discipline* (always say who you are
acting as), not its layout; its delegation consent screen (caveats for window and value) is the ancestor of the
review card — keep the "show resolved target, scope and expiry before signing" order; its demo scenario scripts are
the pattern for `check:golden-journey` (one scripted journey, fixtures, assertions on chain state). Deliberate
divergence: smart-agent's UI called contract verbs directly; here every act crosses the A2A boundary (ADR-0044).

---

## 18. Open questions

1. `create-app` publication: npm scope ownership and release signing for `@agenticprimitives/*` (the devkit cannot
  be verified until packed publishing is routine — APUX-043 is the forcing function).
2. Which interaction stack wins the §11 evaluation, and whether the AskFlyout's state model is enough to be the
  external store.
3. Whether Build's sandbox adapter should be Ring-1 in this repo (like `chain-state-viem`) or a sibling repo
  (ADR-0037 says deployed infra is external; an SDK binding behind a port is not).
4. The disclosure policy vocabulary for T15 (recipient/purpose) — an ontology term before code (355 rule).

