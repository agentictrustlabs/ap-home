# Agentic Primitives UX strategy — product brief

**Date:** 2026-09-10 · **Spec of record:** [spec 398](../../specs/398-agentic-primitives-ux-strategy.md) ·
**Precedes:** the UX + developer-tools phase that harness-feature-priorities §3.4 hands off to.
**Reconciles:** the external research package of 2026-09-10 (competitive analysis + inventory/roadmap workbook).

---

## 1. The problem

We built the authority plane first and it held: every act verified per step against a revocable on-chain grant,
identity that survives the runtime, receipts a stranger can verify. Then we built the knowledge plane and bounded it
by evidence. What we did not build is the *order of the work* as a person experiences it. Home has ~111 routes, an
Ask, a Work board, a Card Studio, a Playbook, a run timeline — and a newcomer opens it and sees a status page, a
message list and a settings pane. The differentiation is real and invisible.

The external review, working without repo access, marked half our Home capabilities "unverified" — and was still
right about the target: **make the work visible, governable, and easy to extend.**

## 2. The promise

> Describe an outcome. Your agents and your team do the work. You can see it, steer it and approve it. The result
> stays yours to inspect, extend and move.

Four clauses. Every screen earns one of them or is not on the first-use path.

## 3. Three products, one spine

| Product | For whom | What it is | Gate |
| --- | --- | --- | --- |
| **Home Work** | a person and their team | Today · Work (accountable items) · Messages with an attention model · Library · Activities — directing agents on real work, with *who is acting, where, on what basis* on every act | G1–G3 |
| **Home Build** | the same team when the work needs software | a workspace mode: repo attached, isolated changes, sandboxed execution, preview, review with recorded test evidence, promotion bound to commit+config+env | G4 |
| **Developer Kit** | developers and their coding agents | `npx @agenticprimitives/create-app@<release>` → a running Next.js + A2A starter with `agentic.lock.json`, doctor, inspector, generated `AGENTS.md`/`CLAUDE.md`/Cursor rules, a read-only Developer MCP, a shadcn-compatible component registry | G2–G3 |

The spine is the **one capability model** this repo already compiles: SKILL.md execution contract →
`AgentHarnessDefinitionV1` → `InteractionBindingV1`. The UI action, the Ask tool, the review card, the CLI arguments
and the parity tests are all projections of it (spec 361; spec 398 §7 adds the two missing projections — typed
client/CLI and generated parity tests — and two small fields, `idempotency` and `result.kind`). We do not adopt the
review's proposed descriptor as a second contract; spec 398 §7.1 crosswalks it field by field onto what exists.

### 3.1 The fourth piece: `~/skills`, where behaviour is authored and proven

The spine's contract is authored in `~/skills` — the archetype corpus, the compiler that turns a SKILL.md into a
harness definition by digest, the per-domain ontologies, and an append-only transparency log with an independent
validator. The external review never saw it, and it carries most of our *behavioural* differentiation
(spec 398 §8):

- **Provable behaviour.** Every receipt already cites the playbook version that shaped the step (`skillRef`);
  Home shows *intent · mandate · playbook version · step · outcome* and a **Verify inclusion** button. No surveyed
  framework can say which version of its instructions shaped an act.
- **Specialists are archetypes.** "Add a specialist" = charter an agent + assign an archetype through a ceremony
  that previews the DIFF and says "grants no authority". The roster shows playbook · version · state per agent.
- **Domains are libraries.** A vertical (faith, family-office, commerce, publishing…) arrives as a domain library
  owned by a domain org — vocabulary, archetypes, SHACL, knowledge base — never as code in `packages/*`. The Library
  gains a **Domain** facet; the RDF stays hidden outside the steward's authoring loop.
- **Build for behaviour before Build for code.** Author → lint → publish (custodian-signed) → assign → run → the
  receipt cites it. This lands in G2–G3 because every piece exists; it is the honest form of "save as recipe" and
  "routine = versioned skill + trigger + fresh authority".
- **The Developer Kit reads the corpus.** Developer skills, `AGENTS.md`/`CLAUDE.md`/Cursor projections and domain
  packs are pinned by digest in `agentic.lock.json`; `ap doctor` catches drift by digest.

