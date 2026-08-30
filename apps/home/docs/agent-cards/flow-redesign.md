# Card & Projections — flow redesign (2026-08-30)

**Status:** design of record for the rebuild. Supersedes the tab/stepper IA in `ux-design.md` §1–§9 where they
conflict; the component-level rules there (field rows, diagnostics copy, BusyButton, `VERSION_LABELS`) still hold.

## 0. The complaint, verbatim, and what each sentence tells us

The product owner walked the working flow as a non-technical steward and asked:

| What they said | What it reveals |
| --- | --- |
| "It is not clear what to do to make it active. Should I select Validate?" | The card has no single primary action. Validate is a *system* step, not a *user* goal. |
| "It has all the steps down the left. What do I do?" | The section rail reads as a to-do list. It is a table of contents. |
| "Projections… what am I supposed to do with them. Eventually we will have lots. Do I set them up here?" | "Projection" is our noun. The user's noun is *listing* — places the agent appears. |
| "All the words for AP Naming and AP Registry do not make sense. Do I hit Preview?" | Target names are spec references. "Preview" is a pipeline stage, not a decision. |
| "Losses: 5… CARD_NOT_SELECTED… the Smart Agent must sign binding-proof digest sha256:88e1… (ERC-1271)" | Diagnostics are being shown as the *main* content. They are the exception path. |
| "Are they different things? Are they needed before Names & Bindings? … which I don't know what I am supposed to do there" | Tabs are peers with no order, and one of them (Names & Bindings) has no action at all. |
| "Releases & Audit… no idea what that does. Does it update the a2a agent card?" | The thing that actually makes the card live is hidden under an audit-sounding label. |
| "Should Projections be after the A2A agent card?" | **Yes.** The user has intuited the real dependency graph. The UI hides it. |

The last row is the key: the dependency order exists (card → published card → listings), the user can feel it, and the
UI presents four unordered tabs. Everything below follows from making the order visible and giving each stage ONE
primary action.

## 1. The job, in the user's words

> "Make my agent findable and reachable."

That is three things, in a fixed order, and the page says so:

```
 ① Describe it          ② Make it live               ③ List it
 what the agent is      publish the card at its       appear where others look
 and how to reach it    public address                (name record, directory…)
```

Nothing else is a top-level concept. Releases, approvals, signatures, provenance, digests, projections, artifacts,
bindings — all real, all kept, none on the main path.

## 2. Information architecture

**One page per card, three stages stacked vertically**, each a card with: a status line (plain sentence), what it
means, and exactly one primary button (or "Done ✓" with a secondary action). A stage below the current one is
visible but dimmed with the sentence that unlocks it ("Publish the card first"). Tabs are gone.

```
Card & Projections › northern-colorado-field.workspace                     [History] [Advanced ▾]

┌ ① Describe your agent ──────────────────────────────────── Ready to publish ✓ ┐
│ Name, what it does, how to reach it. Most of this is filled in from the      │
│ agent's profile — change only what should differ.                            │
│ [ Edit description ]                                                          │
└──────────────────────────────────────────────────────────────────────────────┘
┌ ② Make it live ─────────────────────────────────────── Not published yet ┐
│ Publishing puts a signed copy of this description at                          │
│ https://northern-colorado-field-workspace.faithnet.ai — the address other     │
│ agents use to find and talk to it.                                             │
│ [ Publish ]                                                                    │
└──────────────────────────────────────────────────────────────────────────────┘
┌ ③ List it ─────────────────────────────────────────── Publish the card first ┐
│ Your name record     Point northern-colorado-field.workspace at this card    │
│ Faithnet directory   Appear where agents and people search                    │
└──────────────────────────────────────────────────────────────────────────────┘
```

Route: the existing `/service/<sa>/card/<cardResourceId>` (and org twin) renders this page. The old tab routes
`/projections`, `/names`, `/releases` **redirect** to it with `#list`, `#list`, `#history` respectively — deep links
in inbox/approval cards keep working.

## 3. Stage ① Describe — the editor becomes a sub-screen, not the landing

