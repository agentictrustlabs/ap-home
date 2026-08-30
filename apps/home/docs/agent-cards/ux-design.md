# Agent Card & Projection Studio — UX Design

**Surface:** `Home › Agents › {agent} › Card & Projections`
**Spec of record:** [`specs/347-a2a-agent-card-and-projection-studio.md`](../../../../specs/347-a2a-agent-card-and-projection-studio.md) §3, §4.3, §4.4, §9
**ADR of record:** [ADR-0062](../../../../docs/architecture/decisions/0062-agent-card-projection-publication-binding.md)
**Renders (portable, UI-framework-neutral):** `packages/home/src/agent-management/{card-editor-manifest,projection-center-manifest,action-cards,permissions}.ts`
**App (this doc):** `apps/demo-sso-next` — Next.js App Router, light corporate palette (Warm Civic Light — no dark mode)
**Status:** Design deliverable — build starts from this spec + the manifests. No components have been written yet.

---

## 0. Goal & users

Every managed agent that can speak A2A needs a card that tells the truth — what it is, how to reach it, what
it can do — and a controlled way to make that truth show up in external registries. Today that truth is
authored three different ways and none of it is signed the way an A2A client actually verifies. The Studio
gives the member (or their org's steward) one place to: **author** a card by inheriting from what's already
true about the agent and curating with full provenance, **release** it through a real approval chain instead
of a silent edit, **project** it into AP Registry / AP Naming (and, later, external registries) with visible
loss and drift, and **bind** external identifiers back to the canonical agent.

**Users, by role:**
- **Steward / org admin** (human) — the primary user. Drafts, curates, and (if entitled) approves, signs, and
  publishes. Most orgs will have one person who can do everything in a demo environment, but the UI must
  never blur the four duties into one action even when one person holds every scope.
- **Agent Metadata Steward** (service agent, spec-327 pattern) — may read, draft, validate, preview, and
  explain. Every field it proposes is visibly AI-authored with its own provenance lane (§7). It cannot sign,
  publish, transact, or mark anything verified.
- **A non-AP A2A client** (external, not a Home user) — never sees the Studio, but is the reason the JWS
  signature exists: it verifies the card without knowing anything about Smart Agents.
- **An AP-aware verifier / registry** (external) — checks the JWS *and* the Smart Agent binding.

This surface governs **any custodial agent that can present an A2A card** — today that means an **org**
workspace or a **service-class** workspace (ADR-0046); a person's own SA does not yet get a card in this
wave (open question, §9).

---

## 1. Information architecture + navigation

### 1.1 Where it lives

The app's workspace model has three scopes (`src/lib/workspace.ts`): person (`/you`, flat), org
(`/org/<sa>/…`), service (`/service/<sa>/…`). Card & Projections is a **Manage-band** item — same tier as
Records / Access / Settings, not a daily-use surface like Messages — added to both the **org** and
**service** nav groups in `src/components/portal/nav.ts`:

```
Organization workspace                    Service workspace
├─ Overview / Messages / Discussions       ├─ Overview
├─ Work / Library                          ├─ Messages
└─ Manage                                  └─ Manage
   ├─ Profile                                 ├─ Agent (playbook)
   ├─ Agent (playbook)                        ├─ Card & Projections   ← NEW
   ├─ Card & Projections   ← NEW               ├─ Records
   ├─ Members                                  └─ Access
   ├─ Records
   ├─ Access
   ├─ Trust graph
   ├─ Treasury
   └─ Settings
```

Placed immediately after **Agent** (the playbook/bot config) and before **Members**/**Records** — it is an
identity-and-presentation concern, a sibling of Profile and Agent, not a data or authority surface. New
`NavItem` ids: `org-card` → `orgHref(a, 'card')`, `service-card` → `serviceHref(a, 'card')`. New icon: see
§10 (component inventory) — neither `TagIcon` (already Naming/Metadata) nor `CodeIcon` (already "Your apps")
reads as "agent card"; add a small id-card glyph (`IdCardIcon`) following the existing `Svg` wrapper in
`src/components/shared/Icons.tsx`.

Member-relationship gating follows the existing org pattern: **steward-only**. `orgRelationship === 'member'`
never renders the Manage band at all (spec 318), so Card & Projections is invisible to plain members exactly
like Records/Access/Settings are today — no new gating logic needed, just place the nav item inside the
existing steward-only block.

### 1.2 Route map — list vs. editor

One agent → 0..n card resources (spec 347 §3), so the top-level route under Card & Projections is a **list**,
not a single editor:

```
/org/<sa>/card                                    Cards list  (this agent's card resources)
/org/<sa>/card/<cardResourceId>                   Editor — tab: Agent Card        (default)
/org/<sa>/card/<cardResourceId>/projections       Editor — tab: Projections
/org/<sa>/card/<cardResourceId>/names             Editor — tab: Names & Bindings
/org/<sa>/card/<cardResourceId>/releases          Editor — tab: Releases & Audit

/service/<agent>/card                             (same shape, service workspace)
/service/<agent>/card/<cardResourceId>[/…]
```

Tabs are real routes (not client-side-only state), matching the Records/Playbook/Access pattern
(`app/(portal)/service/[agent]/{records,playbook,access}/page.tsx`) — each tab is independently deep-linkable,
refreshable, and back-button-safe. Component split mirrors `ServiceWorkspace.tsx`: one shared module
`src/components/portal/agent-cards/CardStudio.tsx` exporting `CardsListSection`, `AgentCardEditorSection`,
`ProjectionCenterSection`, `NamesBindingsSection`, `ReleasesAuditSection`, each taking `{ agent, cardId? }`
and doing its own `useServiceAgent`/org-equivalent lookup — thin route files in both `org/[org]/card/…` and
`service/[agent]/card/…` import from the same module. **Zero duplicated logic between org and service** — a
card resource belongs to the *agent*, not to which workspace kind it happens to be viewed from.

### 1.3 Deep links (for approval cards, inbox notifications, steward proposals)

Every action card and inbox event that names a card/projection/diagnostic must land the viewer exactly where
the thing is, scrolled and highlighted, never just "go look at the list":

| From | Deep link | Behavior on load |
| --- | --- | --- |
| Approval card (card release) | `…/<cardResourceId>/releases?release=<releaseId>` | Releases tab opens with that release's approval panel expanded |
| Approval card (projection publish) | `…/<cardResourceId>/projections?instance=<projectionInstanceId>` | Projections tab scrolls to and expands that row |
| Diagnostic ("fix" affordance) | `…/<cardResourceId>?diagnostic=<code>&pointer=<jsonPointer>` | Agent Card tab opens the owning section, scrolls to and focuses the field, diagnostics panel filters to that pointer |
| Stale-draft inbox event | `…/<cardResourceId>?stale=1` | Agent Card tab shows the "source changed" banner (§3.5) at top, pre-scrolled to nothing (banner is enough) |
| Steward proposal | `…/<cardResourceId>?proposal=<proposalId>` | Agent Card tab, inspector opens on the **Provenance** panel filtered to AI-proposed fields |
| Drift alert | `…/<cardResourceId>/projections?instance=<id>&drift=1` | Projections tab, that row's drift explanation expanded |

Query params are read once on mount and then cleared from the URL (replaceState) so a refresh doesn't
re-trigger the scroll/highlight on every reload.

---

## 2. The cards list (`…/card`)

### 2.1 Purpose
Show every card resource this agent has, its release/publication state at a glance, and get the steward into
the editor or into creating the first card. This is a management roster, not a dashboard — no charts, no
counts-of-counts.

### 2.2 Columns (`AgentCardSummaryRowV1`, `packages/home/src/agent-management/projection-center-manifest.ts`)

| Column | Source | Rendering |
| --- | --- | --- |
| Name / environment | `displayName`, `environment`, `primary` | Card name; small badge `Production` / `Staging` / `Development` (amber-tinted for staging/dev, sage outline for production — production reads as "real"); a ★ or "Primary" pill if `primary` |
| Draft state | `draftState` | `clean` → nothing shown; `dirty` → "Unsaved changes" (g500 text); `stale` → amber pill "Source changed"; `conflict` → danger pill "Conflict" |
| Latest release | `latestRelease` | `Card release <releaseNumber>` (never "Version <n>" — §7 labels) + state chip (`draft`/`validated`/`approvalPending`/`approved`/`signed`/`published`/`superseded`/`deprecated`/`revoked`) + two small lock icons: filled if `signed`, filled if `smartAgentBound` — hover reveals which is which |
| Publication | `publication` | If present: `uri` as a link + verification chip (`valid` sage / `invalid` danger / `unverified` g500 muted); absent → "Not published" |
| Projections | `projections` (`{total, published, drifted, stale}`) | `3 targets · 1 drifted · 1 stale` — drifted/stale counts only render when > 0, and are the only colored parts (danger/amber respectively) |
| Actions | `actions` (`edit|validate|test-interfaces|create-release|request-approval|sign|publish|deprecate|revoke`) | Row-level buttons scoped to what the viewer's entitlements allow **and** what the state machine allows right now — the row never shows "Sign" on a card that hasn't been approved yet, even to a signer |

### 2.3 States

- **Loading** — skeleton rows (3, matching `manage-card` skeleton pattern used elsewhere in the portal).
- **Empty (no card yet)** — see §2.4.
- **Populated** — table/list of `manage-card`-styled rows (reuse the existing card grid pattern from
  `ManagedAgents.tsx`, not a dense data table — this app's convention is card rows, not spreadsheets).
- **Error** (list fetch failed) — inline `manage-card-blurb` with retry: *"Couldn't load this agent's cards.
  Try again."*
- **Partial entitlement** — a steward with only `agent.card.read` sees the list and an editor in read-only
  mode (§3 inspector always visible, form controls disabled) — never a 403 page. Missing-scope actions are
  simply absent from the row, not shown-and-disabled (disabled-with-no-explanation reads as broken; absent
  reads as "not your job").

### 2.4 Empty state — "Create from profile"

No card resource exists yet. This is the most important empty state in the Studio because it is the one
place a steward decides *"yes, project this agent's identity as an A2A card."* The empty state must explain
**inheritance** before the button, so the first thing a steward creates isn't a blank form:

```
┌─────────────────────────────────────────────────────────────┐
│  🪪  This agent doesn't have an A2A card yet                  │
│                                                                │
│  A card is what other A2A agents see when they look this      │
│  agent up — its name, what it can do, and how to reach it.    │
│  It starts from what's already true about the agent: its      │
│  profile, its public capabilities, and how it's deployed.     │
│  You'll review and curate before anything is signed or        │
│  published — nothing here is public until you release it.     │
│                                                                │
│              [ Create from profile ]                          │
└─────────────────────────────────────────────────────────────┘
```

Primary action `Create from profile` → `card.create` → routes to `…/card/<newCardResourceId>` (Agent Card
tab), draft pre-populated with every inheritable field bound `mode: 'inherit'`. No network delay excuse for
skipping the busy state — this still shows `BusyButton busy busyLabel="Creating…"`.

Secondary, muted link below: *"Import an existing A2A card instead"* → opens the import flow (§ not detailed
here beyond: paste/upload → `agent.card.import` → import proposal, never a silent overwrite, per spec §7).

---

## 3. The editor (`…/card/<cardResourceId>`, tab: Agent Card)

### 3.1 Three-pane layout

```
┌───────────────┬─────────────────────────────────┬──────────────────────┐
│ Section nav    │ Form (active section's fields)   │ Inspector             │
│ (left, ~200px) │ (center, flexible)                │ (right, ~320px,       │
│                │                                    │  tabbed panels)       │
│ Identity &     │ [field rows for the active        │ [ Effective JSON ]    │
│  presentation  │  section only]                     │ [ Provenance ]        │
│ Interfaces     │                                    │ [ Validation ]        │
│ Capabilities   │                                    │ [ Projection impact ] │
│ Media types    │                                    │ [ Release diff ]      │
│ Security       │                                    │                       │
│ Skills         │                                    │  (panel content for   │
│ Signatures     │                                    │   whatever field is   │
│ Extended card  │                                    │   focused, or the     │
│  policies      │                                    │   whole card if none) │
└───────────────┴─────────────────────────────────┴──────────────────────┘
```

Section nav and inspector panel list are rendered **directly from `A2A_CARD_EDITOR_MANIFEST.sections`** and
`inspectorPanels` — the app never hardcodes a section list, so a manifest change (new section, reordered
fields) ships without a component edit. Section nav shows a small dot per section: gray (all inherited/clean),
amber (has an override or unresolved diagnostic), red (has an error-severity diagnostic) — so a steward scans
eight words and knows where to look.

Below 1024px viewport (SHIPPED as CSS in `app/globals.css`: `.studio-sections` / `.studio-section-list`):
section nav collapses to a horizontal scroll strip at top; the inspector stacks below the form (the per-row
"Details" bottom sheet is still open work). Above the panes sits an orientation block naming what the card is
for, where the draft stands, and the single next action — without it the page opens on a toolbar and eight
section names, which reads as a table of contents (same responsive pattern the portal already uses
for its dense settings pages).

### 3.2 Field row anatomy

Every row (rendered from `CardEditorFieldV1`) has the same skeleton regardless of `control` type:

```
┌────────────────────────────────────────────────────────────────────┐
│ Label                                    [badge] [source ↗]         │
│ help text, one line, muted                                          │
│ ┌───────────────────────────────────────────────────┐               │
│ │  <control>                                          │  [Restore]  │
│ └───────────────────────────────────────────────────┘               │
└────────────────────────────────────────────────────────────────────┘
```

- **Label** — exactly `CardEditorFieldV1.label`. Required fields get a small `*` after the label (never
  color-only — color-only required-marking fails a colorblind read).
- **Badge** — one `FieldBadge` chip, right-aligned next to the label, not floating in the control. Palette
  (all AA-contrast against `--color-surface`):
  | Badge | Chip style | Meaning |
  | --- | --- | --- |
  | `inherited` | `--c-g100` bg / `--c-g500` text | Comes from the profile/naming/catalog/runtime/claims — untouched |
  | `overridden` | `--c-primary-subtle` bg / `--c-primary` text | Was inherited, a human replaced it — a **recorded decision** |
  | `manual` | `--c-primary-subtle` bg / `--c-primary` text, outline instead of fill | Hand-authored, no inherited source exists for this field |
  | `computed` | `--c-g100` bg / `--c-g700` text, small ⚙ glyph | Derived by the runtime (e.g. `pushNotifications`) — not editable by typing |
  | `verified` | `--c-success-bg` bg / `--c-success` text, ✓ glyph | Runtime-tested and confirmed true (§4.4 runtime validation) |
  | `stale` | `--color-amber-100` bg / `--color-amber-700` text, ⚠ glyph | The inherited source changed since this field was last accepted |
  | `conflict` | `--c-danger-bg` bg / `--c-danger` text | Two sources disagree and neither is recorded as chosen (e.g. catalog divergence, §4.4 `CATALOG_DIVERGENCE`) |
  | `projection-only` | `--c-g100` bg / `--c-g500` text, italic label | Only meaningful to a specific projection target, not the base card |
- **Source link (`↗`)** — appears only on `inherited`/`stale`/`computed` badges; opens a small popover: *"From
  the canonical profile"* / *"From the surface catalog"* / *"From the runtime"* with a link to the owning
  surface (Profile tab, Records, etc.) when one exists. This is how a steward learns *why* a field says what
  it says without leaving the editor.
- **Restore inherited** — a text-button, right of the control, appears **only when `mode === 'override'`**.
  Click reverts the field to its current inherited value and flips the badge back to `inherited` — no
  confirmation dialog (this is reversible by re-overriding; it is not a value step that deserves a modal).
  Label is exactly `Restore inherited` (never "Reset" — "reset" doesn't say *to what*).
- **Help text** — exactly `CardEditorFieldV1.help`, always visible (not a tooltip-on-hover — hover text fails
  touch and fails discoverability; a steward should never have to hunt for why a field exists).

### 3.3 Control types

| `control` | Rendering | Notes |
| --- | --- | --- |
| `text` | Single-line input | — |
| `textarea` | Multi-line, auto-grow to ~6 lines then scroll | Description field |
| `url` | Text input with a small ↗ "open" affordance once non-empty, inline validation on blur (`URL_NOT_ABSOLUTE`/`URL_NOT_HTTPS` reflected immediately, not just at Validate time) | — |
| `tri-state-boolean` | Three-way segmented control: **Unset · No · Yes** (§3.4) | Never a checkbox |
| `string-list` | Chip-input (type + Enter adds a chip, × removes) | — |
| `mime-list` | Chip-input constrained to MIME shape, invalid entries shown in danger-outline chips inline (not deferred to Validate) | — |
| `interface-list` | Custom ordered-list editor (§3.5) | — |
| `security-scheme-map` | Custom one-of editor (§3.6) | — |
| `security-requirements` | Multi-select over the scheme names already declared in Security | Disabled with helper text if no schemes exist yet |
| `skill-list` | Custom curation picker (§3.7) | — |
| `extension-list` | Repeatable `{ uri }` row list | — |
| `readonly` | Plain text, muted background (`--c-g50`), no `Restore inherited` (nothing to restore, there's no editing) | Signatures, `extendedCardPolicies` summary, `protocolVersion` |

### 3.4 Tri-state booleans

An optional boolean (`streaming`, `pushNotifications`, `stateTransitionHistory`, `extendedAgentCard`) MUST
serialize `unset` differently from `explicit false` (`OptionalPresence<T>`, spec §4.1) — a segmented control,
not a checkbox, because a checkbox can only mean two things and this field means three:

```
  ○ Unset      ● No      ○ Yes
```

- **Unset** (default for a freshly inherited field with no runtime evidence either way) — the field is
  omitted from the released card entirely. Helper text under the control: *"Not declared — clients won't see
  this capability mentioned at all."*
- **No** — explicitly declares the capability absent. Helper text: *"Declared false — clients see this
  capability is NOT supported."*
- **Yes** — explicitly declares it present. For `pushNotifications` specifically, selecting Yes without
  runtime evidence does **not** block the control (a steward may be staging ahead of a runtime deploy) but
  immediately surfaces an inline evidence-needed note under the control (not just in the diagnostics panel):
  *"The runtime doesn't confirm this yet — this will show as `evidenceNeeded` until Test interfaces
  confirms it."* (see `CAPABILITY_UNVERIFIED`, §4.4).

### 3.5 Interfaces list — order + catalog divergence

`/supportedInterfaces` — **ordered, first = preferred** (spec §4.3/§4.4). Rendering:

```
┌───────────────────────────────────────────────────────────┐
│ ⠿  1  JSON-RPC   https://agent.example.com/api/a2a  Preferred│
│ ⠿  2  HTTP+JSON  https://agent.example.com/api/http           │
│                                                    [+ Add]     │
└───────────────────────────────────────────────────────────┘
```

- `⠿` is a drag handle (keyboard-operable — see §11); dragging reorders, and only the row landing at index 0
  carries the **Preferred** pill. There is no separate "set as preferred" button — position *is* the
  semantic, and a second control that duplicated it would drift from the actual card content.
- Each row shows binding type (`JSONRPC`/`GRPC`/`HTTP+JSON`), the URL, and — when this row's URL+binding pair
  is **not** present in the surface catalog and carries no `override` binding — a danger-outline left border
  plus an inline note: *"Not served by this deployment — add an override to keep it, or remove it."* This is
  the `CATALOG_DIVERGENCE` diagnostic surfaced at the field, not just in the panel (§4.4).
- Catalog interfaces **missing** from the card render as a ghost row at the bottom, dashed border: *"catalog
  interface JSON-RPC …/api/a2a isn't on this card"* with a one-click **Add** action — this is how a steward
  notices a deployment shipped a new endpoint the card hasn't caught up to.
- `+ Add` opens a small form: URL, protocol binding (select), optional tenant. New rows are `mode: 'manual'`
  or `mode: 'override'` depending on whether they replace an inherited row.

### 3.6 Security schemes — one-of editor

`/securitySchemes` is a map of name → scheme, and **each scheme is exactly one type** (`apiKey | http |
oauth2 | openIdConnect | mutualTLS`) — spec §4.1 and `validateScheme` in `agent-profile/src/a2a/validation.ts`
reject any scheme carrying fields from a foreign type (`SECURITY_SCHEME_INVALID`). The editor enforces this
structurally so the error can't happen:

```
┌───────────────────────────────────────────────────┐
│ Scheme name: [ bearer-jwt        ]                  │
│ Type:        ( ) API key  (●) HTTP  ( ) OAuth 2.0    │
│              ( ) OpenID Connect  ( ) Mutual TLS       │
│  ── only HTTP's fields render below ──                │
│ Scheme:      [ Bearer            ]                    │
│ Bearer format (optional): [ JWT  ]                     │
│                                        [ Remove ]        │
└───────────────────────────────────────────────────┘
```

Picking a type **swaps the field set below the radio row** rather than showing all five types' fields with
the wrong ones grayed out — a grayed-out irrelevant field invites "maybe I should fill this in anyway." A
scheme never displays a secret value: `apiKey`/`http`/`oauth2` fields here are metadata (name, location,
scheme, flows, URLs) never a live key. Helper copy at the top of the section, permanent: *"Never a secret.
These describe how a client authenticates — not the credential itself."*

`securityRequirements` (a separate field, control `security-requirements`) references scheme **names**
declared above via multi-select chips; if a requirement references a name that isn't declared
(`SECURITY_REF_UNRESOLVED`), that chip renders in danger-outline with a small ✕ suggesting removal, plus the
diagnostic in the panel.

### 3.7 Skills — curated, never dumped

`/skills` is explicitly **"curated from PUBLIC capability claims and the surface catalog — never every
claim"** (manifest help text, §5 of spec). The editor must make the curation act visible and cheap, and must
make "everything got published" structurally impossible:

```
┌────────────────────────────────────────────────────────────┐
│  On this card (2)                                             │
│  ┌───────────────────────────────────────────┐                │
│  │ ✓ summarize-transactions   [catalog]  [×]  │                │
│  │ ✓ draft-approval-request   [claim]    [×]  │                │
│  └───────────────────────────────────────────┘                │
│                                                                 │
│  Add from your public capabilities            [ + Add skill ]  │
└────────────────────────────────────────────────────────────┘
```

- `+ Add skill` opens a picker listing **only** `selectPublicSkillClaims` output (visibility `public` /
  `public-coarse`) plus catalog-served skills not yet added — never the full claim list. The picker groups by
  source (`From the surface catalog` / `From your public capability claims`) and shows each candidate's
  taxonomy mapping confidence if one exists (`exact`/`close`/`broad`/`narrow` — a small text label, not a
  score bar, since these are qualitative SKOS relations, not a percentage).
- A claim with visibility `private`/`org-only` **never appears in this picker at all** — not grayed out, not
  present-but-disabled. The absence itself is the privacy boundary; a disabled row that explains "this is
  private" would still leak that the claim exists.
- Removing a skill (`×`) is a soft removal — it un-adds it from the card, it does not touch the underlying
  capability claim. Helper text at the top of the section, permanent: *"Only what's checked here appears on
  your public card. Your other capabilities stay private."*
- A skill row's `[catalog]`/`[claim]` tag is its `FieldBinding.source.kind`, shown as a small muted tag, not a
  full badge — it's provenance detail, not a state that needs attention.

---

## 4. Inspector panels

Rendered from `inspectorPanels: ['effective-json', 'provenance', 'validation', 'projection-impact',
'release-diff']` — a tab strip at the top of the inspector pane, always in that order.

### 4.1 Effective JSON
The card as it would be released **right now** — pretty-printed, syntax-highlighted, read-only, with a
`Copy` button. This is the "what actually gets signed" view; it exists so a steward never has to trust the
form's summary of itself. Unset optional booleans are shown *omitted* (not `null`), matching
`OptionalPresence` semantics exactly — this view is the honesty check for that whole mechanism.

### 4.2 Provenance
One row per effective field, grouped by badge (Inherited / Overridden / Manual / Computed / Verified / Stale
/ Conflict / Projection-only — same colors as §3.2). Clicking a row scrolls the form to that field. This
panel is also where **steward (AI) proposals** render when present (§7) — each proposed field shows value,
source, explanation, confidence, evidence refs, privacy class, and Accept/Reject inline, ahead of the
regular provenance rows, in its own "Proposed by your Metadata Steward" sub-group with a small bot glyph.

### 4.3 Validation
Diagnostics grouped by severity, in this fixed order (§5 below has the full copy table):
1. **Errors** — block release creation.
2. **Evidence needed** — its own group, never folded into warnings (per spec: `evidenceNeeded` is a distinct
   severity). Each item explains what evidence is missing and offers **Test interfaces** where applicable.
3. **Warnings** — don't block, but shown before info.
4. **Info** — lowest priority, collapsed by default if the list is long (>5 total diagnostics).

Each diagnostic row: code (small mono badge, e.g. `CATALOG_DIVERGENCE`), message, optional explanation
(expandable "why"), and a **Fix** affordance when `suggestedFix` is present — button label taken from
`suggestedFix.kind`: `manual` → `Go to field` (scrolls/focuses), `automatic` → the specific action (e.g.
`Match the catalog`), `approvalRequired` → the specific action with a small lock glyph (e.g. `Keep as
override` — clicking still requires the normal approval step later, this doesn't skip it, it just names the
destination).

### 4.4 Projection impact
*"If you release this card as-is, here's what happens to your existing projections."* One row per configured
projection instance: `current` (no change) shown muted/collapsed by default; anything else (`source-stale`,
etc.) expanded with the plain-language drift label (§6.3) and a link into the Projections tab for that row.
This is what lets a steward catch "releasing this will make my AP Registry entry stale" *before* they commit
to the release, not after.

### 4.5 Release diff
Empty state when there's no prior release: *"This will be the first release."* Otherwise: a field-level diff
against the current `latestRelease`'s effective JSON — added (sage left-border), removed (danger, struck),
changed (amber, old→new). This is the same diff shown again, unchanged, at the "Create release" confirmation
step (§6) — the inspector view lets a steward check it continuously while editing, not just at the end.

---

## 5. Diagnostics — code → message → fix (developer + copy reference)

Source: `packages/agent-profile/src/a2a/validation.ts` `DIAGNOSTIC_CODES`. UI-facing copy layer — the raw
`message`/`explanation` strings from the validator are technically correct but written for a diagnostics
consumer, not a steward; the app should prefer this table's **Steward-facing copy** where it differs, and
fall back to the validator's own `message` for anything not in the table (forward-compatible with new codes).

| Code | Severity | Steward-facing copy | Fix affordance |
| --- | --- | --- | --- |
| `STRUCT_MISSING_FIELD` | error | "{Field} is required." | Go to field |
| `STRUCT_INVALID_TYPE` | error | "{Field} isn't in the right format." | Go to field |
| `PROTOCOL_VERSION_MISMATCH` | error | "This draft was started under an older A2A protocol version." | Automatic — Sync to pinned version |
| `URL_NOT_ABSOLUTE` | error | "This needs a full URL, starting with https://." | Go to field |
| `URL_NOT_HTTPS` | error (prod) / warning (staging/dev) | "Production cards must use https." | Go to field |
| `MIME_TYPE_INVALID` | error | "\"{value}\" isn't a recognized media type." | Go to field |
| `SKILL_ID_DUPLICATE` | error | "Two skills share the id \"{id}\" — ids must be unique." | Go to field |
| `SECURITY_SCHEME_INVALID` | error | "This security scheme is missing something \"{type}\" requires." | Go to field |
| `SECURITY_REF_UNRESOLVED` | error | "This requirement refers to a scheme that isn't declared." | Go to field |
| `EXTENSION_URI_INVALID` | error | "Extension URI must be a full, absolute URI." | Go to field |
| `CANONICALIZATION_FAILED` / `JCS_NOT_REPRODUCIBLE` | error | "Something in this draft can't be prepared for signing." | Contact support (include revision id) |
| `NO_INTERFACE` | error | "This card needs at least one way to reach the agent." | Go to Interfaces — Add |
| `INTERFACE_BINDING_UNKNOWN` | warning | "\"{binding}\" isn't a standard A2A binding — some clients may not recognize it." | Go to field |
| `EXTENDED_CARD_WITHOUT_POLICY` | error | "Extended agent card is on, but no audience policy is configured." | Approval required — Add audience policy, or Automatic — Turn off Extended agent card |
| `CAPABILITY_UNVERIFIED` | **evidenceNeeded** | "{Capability} is claimed, but the running agent hasn't confirmed it yet." | Automatic — Test interfaces |
| `VERSION_EQUALS_PROTOCOL_VERSION` | error | "Agent implementation version matches the A2A protocol version — that's almost always a copy-paste mistake." | Go to field |
| `PROVIDER_MISSING` | warning | "No provider is declared — other agents won't know who operates this one." | Go to field |
| `CATALOG_DIVERGENCE` | error | "This doesn't match what the agent actually serves." | Automatic — Match the catalog, or Approval required — Keep as override |
| `SECRET_MATERIAL_DETECTED` | error | "This looks like a key, token, or secret — it must never appear on a public card." | Go to field — remove it |
| `PRIVATE_URL_DETECTED` | error (prod) / warning | "This points at a private or internal address — external clients can't reach it." | Go to field |
| `VAULT_REFERENCE_DETECTED` | error | "This points into a private vault record — vault contents are never public." | Go to field — remove it |
| `PII_SUSPECTED` | warning | "This looks like it might contain personal information." | Go to field — review |
| `UNKNOWN_FIELD` (import) | info | "This field isn't part of the A2A card model — kept for reference, not published." | none |
| `SIGNATURE_INVALID` / `SIGNATURE_UNVERIFIED` (import) | error / warning | "The signature on the imported card {doesn't verify / couldn't be checked}." | none — informational |
| `SOURCE_NOT_JSON` (import) | error | "That file isn't valid JSON." | Go to import — try again |

Rule for the panel: **never show a bare code to a steward.** The mono code badge is there for support/dev
correlation, but the sentence next to it is always the steward-facing copy above (or the validator's raw
message as fallback for unmapped codes — never a blank).

---

## 6. Release flow

### 6.1 Stepper

`draft → validated → approvalPending → approved → signed → published` (plus terminal `superseded /
deprecated / revoked`, spec §3). Rendered as a horizontal stepper at the top of the **Releases & Audit** tab
when a release is in progress, collapsing to a single status line once `published`:

```
●───────●───────○───────○───────○───────○
Draft  Validated Approval Approved Signed Published
       (you)     pending           
```

Each step node shows: state (filled = done, ring = current, empty = not yet), **who did it** (name + duty
badge, e.g. "Approved by Priya · approver"), and a timestamp. A step the current viewer cannot perform (wrong
duty) still shows its position but its action button is absent, replaced by muted text: *"Waiting on
someone with approve access."* This is the separation-of-duties model made visible, not just enforced
server-side (`permissions.ts` `dutiesOf`/`separationOfDutiesFindings`).

| Step | Action | Who (duty, `permissions.ts`) | What happens |
| --- | --- | --- | --- |
| 1. Validate | `Validate` button | editor (`agent.card.validate`) | Runs pure validation (§4.4); no network, instant; populates the Validation inspector panel |
| 2. Create release | `Create release` button | editor (`agent.card.draft`) — creating a release from a validated, error-free draft | Snapshots the draft into an immutable `A2AAgentCardReleaseV1`, computes `unsignedContentDigest`; **shows the Release diff (§4.5) as a confirmation step**, not a silent action |
| 3. Request approval | `Request approval` button | editor | Mints the render-half `StudioApprovalCardV1` (`action-cards.ts`) naming the **exact digest** — this card is what the approver sees |
| 4. Approve | `Approve` / `Reject` | approver (`agent.card.approve`) | The approval card renders the digest, planned scope, and (for high-risk actions, §6.4) spend/target — approver reviews *this specific release*, not "the card" abstractly |
| 5. Sign | `Sign` (two sub-steps, §6.2) | signer (`agent.card.sign`) | Standard A2A JWS, then Smart Agent binding |
| 6. Publish | `Publish` | publisher (`agent.card.publish`) | A2A well-known publication (§8.1 of spec) — always the first publish target; registry/naming projections are separate publishes from the Projections tab, not bundled here |
| 7. Verify | automatic, no button | — | Publisher re-fetches `/.well-known/agent-card.json` and compares digests; result renders as a final stepper node, "Live · verified" (sage) or "Published, not yet verified" (amber) if the re-fetch hasn't landed |

An edit at `approved` or later **creates a new draft** (spec §3) — the UI never lets a steward "just fix
one thing" on an approved/signed/published release. Clicking any field-level edit control on a
`>= approved` release routes through a confirmation: *"This release is already {approved/signed/published}.
Editing starts a new draft — the current release stays exactly as it is."* → `[ Start new draft ]` /
`[ Cancel ]`.

### 6.2 The two signatures — explained plainly

This is the single most important piece of copy in the Studio, because "why do I have to sign twice" is the
question that erodes trust in a consent flow if left unanswered. Sign step UI:

```
┌──────────────────────────────────────────────────────────────┐
│  Sign this release                                              │
│                                                                   │
│  ① Card signature — proves nobody tampered with it                │
│     Any A2A client can check this. Required for every card.       │
│     [ Sign card ]                                                 │
│                                                                   │
│  ② Smart Agent binding — proves YOUR agent authorized it           │
│     Only needed by verifiers that check Agentic Primitives         │
│     identity — most A2A clients skip this and are still fine.      │
│     [ Bind to Smart Agent ]  (enabled after ①)                     │
└──────────────────────────────────────────────────────────────┘
```

- **① Card signature** — standard A2A JWS (ES256) over the RFC 8785 canonical bytes. Signed with a
  delegated card-signing key (`CardSigningKeyAuthorizationV1`), not the SA custodian directly — so this can
  be a fast, low-ceremony signature (a KMS-backed signer with no device prompt, when the org has one
  configured) or a device prompt if the signing key is a passkey-backed one. Copy stays the same either way;
  `BusyButton` step-naming shows `"Signing…"`.
- **② Smart Agent binding** — EIP-712 typed-data signature by the SA custodian (passkey/wallet/KMS), verified
  on read via ERC-1271. This **is** a genuinely distinct consent boundary (a different signer, a different
  cryptographic claim — "my Smart Agent specifically authorized this exact release") so it is **not**
  collapsed into step ① even under the "value steps ≠ signatures" rule; that rule says don't multiply
  prompts for the *same* decision, and these are two different decisions by two different keys. `BusyButton`
  step-naming: `"Binding to your Smart Agent…"`.
- If the org's delegated signing key **is** the SA custodian itself (small orgs, no separate signing key
  configured), the UI still shows both steps and both prompts — do not special-case this into one click. The
  distinction is what's being attested, not who holds the key.
- After both: a small inline confirmation, permanent once signed (not a toast that disappears): *"Signed ✓ ·
  card signature + Smart Agent binding · {timestamp}"*.

### 6.3 Publish → verify

`Publish` is scoped to the A2A well-known target specifically (§8.1 of spec — "not a registry projection").
Button copy: `Publish to your agent's endpoint`. On success, the UI does **not** claim success until the
verify re-fetch completes — `BusyButton` stays busy through both the publish call and the verification
re-fetch, step label transitions `"Publishing…"` → `"Verifying…"`. Final state:
- **Verified** (digest matches) — sage confirmation banner: *"Live and verified — this is the card your
  agent's endpoint is actually serving."*
- **Published, verification failed** — amber banner, not danger (the publish itself succeeded; only the
  live-truth check didn't confirm yet): *"Published, but we couldn't confirm your agent's endpoint is serving
  it yet. This usually resolves within a minute — [Check again]."*

### 6.4 High-risk actions require an explicit approval

Per `permissions.ts` `APPROVAL_REQUIRED_ACTIONS`: registry registration, registry spend, DNS updates,
certificate requests, name transfer, binding revocation, public skill disclosure, a **new production card**,
provider change, ownership change. Any Studio action in this list — even ones that aren't part of the core
release stepper (e.g. creating a second **production**-environment card) — routes through the same
`StudioApprovalCardV1` pattern before it can execute, never a same-click confirm dialog. The approval card
always names the exact digest/plan (`approvalCoversSubject` is fail-closed on digest mismatch) — if the
underlying draft changes after an approval was requested, the stale approval simply doesn't cover the new
digest and the UI shows *"This release changed since approval was requested — request approval again."*
rather than silently reusing a stale approval.

---

## 7. Steward (AI) proposals

The Agent Metadata Steward (service agent) may draft, validate, preview, and explain — never sign, publish,
transact, or mark verified (`STEWARD_FORBIDDEN_SCOPES`). Every field it proposes is a **suggestion**, never a
silent edit to the draft:

```
┌────────────────────────────────────────────────────────────────┐
│  🤖  Proposed by your Metadata Steward                           │
│                                                                    │
│  /description                                                     │
│  "Handles vendor payment approvals and posts a receipt to your     │
│   org's ledger channel."                                           │
│                                                                    │
│  Why: derived from this agent's 12 most recent completed skill     │
│  runs and its capability claims.               Confidence: high    │
│  Evidence: 3 interaction records, 1 capability claim                │
│  Privacy class: public                                              │
│                                                                    │
│                        [ Accept ]      [ Reject ]                    │
└────────────────────────────────────────────────────────────────┘
```

- Rendered in the **Provenance** inspector panel (§4.2), grouped ahead of the regular field rows, and also as
  an inline banner on the specific field row in the form itself (so a steward reviewing a field sees the
  proposal right there, not just in a side panel).
- **Accept** applies the value with `mode: 'manual'` (or `override` if it replaces an inherited value) and
  records the steward's proposal as the field's evidence — the human's acceptance click is the actual
  authorship event, the AI's draft is the input.
- **Reject** discards it and dismisses the banner; a rejected proposal does not repeat itself on the same
  field within the same draft session (avoid nag).
- A confidence label is **qualitative** (`low`/`medium`/`high`), never a fabricated percentage — the steward
  is not scored to two decimal places on a judgment call.
- Privacy class (`public`/`audience`/`never-public`) uses the same three-tier vocabulary as
  `CardEditorFieldV1.privacyClass`; a proposal marked `never-public` targeting a public-card field is a
  contradiction the UI refuses to render as an acceptable proposal — it shows as rejected-by-default with an
  explanation: *"Your Metadata Steward flagged this as private — it won't propose it for a public card."*
- If the steward proposes something outside its allowed scopes (should never happen server-side per
  `stewardScopeViolations`, but the UI defends anyway) — the proposal simply does not render. No error toast
  naming the violation; a proposal that shouldn't exist doesn't need an incident banner, it needs to be
  absent.

---

## 8. Projections tab (`…/card/<cardResourceId>/projections`)

### 8.1 Purpose
One row per configured projection target (AP Registry, AP Naming today; external adapters land in W5+).
This is where a steward sees "did my card release actually make it out to the places that should know about
it," and where drift against the live remote gets surfaced as something to *review*, never something that
silently rewrites the canonical card.

### 8.2 Row anatomy (`ProjectionCenterRowV1`)

```
┌─────────────────────────────────────────────────────────────────┐
│ AP Registry                                    [ Published · sage ]│
│ target spec: ap-registry · adapter v1.2.0                          │
│ from card release 4 · source bundle a1b2…                          │
│                                                                      │
│ Losses: 1 approximate mapping                          [ Review ]   │
│ ────────────────────────────────────────────────────────────────  │
│                                     [ Preview ]  [ Publish update ]  │
└─────────────────────────────────────────────────────────────────┘
```

- Header: definition `displayName` + state chip (`unconfigured`→muted, `configured`/`ready`/`generated`→g500,
  `approvalPending`→amber, `publishing`→amber + spinner, `published`→sage, `drifted`/`failed`→danger,
  `stale`→amber, `retired`→g500 struck).
- Second line: `VERSION_LABELS.targetSpecification` + `VERSION_LABELS.adapterVersion`, always those exact
  labels — never "spec version" or "adapter" alone.
- Third line: which card release/source bundle this projection was generated from — a steward can see at a
  glance whether the registry entry reflects the *current* release or an older one.
- **Losses** — count + severity-colored chip; `[Review]` expands the full loss list inline: category
  (`unsupported`/`truncated`/`approximateMapping`/`omittedByPolicy`/`targetDefault`/`manualActionRequired`),
  plain-language explanation (§8.4). A projection with **zero** losses shows nothing in this slot — an empty
  loss list is good news and shouldn't take up a line.
- **Required actions** — if non-empty, rendered as a small checklist above the action buttons (e.g. "Domain
  verification required" for ERC-8004/ANS-family targets, once those land).
- **Binding** (when present) — external id + verification state, shown as a small chip next to the target
  name: `active` sage, `pendingVerification` amber, `stale`/`suspended` amber, `revoked`/`superseded` g500
  struck.
- **Action buttons** — exactly `row.actions`, entitlement-and-state-gated same as the cards list.

### 8.3 Drift / stale display

`DriftLabel` → plain language, always paired with *what to do about it*, never just a status word:

| `DriftLabel` | Chip | Plain-language line |
| --- | --- | --- |
| `current` | sage, muted (not alarming — this is the good state) | "Matches what's published." |
| `source-stale` | amber | "Your card changed since this was last published — republish to catch it up." → `[ Publish update ]` |
| `adapter-stale` | amber | "The projection adapter was updated — this should be regenerated." → `[ Regenerate ]` |
| `remote-drift` | danger | "Something out there doesn't match what we published — someone or something changed it directly." → `[ Review remote change ]` |
| `remote-unavailable` | g500 | "Couldn't check the live registry entry right now." → `[ Try again ]` |
| `binding-failed` | danger | "The binding to this external identity couldn't be verified." → `[ Review ]` |
| `publication-superseded` | g500 struck | "This publication was replaced by a newer one." | (no action — informational) |
| `target-upgraded` | amber | "The target's standard was updated — this projection needs review before it's trusted again." → `[ Review ]` |

`remote-drift` is the one that most needs restraint: the UI **never** offers a one-click "overwrite the
remote to match us" — a remote change produces an **import proposal** (spec §6.4), reviewed exactly like a
steward proposal (§7), because the remote content might be correct and the canonical side stale, not the
other way round.

### 8.4 Loss report language

A loss is not an error — it's an honest disclosure that the target format couldn't carry everything. Each
loss line in the `[Review]` expansion:

```
  ⚠ Approximate mapping · skills/summarize-transactions
    This skill was mapped to the closest matching category in AP
    Registry's taxonomy — the specific wording didn't carry over
    exactly.
```

Category → lead word (never the raw enum): `unsupported` → *"Not supported"*, `truncated` → *"Shortened"*,
`approximateMapping` → *"Approximate mapping"*, `omittedByPolicy` → *"Left out by policy"*, `targetDefault` →
*"Used the target's default"*, `manualActionRequired` → *"Needs your attention"* (this one always paired with
an action, never left as a flat statement).

### 8.5 Plan review before approval

`Preview` runs the pure projector (no side effects, no network per spec §6.3) and shows the artifact +
losses + diagnostics — safe to click anytime, any duty. `Publish update` (or first `Configure` → `Preview` →
`Request approval` → `Publish` for a new projection) walks through a **plan review** step before minting the
approval card:

```
┌──────────────────────────────────────────────────────────┐
│  Review before requesting approval                          │
│                                                                │
│  Target: AP Registry                                          │
│  Operations:                                                  │
│    · Register card digest                                     │
│    · Update registry entry metadata                            │
│  Estimated cost: ~0.0004 ETH (gas)                              │
│  Gas ceiling: 0.001 ETH                     ← from the plan     │
│  Credential: registry-signer (KMS-backed)                        │
│  Expires: this plan is valid for 15 minutes                       │
│                                                                │
│              [ Request approval ]      [ Cancel ]                 │
└──────────────────────────────────────────────────────────┘
```

Every field here is drawn straight from `PublicationPlanV1` (`operations[]`, `estimatedCost`, the entitlement
layer's spend ceiling) — the UI composes nothing new, it only formats what the plan already says. This is the
disclosure moment for a spend-bearing action: **what**, **how much**, **who's credential**, **how long the
plan is good for** — before a single approval or signature exists.

### 8.6 "Execute with your custodian"

The final `Publish` click on an approved plan is where an on-chain transaction actually happens. Copy is
explicit that this is the moment device confirmation appears:

```
[ Execute with your custodian ]
"This sends the transaction using your Smart Agent's signer — you'll
 confirm it on your device."
```

`BusyButton` step sequence: `"Preparing transaction…"` → `"Waiting for your confirmation…"` → `"Publishing…"`
→ `"Verifying…"`. If the org has multiple projections ready to publish in the same session (e.g. both AP
Registry and AP Naming after one card release), the UI offers a **batched** publish per the "value steps ≠
signatures" rule and the repo's one-prompt precedent (spec 253): *"Publish both now — one confirmation"* when
both plans share the same credential/signer, falling back to two separate flows only when they don't.

---

## 9. Names & Bindings tab (`…/card/<cardResourceId>/names`)

Per spec §8.3: *"the Naming UI distinguishes ownership / resolution / canonical identity / current card
publication / registry binding."* This tab exists specifically to keep those five things from blurring into
one "your agent's name" line, because they answer different questions and can legitimately disagree
(e.g. name resolves, but the card it points at is stale):

```
┌────────────────────────────────────────────────────────────┐
│ Ownership                                                     │
│  This name is owned by: 0xAbC…1234 (this agent)                │
│                                                                │
│ Resolution                                                    │
│  vendor-payments.impact  →  0xAbC…1234                          │
│  Anyone can look this name up and get this address.              │
│                                                                │
│ Canonical identity                                              │
│  0xAbC…1234  (the Smart Agent — this never changes)               │
│                                                                    │
│ Current card publication                                           │
│  Card release 4 · sha256:9f2a… · published at                       │
│  https://vendor-payments.impact/.well-known/agent-card.json           │
│  atl:cardDigest on this name record: sha256:9f2a…  ✓ matches            │
│                                                                          │
│ Registry binding                                                          │
│  AP Registry entry #4471 · active                                          │
└────────────────────────────────────────────────────────────┘
```

- **Ownership** — who controls the name record (the SA itself, in every case this tab is reachable from).
- **Resolution** — the public name→address mapping anyone can query; a plain statement, not a control (this
  tab doesn't let you *change* resolution, that's the Naming surface elsewhere).
- **Canonical identity** — the SA address, framed as the one thing that never rotates (ADR-0010), sitting
  between resolution and publication so a steward sees the anchor point.
- **Current card publication** — the released card this name currently points at, with the **digest
  comparison spelled out**: if the name record's `atl:cardDigest` matches the current release's digest, a
  small sage "✓ matches"; if it doesn't (the name wasn't updated after the last release), amber "doesn't
  match the latest release yet" with a `[ Update name record ]` action (routes to `agent.naming.update`,
  itself an approval-required, publisher-duty action).
- **Registry binding** — the `ExternalIdentityBindingV1` for `ap-registry`, if any, with its verification
  state chip (same vocabulary as §8.2).

Empty/partial states: a name that resolves but has never had `atl:cardDigest` set shows *"No card is linked
to this name yet"* with a link to the Agent Card tab's Publish step, not an error — this is a valid, common
pre-card state.

---

## 10. Component inventory

| Component | New / existing | Notes |
| --- | --- | --- |
| `src/components/portal/agent-cards/CardsListSection.tsx` | New | List route body; reuses `manage-card`/`manage-grid` CSS classes from `ManagedAgents.tsx` |
| `src/components/portal/agent-cards/AgentCardEditorSection.tsx` | New | Three-pane editor shell, renders `A2A_CARD_EDITOR_MANIFEST` |
| `src/components/portal/agent-cards/SectionNav.tsx` | New | Left pane, manifest-driven, status dots |
| `src/components/portal/agent-cards/fields/*` | New | One renderer per `FieldControl` value (§3.3) — `TextField`, `TriStateBooleanField`, `InterfaceListField`, `SecuritySchemeMapField`, `SkillListField`, etc. |
| `src/components/portal/agent-cards/FieldBadge.tsx` | New | Renders one `FieldBadge`, shared palette (§3.2) |
| `src/components/portal/agent-cards/Inspector.tsx` | New | Tab strip + panel router over `inspectorPanels` |
| `src/components/portal/agent-cards/ProvenancePanel.tsx` | New | Includes steward-proposal sub-group (§7) |
| `src/components/portal/agent-cards/ValidationPanel.tsx` | New | Severity-grouped diagnostics, copy table from §5 |
| `src/components/portal/agent-cards/ProjectionImpactPanel.tsx` | New | |
| `src/components/portal/agent-cards/ReleaseDiffPanel.tsx` | New | Shared by inspector and the release-creation confirm step |
| `src/components/portal/agent-cards/ReleaseStepper.tsx` | New | §6.1 — no existing stepper component in this app to reuse |
| `src/components/portal/agent-cards/SignReleasePanel.tsx` | New | §6.2 two-signature explainer |
| `src/components/portal/agent-cards/ProjectionCenterSection.tsx` | New | Projections tab body, renders `ProjectionCenterRowV1[]` |
| `src/components/portal/agent-cards/PublicationPlanReview.tsx` | New | §8.5 |
| `src/components/portal/agent-cards/NamesBindingsSection.tsx` | New | §9 |
| `src/components/portal/agent-cards/ReleasesAuditSection.tsx` | New | Wraps `ReleaseStepper` + a chronological audit list (`agent.card.*`/`agent.projection.*` events) |
| `src/components/shared/BusyButton.tsx` | Existing | Every network/signing action in this surface uses it — no exceptions |
| `src/components/portal/SectionShell.tsx` | Existing | Page header wrapper, `title` + `actions` |
| `manage-card` / `manage-grid` CSS (`app/globals.css`) | Existing | Cards-list styling base |
| `src/components/portal/OrgDetail.tsx` `DelegationCard` | Existing (reference) | Pattern reference for how this app already renders a scoped authority object — Approval cards in §6 borrow its visual language (title, subject, scope, expiry, revoke) |
| `src/components/shared/Icons.tsx` | Extend | Add `IdCardIcon` (nav) following the `Svg` wrapper convention; reuse `GlobeIcon` for external projection targets, `LinkIcon` for bindings, `ShieldIcon` for security scheme section header, `CheckCircleIcon`/`XIcon` for accept/reject |
| `src/components/portal/nav.ts` | Extend | Add `org-card`/`service-card` items to both Manage bands (§1.1) |
| `src/lib/workspace.ts` | Extend | No change needed — `orgHref`/`serviceHref` already take an arbitrary `page` string |
| `packages/home/src/agent-management/*` | Existing (portable) | Every list/row/badge/scope shape in this doc comes from here — the app renders, it does not invent shapes |

State/data-fetching pattern mirrors `useManagedAgents`/`useServiceAgent`: a `useCardResources(agent, token)`
hook and a `useCardResource(agent, cardId, token)` hook, both re-reading on the same `AGENTS_CHANGED_EVENT`
window-event bus used elsewhere, plus a new `ap:card-changed` event fired after any release/publish mutation
so the list, editor, and any open approval card all reflect a change without a full page reload.

---

## 11. Accessibility notes

- **Contrast** — every badge/chip pairing in §3.2/§8.2/§8.3 uses tokens already verified against
  `--color-surface` in this app's palette (amber-700 on amber-50, sage-700 on sage-50, danger on
  danger-subtle all clear 4.5:1 for text). No new color is introduced without checking against both the
  `-50` (bg) and plain (text) pairing.
- **Never color-only** — every state above pairs color with a glyph or word (✓/⚠/✕, "Published"/"Drifted",
  required `*`, not a colored dot alone). The section-nav status dots (§3.1) are the one purely-color signal
  in this design; each dot's `title` attribute and an `aria-label` on the nav item spell out the state in
  words ("Interfaces — 1 error") for screen readers and colorblind users alike.
- **Focus order** — three-pane layout: tab into section nav → active section's fields top-to-bottom → inspector
  panel tabs → active panel content. The inspector's field-click-to-scroll (§4.2 Provenance) also moves focus
  to the target field, not just the viewport, so a keyboard/screen-reader user gets the same jump a mouse
  user does.
- **Drag-and-drop interfaces list (§3.5)** — MUST have a full keyboard equivalent: focus a row, `Alt+↑`/`Alt+↓`
  (or a visible "Move up"/"Move down" icon-button pair shown on focus, not hover-only) reorders it. Drag alone
  is never the only way to reach "first = preferred."
- **Tri-state boolean (§3.4)** — implemented as a radio group (`role="radiogroup"`, one `radio` per state),
  never three separate buttons with ad hoc `aria-pressed` — a radio group gets arrow-key navigation and
  correct SR announcement ("Push notifications, No, 1 of 3") for free.
- **Target size** — every actionable control (chip ×, drag handle, Restore inherited, row action buttons)
  meets 44×44px touch target on the mobile/tablet breakpoint, per the portal's existing standard; on desktop
  visual size may be smaller but the hit area is padded to the same minimum.
- **Busy state announcements** — `BusyButton`'s `aria-busy` is already wired; the multi-step sequences in §6.2
  and §8.6 additionally need a visually-hidden `aria-live="polite"` region announcing each step transition
  ("Signing…" → "Binding to your Smart Agent…") so a screen-reader user gets the same progress narration a
  sighted user reads off the button label.
- **Diagnostics panel** — grouped headings (`<h3>Errors</h3>`, `<h3>Evidence needed</h3>`, etc.) are real
  headings, not styled `<div>`s, so a screen-reader user can navigate the panel by heading exactly like the
  visual scan a sighted steward does.
- **Reduced motion** — the stepper's step-completion transition and the section-nav dot color change both
  respect `prefers-reduced-motion` (instant state change, no slide/fade), per this app's existing motion
  convention.

---

## 12. Edge cases & risks

- **Approving a release, then the draft changes before signing** — the approval card's digest no longer
  matches; §6.4 already specifies fail-closed behavior (`approvalCoversSubject`) and the UI copy for it.
- **Two stewards editing the same draft** — the manifest's `A2AAgentCardDraftV1` carries `etag`/`revision`
  for optimistic concurrency (ADR-0055). A save conflict shows the same "someone else changed this" pattern
  as Field's other optimistic-concurrency surfaces: *"This draft changed while you were editing — [Review
  their changes] [Overwrite with mine]"* — never a silent last-write-wins.
- **Runtime validator (SSRF-safe egress) times out or the target host is unreachable** — `Test interfaces`
  (§3.4, §4.3) fails gracefully: *"Couldn't reach your agent's endpoint to confirm this — try again once
  it's deployed."* Never blocks the rest of validation; runtime checks are additive evidence, not a gate on
  structural/semantic validation.
- **A card whose `supportedInterfaces` diverges from the catalog because the deployment is mid-migration** —
  this is a legitimate temporary state, not always an error to fix immediately; the `CATALOG_DIVERGENCE`
  fix offers **Keep as override** (approval-required) precisely so a steward can record "yes, this is
  deliberate, here's who signed off," rather than the tool forcing an immediate revert.
- **Publishing to AP Naming when the name record already carries a different `atl:cardDigest` from a
  concurrent process** (e.g. someone updated naming directly outside the Studio) — treated as
  `remote-drift` (§8.3): import proposal, never overwritten silently.
- **A steward proposal arrives for a field the human already manually overrode in the same session** — the
  proposal still renders (the steward doesn't know), but its Accept button relabels to *"Replace your
  override"* and requires one extra confirmation click — a human's already-recorded decision doesn't get
  silently replaced by an AI suggestion on the first click.
- **Malicious/garbage import** — `SIGNATURE_INVALID`/`SOURCE_NOT_JSON` block the import from becoming a draft
  at all; the raw bytes are still retained as evidence (spec §7) but the UI never auto-derives an editable
  draft from content that failed signature verification without an explicit *"Import anyway, unverified"*
  secondary action that itself requires confirmation and is clearly labeled `SIGNATURE_UNVERIFIED` in the
  resulting draft's provenance.
- **A production card with no provider declared** (`PROVIDER_MISSING`, warning not error) — allowed to
  release, but the empty-state-style nudge persists in the Validation panel across sessions until fixed or
  explicitly dismissed per-release (dismissal doesn't suppress it on the *next* release — a fresh release is
  a fresh chance to notice).

---

## 13. Open questions

- **Person-workspace cards** — does a person's own SA ever get an A2A card in a later wave, and if so does it
  live at `/you/card` (flat, matching the person nav's flat routes) or somewhere else? Spec §9/§10.1 scopes
  the Studio to "per-managed-agent" generally; this doc scopes the first ship to org + service workspaces
  because those are the two Manage-band-having workspace kinds today. **→ PM + Information Architect.**
- **Extended card policies editing** — §3.1's `extended-card` section is `readonly` in the manifest today
  (`ExtendedCardPolicyV1` audience overlays). This doc treats it as a summary-only view with a link out
  rather than designing a full audience-policy editor, since the manifest doesn't yet expose editable fields
  for it. **→ confirm with spec owner whether a W4 sub-task adds an editable policy editor, or whether it's
  W6+.**
- **Batched multi-target publish (§8.6)** — this doc recommends offering one combined confirmation when two
  projection plans share a credential/signer. Confirm with **Security** that batching two *different*
  targets' on-chain writes into one userOp doesn't blur the separate audit events each target's publish is
  supposed to produce (spec §9's audit action list keeps `agent.projection.publish.completed` per-target) —
  the UI-level batching must not collapse the underlying two audit rows into one.
- **Steward proposal cadence** — how often does the Metadata Steward actually run and propose fields (on a
  schedule, on-demand only, on every profile/capability change)? This affects whether the Provenance panel's
  "Proposed by your Metadata Steward" group needs a "Ask your steward to look again" manual-trigger button.
  **→ PM.**
- **Ontologist** — `SkillTaxonomyMappingV1` relations (`exact/close/broad/narrow`) surfaced as plain labels
  in the skill picker (§3.7): confirm these four words are the right steward-facing gloss for
  `skos:exactMatch/closeMatch/broadMatch/narrowMatch` before they ship as fixed UI copy.

---

## 14. Developer handoff notes

- **Everything list/row/badge-shaped in this doc is already typed in `packages/home/src/agent-management/`.**
  Do not invent parallel shapes in the app — import `CardEditorFieldV1`, `ProjectionCenterRowV1`,
  `AgentCardSummaryRowV1`, `StudioApprovalCardV1`, `AGENT_CARD_SCOPES`/`DUTY_SCOPES` directly. If a shape this
  doc describes doesn't exist yet in that package, that's a manifest gap to raise, not a reason to define it
  app-side.
- **This is a Server-Component-friendly surface for the list/read paths**: the cards list, the effective-JSON
  view, provenance, and diagnostics are all pure reads over vault-backed records and can be fetched
  server-side and streamed in. Only the interactive editor form, drag-reorder, the multi-step release/sign/
  publish flows, and anything using `BusyButton` need `'use client'` — keep the client boundary as low as
  the existing `records`/`playbook` split already does (`page.tsx` stays a thin client wrapper only where the
  section itself needs interactivity).
- **Every sign/publish/transaction/DNS step is an approval-gated action whose authority is a
  delegation/entitlement/custody decision (ADR-0062 §7) — the app never locally decides "this user can
  sign."** Every button's enabled/disabled state must re-derive from a server-verified entitlement check on
  render, not from a client-cached role string; `dutiesOf`/`separationOfDutiesFindings` in `permissions.ts`
  are for *rendering* the separation-of-duties picture (§6.1's "waiting on someone with approve access"),
  never for granting.
- **JWS signing (§6.2 step ①) may or may not need a device prompt** depending on whether the org's delegated
  card-signing key is KMS-backed or passkey-backed — the `BusyButton` step-naming and copy in this doc are
  written to read correctly either way (they never say "check your device" unconditionally); confirm with
  the signer implementation which path is live before wiring the copy conditionally.
- **The runtime validator (§4.3, §12) is an app-side `RuntimeValidator` PORT behind an egress-controlled,
  SSRF-safe verifier (ADR-0057)** — this is not pure and not part of `agent-profile/a2a/validation.ts`;
  it's new app-side (or `demo-a2a`-side) code this Studio calls for the "Test interfaces" action specifically.
- **Approval-card rendering (§6.4, §8.5) reuses `buildStudioApprovalCard`/`approvalCoversSubject`
  (`action-cards.ts`) verbatim** — do not hand-roll the digest-truncation or title logic already in that
  module; the render half is intentionally shared between however many places in Home surface approval cards
  (inbox, this Studio).
- **`VERSION_LABELS` (card-editor-manifest.ts) strings are normative and MUST be used verbatim** wherever this
  doc says "card release" / "profile release" / "agent implementation version" / "A2A protocol version" /
  "target specification version" / "adapter version" — grep for the literal string `'Version'` in any new
  component under `agent-cards/` as a review smell; it should not appear unqualified anywhere in this surface.