Two rules carried over: the compiler never enters Ring 0, and a playbook's label is **Logged** until author signing
and the anchored log ship — then **Verified**.

## 4. Where we stand (the census the review asked for)

Shipped and under-counted by the review: workspaces, membership, roster, external-agent invites; the Work board with
allocations, commitments and decisions; discussions, channels, huddles; the Ask with scope, selection, Edit-in-form,
unfinished runs, How/evidence; durable runs and parked approvals; run timeline + provenance export; plain-language
authority text; the Library with versions; `packages/home`.

Truly absent: the whole Developer Kit; Home Build; a *cancel* control (revoke exists, cancel does not); cost shown
anywhere; an outcome-led Today; an attention model distinct from unread; personal vs shared memory views; the agent's
compute/credential boundary on the roster. Spec 398 §1 is the full table and becomes `check:home-census`.

## 5. How we differ, said carefully

Buzz gates on room membership. Notion's agent may read what the triggering user may not. Grok's bots under one user
share one computer. Enterprise suites have real scoped identity — we do **not** claim they have "only prompts or
OAuth". Our difference is narrower and provable:

*Being a participant does not authorize an action. The requested effect must be within the acting principal's
current, scoped delegation.* Their approval is a click in their store; ours is a signature over the resolved
action's digest, checked per step against chain state, leaving a receipt anyone can verify. The UI's job is to make
that sentence legible to a non-developer at the moment of the act — and to say honestly what a signature does *not*
prove (that the answer is true, that the browser action succeeded, that a SaaS token elsewhere is governed).

## 6. The first demonstration

*"Create a workspace for our recurring group, prepare the first event with two specialists, and build an event page.
Draft the invitations and page; ask before sending or publishing."*

One Person Agent, one Workspace Agent, two specialists, one private source, one approval, one artifact, one
controlled external effect. Then a developer adds a capability to the same app with a coding agent through the
devkit and sees a button and an Ask action appear under one contract.

Its **negative twin** is the product argument: revoke while paused → resume refuses; change the recipient after
approval → digest mismatch; a timed-out publish → "unknown, reconciling", never a duplicate; cancel after one send →
the sent one is not called undone; forge the client's acting-as → the server does not care what the UI said.

## 7. Gates, not dates

| Gate | Exit evidence |
| --- | --- |
| **G0** baseline | census script green; release/protocol manifest inspectable |
| **G1** one governed work journey | the demonstration and its negative twin pass under one script |
| **G2** shared workspace + developer entry | another developer succeeds from a clean machine; another member participates without privilege confusion |
| **G3** reuse + operations | routines and recipes run under fresh authority; cost and coverage visible; safe upgrade |
| **G4** Home Build | a generated app reaches an approved deployment with source and effect evidence |
| **G5** federation + portability | a second deployment interoperates without treating membership as a grant or cloning authority |

Developer Kit starts in parallel with G1 once the contract additions land. Build waits for G2. Presence, marketplace
and a workflow canvas wait for G3 or are deferred outright.

## 8. Build / adapt / buy, in one line each

Prototype an AG-UI adapter over our progress stream; evaluate CopilotKit vs assistant-ui vs our own flyout and pick
**one**; reuse AI Elements selectively; bake off Cloudflare Sandbox (pinned) for Build; attach Claude Code / Codex /
Cursor through a thin ACP adapter, never adopt one as *the* harness; defer a visual canvas; do not adopt Flowise
(EOL 2026-08-31).

## 9. What we will not build

A new IDE. A general chat platform. A workflow engine. A model-specific coding harness. An agent graph as the default
view. A Home-local store of anything durable. A second contract. A second planner in the frontend. A "parity" label
for anything that has not run through the real UI and Ask, survived failure, and respected the same authority
boundary.

## 10. Measures

Time to first verified outcome · setup steps and interventions per accepted result · duplicate/ambiguous effects
(0) · recovery success · approval burden · disclosure failures (0) · cost per accepted result · devkit repair time.
Medians and tails, against reference products on a common workload, before any parity claim.

## 11. Decision requested

Adopt spec 398 as the program of record for the UX + developer-tools phase; run G0 (`check:home-census`) this week;
start G1 with Today, the state vocabulary, cancel, and the artifact-first inspector; start the Developer Kit's
`create-app` + lock + doctor as soon as spec 398 §7.2 lands.