- The landing shows a **summary**: name, one-line description, the public address, how many skills, and a status
  line. `[Edit description]` opens the existing editor (two columns + flyout inspector) as a sub-screen with a
  `← Back to overview` link.
- **Validate is no longer a button the user must find.** The draft is checked automatically on every save (the
  service's `card.validate` is cheap and already idempotent). The stage's status line IS the validation result:
  - clean → *"Ready to publish ✓"*
  - errors → *"2 things to fix before publishing"* with a `[Show me]` that opens the editor scrolled to the first
    diagnostic (the existing `?diagnostic=` deep link).
  - never saved → *"Filled in from the profile — review it, or publish as is."*
- The section rail keeps its blurbs but gets a one-line header above it: *"Sections of the description"* — so it
  reads as a table of contents, which is what it is.
- Everything technical (Effective JSON, live endpoint bytes, provenance, release diff) stays in the flyout, opened
  from `[Advanced ▾]` or a field's Inspect control. Not on the landing.

## 4. Stage ② Make it live — ONE button that does the whole chain

The chain `validate → create release → request approval → approve → sign → publish → verify` exists because the
*roles* can be different people. When they are the same person — the default (`SEPARATION_OF_DUTIES` off) and every
demo persona — asking them to press six buttons in sequence is asking them to operate our state machine by hand.

`[Publish]` runs the chain as one busy action with progress labels that name the work, in the user's words:

```
Checking the description…  →  Freezing this version…  →  Signing it…  →  Publishing…  →  Confirming it's live…
```

It stops only where a genuine decision or a different person is needed:

| Situation | What the user sees |
| --- | --- |
| Draft has errors | Button disabled: *"Fix 2 things in the description first"* + `[Show me]`. Never a 4xx after the click. |
| Smart Agent binding (custodian signature) | One prompt, explained: *"Your custodian signs once so verifiers can prove this agent authorized the card. Most A2A clients don't need this — you can skip it."* `[Sign with custodian]` / `[Skip for now]`. |
| Separation of duties strict, or the user lacks approve/sign/publish | The chain stops at that step with *"Waiting for someone with approval rights"* and the approval card already used by the inbox. This is the ONLY time the individual steps show. |
| Publish verified | *"Live ✓ — serving at https://… since 2:41 pm."* `[Open]` (the public URL) `[Re-publish]` (enabled only when the description changed since). |
| Verify could not confirm | The existing `publicationVerdict` sentences — what's true, what to do. |

Under the status line, one sentence answers the owner's question directly: *"Publishing does not list the agent
anywhere — it makes the description available at its address. Listing is step ③."*

The A2A JWS is generated in the browser as today (it's the standard signature every A2A client checks); the release,
approval and publish calls are the same service ops — the UI orchestrates them, the service still enforces every
scope. Nothing in the authority model changes.

## 5. Stage ③ List it — "projections" become listings with product names

Each projection family renders as **one row with a product name, a plain purpose, a status, and one button**. Names
come from the app's white-label config, never from spec numbers:

| family | title (Faithnet build) | purpose sentence |
| --- | --- | --- |
| `ap-naming` | **Your name record** | *Point `northern-colorado-field.workspace` at this card, so anyone who looks the name up finds it.* |
| `ap-registry` | **Faithnet directory** | *Appear in the directory agents and people search.* |
| (future) `ard`, `acp-registry`, `oasf`… | from config | one sentence each |

Statuses and their single button:

| status | line | button |
| --- | --- | --- |
| not listed | *Not listed* | `[List it]` |
| listed & current | *Listed ✓ · updated 2:52 pm* | `[Open]` (the record / entry) |
| out of date | *Listed, but shows an older version of the card* | `[Update listing]` |
| needs the card first | *Publish the card first (step ②)* | — |
| cannot (missing role) | *Needs someone with listing rights for the directory* | — |

`[List it]` runs `configure → preview → plan → approve → execute with custodian → record` as one busy action:
*"Preparing…" → "Your custodian signs once to write the record" → "Writing to the chain…" → "Confirming…"*. The
single custodian prompt is explained in one line, the way step ② explains its binding. That prompt IS the sentence
*"the Smart Agent must sign binding-proof digest sha256:88e1… (ERC-1271)"*, translated.

**Losses, diagnostics, digests, artifact/bundle hashes, target spec versions, adapter versions** move behind a
`[Details]` disclosure on the row. A loss that changes what the listing will say (e.g. skills the directory cannot
carry) is summarised in ONE sentence above the button: *"The directory can't show 2 of your 5 skills — it will list
the other 3."* Never a code (`CARD_NOT_SELECTED`), never a count of losses as the headline.

**Names & Bindings folds into this stage** as the status column — ownership/resolution/identity was already
collapsed to one confirmed line by the last pass; that line becomes the header of the stage: *"Your name
`northern-colorado-field.workspace` resolves to this agent ✓"*. Its detail rows are the `[Details]` of the name-record
listing.

**Scaling to many listings** (the owner's "eventually we will have lots"): the stage becomes a list with a search
box and a *"Suggested for this agent"* group first (from the deployment's config), then *"All directories"*. Each
row is the same three-part shape. Nothing per-target is bespoke UI — adapters contribute a name, a sentence and an
icon (spec 347 §8.4's declarative manifests).

## 6. History and Advanced

- **`[History]`** replaces "Releases & Audit": a read-only timeline — *"Published v3 · Listed in your name record ·
  Updated Faithnet directory · Published v2 …"* — with the audit detail (digests, approvers, receipts) per entry
  behind a disclosure. Deprecate / revoke live here, under the version they act on, with the existing reason
  requirement.
- **`[Advanced ▾]`** opens the flyout inspector on the landing (Effective JSON, live endpoint bytes, provenance,
  validation, projection impact, release diff) — the same panels, unchanged.

## 7. Vocabulary map (app copy → what it was)

| Say | Instead of |
| --- | --- |
| description / the card | draft, effective card, canonical profile snapshot |
| version | release |
| publish / live | release + sign + publish + verify |
| listing / list it / update listing | projection / preview / plan / publish |
| your name record · Faithnet directory | AP Naming · AP Registry |
| "your custodian signs once" | ERC-1271 binding-proof digest / SmartAgentCardBindingV1 |
| "can't show N of your M skills" | Losses: N |
| check the description / N things to fix | validate / diagnostics |
| History | Releases & Audit |

`VERSION_LABELS` keep their normative strings where a version is named ("Agent implementation version"), and the
technical words remain in `[Details]`/`[Advanced]` and in History — they are true, they are just not the main path.

## 8. What does NOT change

Every service op, every scope check, every signature, every receipt, the vault records, separation of duties, the
approval cards in the inbox, the audit actions, ADR-0062's editor ≠ approver ≠ signer ≠ publisher. The UI stops
asking the user to drive the state machine; it does not remove a state. When roles are split, the machine's steps
reappear exactly where a different person has to act.

## 9. Acceptance (drive it as a non-technical persona with Playwright)

1. A new agent: landing shows ① with *"Filled in from the profile — review it, or publish as is"*, ② with a single
   `[Publish]`, ③ dimmed with *"Publish the card first"*. No other primary buttons on the page.
2. Press `[Publish]` once: the busy label walks through the five phrases; the custodian prompt appears once with its
   explanation; ② ends at *"Live ✓ — serving at https://…"* with a working `[Open]`; ③ becomes active.
3. Press `[List it]` on *Your name record*: one custodian prompt, one busy sequence, row ends at *"Listed ✓"*, the
   stage header shows the name resolving to the agent.
4. Nowhere on the landing page: the words projection, release, digest, sha256, ERC-1271, spec, adapter, bundle,
   artifact, validate, CARD_NOT_SELECTED. (Test greps the rendered text.)
5. With `SEPARATION_OF_DUTIES=strict` and an editor-only persona, ② stops at *"Waiting for someone with approval
   rights"* and shows the approval card; nothing else changes.
6. Old tab URLs redirect to the landing with the right anchor.
