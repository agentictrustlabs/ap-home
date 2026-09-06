# Spec 361 — The Interaction Contract: one governed capability, every surface a projection

**Status:** Draft · **Kind:** program + Ring-0 schema extension
**Grounds:** [354](354-archetype-driven-agent-behavior.md) (SKILL.md execution contracts → compiled
definitions; K1–K6 shipped) · [360](360-declared-effects-what-follows-the-act.md) (declared effects) ·
[353](353-app-scoped-ask.md) (`AskScopeV1`) · [350](350-authority-aware-agent-harness.md) ·
[355](355-ontology-driven-ask-and-orchestration.md) · [ADR-0044](../docs/architecture/decisions/0044-a2a-is-the-agentic-orchestration-layer.md) ·
[agent-rules/one-capability-model-generates-both.md](../docs/architecture/agent-rules/one-capability-model-generates-both.md) ·
External review 2026-09-06 (Palantir Action Types / Salesforce Headless 360 / CopilotKit / Tambo /
App Intents — assessed §7).

## 0. Where this session already got to, and what is genuinely missing

The binding rule already says it: *define the capability model once; generate the UX behaviour and the
agent surfaces from it.* What exists today, live:

| Contract area (review §4A) | Owner today | State |
| --- | --- | --- |
| **Meaning** (id, intent, outcome) | capability (ADR-0051 id + label) + SKILL.md prose | ✅ live |
| **Inputs** (schema, required, entity classes) | contract `inputs`/`required` → definition `inputSchema` | ✅ live |
| **Authority** (mandate type, args, approvals) | contract `authority`/`approvals`; NEVER merged over the running gate (`mergeContractTool`) | ✅ live |
| **Execution** (handler, idempotency, resume) | TypeScript invokers; intent-derived nonces; durable-run checkpoints | ✅ live (W3 partial) |
| **Effects** (what follows the act) | contract `effects` → `declaredEffects` → the sink | ✅ live (spec 360) |
| **Learning/discovery** (archetypes, skills, examples) | `skills:includesSkill`, corpus, playbooks | ✅ live |
| **Interaction** (editor, review, result, navigation) | **NOWHERE** — hand-wired per screen, absent from Ask | ❌ this spec |
| **Verification** (parity tests, coverage) | per-feature tests; no capability-level manifest | ❌ this spec |

And the five parities (review §1), honestly scored:

- **Capability parity** — ✅ mostly: `/harness/vocabulary` publishes what the playbook offers; the K5
  narrowing keeps it honest.
- **Context parity** — ◐ `AskScopeV1` carries realm + ceremonies; selected-entity/filter/draft context
  does not reach Ask.
- **Execution parity** — ❌ **the deepest gap and it is already named in CLAUDE.md**: "the first-party
  web↔a2a surface is RPC-shaped TODAY … the relayer verbs are legacy." A Home button and the same words
  in Ask do NOT reach one implementation.
- **Presentation parity** — ❌ Ask cannot open a screen, populate a draft, or render the review
  component a screen already has; it renders generic prompt fields.
- **Continuity parity** — ◐ durable runs give resume; but a draft has no identity a screen can edit and
  Ask can then send (the checkpoint is close — it is not yet a shared surface).

## 1. The invariants (all inherited, one new)

1. **Behaviour is generated; authority never is** (the standing rule). The interaction block is the most
   behavioural layer yet: a wrong editor name costs a worse screen, never an unauthorized act. It is
   merged like `description`, and the authority fields stay unmergeable.
2. **A widget is not a plan step** (review §4D). A component may *initiate, edit, approve or display* a
   step; committing is the harness's, under the mandate. Updating a displayed role field must not grant
   the role.
3. **A click is not a sentence.** A form that already knows its intent and parameters submits the
   structured intent directly to the A2A boundary. Ask adds interpretation and entity resolution in
   front of the SAME boundary. Never route a button through an LLM; never let Ask reach an
   implementation the button cannot.
4. **NEW — presentation operations are enumerated, never free-form.** Ask may drive the screen only
   through declared ops (`navigate`, `openEntity`, `prefillDraft`, `focusField`) that the contract or
   the surface names. No arbitrary DOM/JS reach; each op is display-plumbing that decides nothing.

## 2. Ring-0: `InteractionBindingV1` (the schema this repo adds)

On `SkillExecutionContractV1` and carried into `DefinitionToolV1`:

```yaml
interaction:
  editor: MemberInvitationForm        # component NAME — resolved by the app's registry, never code
  review: MemberInvitationReview      # what a person sees before approving (the authority card's body)
  result: MemberInvitationReceipt     # how the outcome renders (grounded in the receipt, spec 358 W3)
  navigationTarget: members           # where "open it" goes after done — an app route KEY, not a URL
```

All four optional, all strings, all **names** an app resolves through its own registry — a contract
never carries a URL, a component implementation, or anything executable (the AUTHORITY_KEYS tripwire
already sweeps the whole object). An app with no registration for a name falls back to today's generic
rendering: the binding refines, its absence breaks nothing (the playbook rule, again).

**Why names-in-contract rather than bindings-in-app-config:** the contract is the one artifact the
domain author edits, and "which screen reviews an invitation" is domain knowledge exactly as "who gets
told about a payment" was (spec 360). The app still owns the mapping name → component — white-label
apps resolve the same name differently (ADR-0021).

## 3. Ontology: the action is a modelled thing (the Palantir Action Type analogue)

`aps:` gains the T-box half the review calls "governed behavior in the semantic layer":

- `aps:ActionContract ⊑ dns:Description` — the description under which an act of this capability is
  interpreted: which capability id, which party roles (already `PARTY_ROLES`), which entity classes its
  inputs resolve to (already `inputs:` classes), which Situation must hold for it to be AVAILABLE
  (a membership invite is available in an `aporg:StewardshipSituation`, not from `isAdmin` on a screen).
- Availability ≠ permission: the situation gates what is OFFERED (behaviour); the mandate decides what
  MAY happen (authority). Same split as K5's vocabulary narrowing, now modelled instead of coded.
- P-PLAN stays the composition layer (a chartering plan's steps reference contracts; spec 358 W4 plan
  shapes are the precedent); PROV-O stays the record of what actually ran (receipts, K4 `skillRef`).

**The Action Type crosswalk** (Foundry docs, fetched 2026-09-06 — every named part gets a named home,
and two of ours are deliberately stronger):

| Foundry Action Type part | Ours | Note |
| --- | --- | --- |
| Parameters (typed inputs, defaults, dropdown filters) | contract `inputs`/`required` → `inputSchema`; entity resolution via `PARTY_ROLES` | ours resolves parties in the ontology, not per-form |
| Submission criteria (pre-submission eligibility) | §3 situation-gated AVAILABILITY (`aps:ActionContract` requires a Situation) | availability ≠ permission — offered vs allowed stay split |
| Rules/logic (validation, derived values, auto-links) | validators + invoker preconditions (`capability-preconditions.ts`) | stays code: it judges, so it is never contract prose |
| Side effects → notifications / webhooks | spec 360 `effects:` (record + thread); webhooks = a future surface kind, same schema seat | recipient pinned to the step's own arg — Foundry has no disclosure rule |
| Form configuration / sections | `interaction:` binding (this spec) | names an app resolves; never layout in the contract |
| Permissions (roles/attributes) | mandates + enforcers (ADR-0041) | **stronger**: signed, intent-bound, on-chain revocable — not an ACL |
| Writeback dataset / transaction record | receipts (`StepReceipt` + K4 `skillRef`) + vault artifacts | **stronger**: the parties hold the artifact, not only the platform |
| Function-backed actions for AIP agents | the same `/harness` boundary Ask uses | one boundary is the whole point (§1.3) |

## 4. The draft is the checkpoint, made a surface

Review §4F asks for stable draft identity + version + approval bound to reviewed parameters. The
substrate already has the pieces: `HarnessRunCheckpointV1` (identity = `runRef`; the supplied answers
ARE the draft), `approvalDigestFor` (binds approver to stepRef + mandateRef + intentDigest + capability
+ action + resource — a changed resource is a changed digest, so a stale approval already cannot
authorize a changed request). What is missing is the SHARED surface:

- `GET`-shaped read of a run's current draft (the checkpoint minus the keyring — the `list` op's rule).
- A screen editing a draft writes a `supplied` answer to the run (the same merge the Ask turn does),
  so "Ask prepares → form edits → Ask sends" is one run, not a conversation remembering parameters.
- The **current draft version** is what executes: a resume re-derives and re-verifies from the
  checkpoint (already the law), so the form's last edit is what the mandate is judged against.

## 5. Waves

| Wave | Deliverable | Gate |
| --- | --- | --- |
| **I1** | Ring-0 `InteractionBindingV1` (contract + definition + validator); compiler pass-through; `mergeContractTool` merges it (behavioural side) | contract → live definition carries `interaction`; authority fields still unmergeable (tests) |
| **I2** | Home interaction registry (`name → component/route`) + Ask consumes `navigationTarget` (done-reply "open it") + `review` (authority card renders the bound component) | the invite ask shows the SAME review surface the members screen uses |
| **I3** | Coverage manifest gate `check:interaction-coverage`: every offered capability → contract → words → ceremony renderable → interaction binding or NAMED waiver; missing edges are findings, not silence | gate red on an unbound capability |
| **I4** | Execution parity, first slice (org membership invite): the Members screen's invite submits the structured intent to `/harness/run`; the legacy verb path retired for that one feature; a parity test drives both and asserts one implementation, one receipt trail | click and Ask produce byte-comparable receipts |
| **I5** | Draft surface: run-draft read + screen-side `supplied` write; the invite draft editable from the members screen mid-ask | prepare in Ask → edit in form → "send it" executes the edited version |
| **I6** | Context projection: `AskScopeV1` gains `selection` (entity refs + filters + open draft), permission-filtered; presentation ops (`navigate`/`openEntity`/`prefillDraft`/`focusField`) | "invite *her*" resolves the selected member; ops are enumerable in the reply, not free-form |
| **I7…** | Repeat I4 per feature family (profile, delegation, card publication, service config), each with its parity test — the spec 359 domain cadence | per-family |

## 6. What we deliberately do NOT adopt (from the review's catalogue)

- **CopilotKit / Tambo / assistant-ui runtimes as owners of conversation state.** The loop, the run
  lifecycle and the checkpoint are Ring-0 (`orchestration`, ADR-0044) — a second owner of run state is
  the exact bug class the DO single-writer exists to prevent. Tambo's *interactable-components pattern*
  is adopted as I5's design target; its runtime is not.
- **AG-UI / A2UI / WebMCP now.** Projections for clients we do not yet have. The contract is written so
  a projection can be generated later (that is the point of it being data); none becomes a second
  implementation of an action.
- **A tool per button.** Semantic capability parity, not click imitation — the review's own
  qualification, and K5's already.
- **Model-supplied identity or authority anywhere in the contract.** Actor and effective authority come
  from the session and the chain (ADR-0041); the tripwire enforces it structurally.

## 7. Review verdicts kept for the record

Palantir Action Types = this spec's §3 (adopted as pattern, not platform). Salesforce Headless 360 =
the strategic comparator for "define once, project everywhere" — our §5 I4 is the same claim with
on-chain authority instead of platform metadata. Apple App Intents = the declaration-independent-of-
navigation precedent our vocabulary already follows. CopilotKit's component-lifecycle tool
registration is cited as the ANTI-pattern for capability cataloguing (review §4E): Home registers
capabilities independently of mounted screens — the playbook already is that catalogue.
