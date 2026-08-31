# Spec 348 — Unified agent workspace navigation: one shape for every agent type

**Status:** Draft 1
**Date:** 2026-08-31
**ADRs of record:** [ADR-0046](../docs/architecture/decisions/0046-agent-classification-person-org-service.md)
(person / org / service — the closed trichotomy) · [ADR-0010](../docs/architecture/decisions/0010-smart-agent-canonical-identifier.md)
(the SA address is the identity; names and cards are facets) · [ADR-0051](../docs/architecture/decisions/0051-capability-as-canonical-noun.md)
(capability is the canonical noun) · [ADR-0062](../docs/architecture/decisions/0062-agent-card-projection-publication-binding.md)
(card / projection / publication / binding are four distinct things)
**Depends on:** spec 315 (workspace routing), spec 328 (agent config UX v2), spec 334 (coordination work
surface), spec 338 §20 (visibility), spec 342 (org lifecycle), spec 346 (typed naming), spec 347 (Agent
Card & Projection Studio)
**Applies to:** `apps/demo-sso-next` only. No package changes. The nav is app-layer white-label
composition (ADR-0021) — this spec constrains its SHAPE, never its vocabulary.

## 0. The problem

The Home has three left navigations — person, organization, service — and they disagree about where the
same thing lives. Not on the vocabulary, on the *shape*:

| The question | Person | Organization | Service |
| --- | --- | --- | --- |
| Where do I see this agent's activity? | `Activity`, in its own band | nowhere | nowhere |
| Where is its library? | top band | top band | nowhere |
| Where is its trust graph? | `Discovery` (since 2026-08-31) | `Manage`, then `Discovery` | `Discovery` |
| Where do I configure its assistant? | `Manage → Agent`, sub-tab | `Manage → Agent`, sub-tab | `Manage → Agent` (playbook only) |
| Where is its A2A endpoint set? | `Card & Projections`, inside the card editor | same | same |
| Where are its attestations? | `Activity` band | nowhere | nowhere |

Three separate causes, and it is worth naming them because the fix for each is different:

1. **Bands accreted by implementation order, not by task.** `Manage` became the bucket for "settings-ish
   things", so it holds Profile, Agent, Metadata, Card, Members, Records, Access, Treasury and Settings —
   nine items with no relationship to each other beyond having arrived after the top band.
2. **One surface, several homes.** The A2A endpoint is set inside the card editor; the name it belongs to
   is edited under Naming; the same value is readable under Metadata. Three places, one fact.
3. **Absence read as "not applicable" when it was only "not built".** A service agent had no Library and
   no Activity — not by decision, but because nobody wired them. The nav made that look intentional.

The 2026-08-31 Discovery-band work fixed (3) for five surfaces by giving all three classes the same band.
This spec finishes the job: **every agent type gets the same nav shape, and per-class variation is the
PRESENCE OR ABSENCE OF A WHOLE AREA — never a different arrangement of the same items.**

## 1. The model

> **One shape. A class may lack an area; it may never put a shared item somewhere else.**

An agent workspace's left nav is an ordered list of **areas**. Every area is one of:

- **the top band** — no heading, never collapsible, always four items;
- a **named area** — a heading, collapsible, remembering its own open/closed state;
- **Settings** — one item in the main nav that opens a **second pane to its right** (§2.3). It is not an
  area with a heading, because it is not a list of four things: it is a workspace of its own.

The four top items are the same four for a person, an organization and a service agent, because they
answer the four questions you can ask of any agent: *what is it, who is talking to it, what has it done,
what does it hold.*

**The test for whether something belongs in the top band:** it is a place you go to *watch or participate*.
Everything you go to in order to *change how the agent behaves* is Settings.

## 2. The bands, in order

### 2.1 Top band (all classes, no heading, not collapsible)

| Item | What it is | Today |
| --- | --- | --- |
| **Overview** | What this agent is, at a glance | person `/`, org `/org/<sa>/overview`, service `/service/<sa>` |
| **Messages** | Conversations with this agent | exists for all three |
| **Activities** | What this agent has DONE — the control-plane timeline | person `/activity` only; **new for org + service** |
| **Library** | What this agent holds | person + org; **new for service** |

`Activity` (singular, spec 310) becomes the content of **Activities**. The rename is deliberate: the band
is a place, and a place reads better in the plural beside Messages and Library.

### 2.1b Work (person + organization — a main-nav item, not an area)

Spec 334's coordination surface: person `My Work`, org `Work`. A participation surface, so it sits with
the top band rather than in Settings — but outside the four, which stay four. Absent for service agents,
which have no coordination surface today.

### 2.2 Stewardship (person + organization only — a PANE, like Settings)

What this agent stewards *on behalf of someone*. A service agent has none: it is stewarded, it does not
steward. It opens a pane rather than expanding in place — the same second-level grammar Settings uses,
because two disclosure patterns in one 240px column is one too many.

| Item | Person | Organization |
| --- | --- | --- |
| **Organizations** | orgs they steward or belong to | sub-organizations |
| **Treasuries** | their personal treasury | the org treasury (`/org/<sa>/treasury` today) |
| **Alliances** | coalitions they host | coalitions the org hosts |
| **Workspaces** | app workspaces they hold | workspaces the org holds |

Each item lists agents and links INTO that agent's own workspace. It never edits them: a treasury's own
Settings are reached by switching to the treasury.

### 2.3 Settings (all classes — a SECOND PANE, not an area)

Everything that changes how the agent behaves, how it is described, and who is inside it. This is the one
band that does not fit the collapsible-area pattern: an organization's Settings holds twelve items, and a
twelve-item accordion inside a sidebar is a list you scroll past, not a place you navigate.

**So Settings is a single main-nav item that opens a second pane to the right of the main nav** — the
master/detail pattern (macOS System Settings, GitHub repo settings). The main nav stays visible and stays
usable: you always know which agent's settings you are in, and one click leaves.

```
┌───────────────┬────────────────────┬──────────────────────────┐
│ Overview      │ IDENTITY & PRESENCE│                          │
│ Messages      │  Profile           │                          │
│ Activities    │  Naming            │                          │
│ Library       │  Agent Card        │   the selected setting   │
│               │  Registry          │                          │
│ Work          │  Trust graph       │                          │
│ Stewardship ▸ │                    │                          │
│ ▸ Settings    │                    │                          │
│ Records     ▸ │ BEHAVIOUR          │                          │
│ Attestations▸ │  Ask               │                          │
│               │  Discussion replies│                          │
│               │  Skills            │                          │
│               │  Playbook          │                          │
│               │                    │                          │
│               │ PEOPLE & ACCESS    │                          │
│               │  Members  (org)    │                          │
│               │  Access            │                          │
│               │  Status            │                          │
└───────────────┴────────────────────┴──────────────────────────┘
```

The pane is **grouped**, because a flat list of twelve is the same problem in a wider column:

| Group | Items | What the group means |
| --- | --- | --- |
| **Identity & presence** | Profile · Naming · Agent Card · Registry · Trust graph | who this agent is and how the world finds it |
| **Behaviour** | Ask · Discussion replies · Skills · Playbook | what it does when addressed |
| **People & access** | Members *(org)* · Access · Status | who else is inside it, and whether it is running |

Where each item comes from:

| Item | What it owns | Assembled from |
| --- | --- | --- |
| **Profile** | Who this agent is — **vault data only** | `/you` PersonalInfoPanel; `/metadata` tier 1; org `/profile` |
| **Naming** | Its name, its name records, and where it answers | `/naming` + `/metadata` tiers 2–3 + the **A2A endpoint** from the card editor + the **ap-naming projection** from the Studio |
| **Agent Card** | The signed A2A card | Studio, card flow only |
| **Registry** | Its listing in the discovery registry | Studio ap-registry projection + `/registry` |
| **Trust graph** | Who holds keys, who granted authority | `/trust-graph` |
| **Ask** | The assistant that answers when addressed | `Agent → Assistant` sub-tab |
| **Discussion replies** | How it behaves in discussions | `Agent → Discussions` sub-tab |
| **Skills** | Its declared capabilities | `/skills`, service/org `capabilities` |
| **Playbook** | `apguide:AgentSkillPackage` | `Agent → Playbook` sub-tab |
| **Members** *(org only)* | Who belongs to this organization | org `/members` |
| **Access** | What this agent has granted, and to whom | org/service `/access` |
| **Status** | Whether the agent is active — activate / deactivate / delete | org `/settings` (spec 342) |

**Two renames, both forced by this section, both deliberate:**

- **`Setup` → `Settings`.** "Setup" says *first-time configuration*, and nothing here is first-time: you
  return to change a name, a reply, a listing. Settings is what it is.
- **`Settings` (the org lifecycle page) → `Status`.** The old name now collides with the pane's, and
  `Status` is the more honest label anyway: spec 342's page answers *is this organization active*, not
  *how is it configured*.

And one collision resolved structurally rather than by wording: the top band's **Discussions** is where
you take part; Settings' item is where you configure the replies. They now live in different panes, but
different panes are not enough when the words differ by one letter — so the settings item is
**Discussion replies**, which says what it edits.

**§2.3 is the load-bearing change.** Three of today's pages are split by *what they are*, not by what
screen they happened to live on:

- **`Agent` splits into Ask · Discussion replies · Playbook.** They were horizontal sub-tabs of one page;
  they are three unrelated configurations and each earns its own item.
- **`Card & Projections` splits into Agent Card · Registry · Naming.** ADR-0062 says a card, a projection
  and a publication are different things; the nav should say so too. The card flow stays under Agent Card;
  the ap-registry projection moves to Registry; the ap-naming projection moves to Naming — **which is
  where the name it projects is already edited.**
- **`Metadata` stops existing as a destination.** Its three tiers were only ever together because they are
  all "metadata"; they are not one task. Tier 1 (vault) is edited inside **Profile**; tiers 2–3 (name
  records, account profile) are edited inside **Naming**, below the name editor, where the thing being
  published is on screen.

The rule that makes this stick: **the A2A endpoint is a name record.** It was set inside the card editor
because the card needs it, but it is published under the name and read by resolution. It belongs where the
name is.

**Pane behaviour.** The pane opens on the Settings item and stays open for every route beneath it, so
moving between settings costs one click, not two. On a narrow viewport both nav columns are hidden and
the **drawer** carries the settings groups — a two-pane pattern has to design its narrow branch or the
pattern deletes function (the first build shipped without it, and eleven settings surfaces were reachable
on a phone only by typing a URL).

The pane is its own `<nav aria-label="Settings for <name>">` landmark, and it carries a header naming the
agent — not for orientation but for **disclosure**: a person's pane and an org's are near-identical lists,
but the org's writes go to that organization's vault under a stewardship delegation, and which vault you
are about to write to belongs on the screen.

**Amended 2026-08-31 (design review).** The Settings item is a LINK that changes the URL, not a
disclosure control: it is marked `aria-current="true"` while you are anywhere inside the section, and
carries a right-pointing caret. `aria-expanded` on a navigating link makes assistive tech announce
"collapsed" and expect in-place expansion, focus already moves on navigation, and `Escape` has nothing to
dismiss. The visual grammar that replaces it: **left caret = expands in place · right caret = opens the
pane · SMALL-CAPS = a static label, and nothing interactive uses it.**

**Settings sits LAST in the main nav** (amended 2026-08-31): everything above it is somewhere you work;
Settings is the door you take when you want to change the thing you were working in. **Stewardship sits
directly above it**, because it is the other pane — the two second-level sections are neighbours, so the
one grammar reads as one band: what this agent holds for other people, then how it is set up.

**Amended 2026-08-31 (owner) — Stewardship is a PANE too, and there is no accordion.** §2.2 originally
made Stewardship a collapsible area. Having both patterns in one column meant the same small-caps heading
said two different things ("click to expand here" and "a label you cannot click"), and collapsed headings
cost vertical space to show nothing. Both second-level sections now open a pane, so the grammar is one
line long: **a row with a right caret opens a pane beside the nav; small-caps uppercase is a static label
and nothing interactive uses it.** `NavGroup.collapsible` / `defaultOpen` are removed; a row that opens a
pane carries `opensPane`, and its href points at the pane's first item so clicking it always lands
somewhere real.

### 2.4 Records (all classes — collapsible, closed by default)

The agent's own vault records. Its own area rather than a Settings item because reading what is stored is not
configuration, and because the area expands to per-family entries as families are added.

### 2.5 Attestations (all classes — collapsible, closed by default)

Statements this agent signed. Its own area for the same reason, and because attestation *types* become the
items inside it.

## 3. The per-class matrix

| Area | Person | Organization | Service |
| --- | --- | --- | --- |
| Top band (4) | ✅ | ✅ | ✅ |
| Stewardship | ✅ | ✅ | ✕ |
| Settings (pane) | ✅ | ✅ | ✅ |
| Records | ✅ | ✅ | ✅ |
| Attestations | ✅ | ✅ | ✅ |

Inside the Settings pane, four items vary by class. Each is grounded in a surface that does or does not
exist — never in making a list shorter — and an item that would 404 or duplicate another is worse than one
that is honestly absent:

| Pane item | Person | Org | Service | Why |
| --- | --- | --- | --- | --- |
| **Members** | ✕ | ✅ | ✕ | only an organization has members |
| **Status** | ✕ | ✅ | ✕ | spec 342's lifecycle is an org concept |
| **Access** | ✕ | ✅ | ✅ | a person's access is Security, in the user menu (§4) |
| **Ask** | ✅ | ✅ | ✕ | a service's Playbook IS what it answers as — `Ask` would be a second name for one page |
| **Discussion replies** | ✅ | ✕ | ✕ | an org's discussion behaviour is its assistant; a service takes part in none |
| **Visibility** | ✅ | ✕ | ✕ | spec 338 §20 has no agent-scoped surface yet — **a gap, not a decision** |

The last row is the only one that is a to-do rather than a fact about the class. Likewise
**Attestations** is a person-only AREA today for the same reason: a managed agent can sign statements,
but no agent-scoped page reads them yet.

A `✕` means **the area is absent**, not that its items moved. An org-class agent of subtype `.team` /
`.church` / `.circle` gets the org column; a `.svc` / `.workspace` / `.treasury` / `.registry` gets the
service column (ADR-0046 — the suffix names the derived type, the CLASS decides the nav).

A **member** of an organization (spec 318, authority-only) keeps today's behaviour: participation surfaces
only, no Settings, no Stewardship, no Records. Adding areas must never widen what membership grants.

## 4. The user menu (upper right)

The account-level surfaces are not *about the agent in the workspace* — they are about the signed-in
person and the deployment. They leave the left nav for the identity chip's dropdown:

| Item | From |
| --- | --- |
| **Security** | `/security` — credentials, devices, delegations, vault key |
| **Connected** | `/apps` — apps connected to this home |
| **Your apps** | `/developer` — apps this person registered *(§8.4, open)* |
| **Network** | `/network` — deployed substrate status |
| *Identity* | the `Identity` group currently at the bottom of `/you` |

**Why Network belongs here and not in Settings:** it is one substrate for every agent (§2 of the
2026-08-31 Discovery work established this — the panel is deliberately shared). A per-agent nav item for a
non-per-agent fact invents a distinction that does not exist.

**Why the Identity group leaves Profile:** §2.3 says Profile is vault data. Handle, SA address, access
level and explorer link are not vault data and not editable there — the handle is owned by Naming, and the
rest is account identity. Keeping them under a "Profile" heading taught that identity is profile data,
which is exactly the confusion ADR-0010 exists to prevent.

## 5. Collapse behaviour

- Every named area is collapsible. The top band is not. Settings is not an area — it is a pane (§2.3).
- Defaults: **Stewardship collapsed**; Records and Attestations collapsed; the area containing the
  current route is **always expanded on load**, whatever the stored state.
- The Settings pane is open whenever the current route is a settings route, and closed otherwise. It has
  no remembered state: it is where you are, not a preference.
- Area open/closed is per-area, per-viewer, remembered in `localStorage`. It is a convenience, never
  authority — a lost preference costs one click.
- An area with zero visible items renders nothing at all (no empty heading).

## 6. What this spec does NOT change

- **No route may quietly change class.** `/service/<sa>/…` never renders an organization and the reverse;
  the resolver already takes the class as a parameter.
- **No new authority.** Every moved surface keeps the delegation and scope checks it has today. A nav is
  not a permission: the server re-checks on every call.
- **No package changes.** Nav shape is app-layer white-label composition (ADR-0021).
- **Vocabulary is unchanged** except where noted: `Capabilities` → `Skills` in the nav label only
  (ADR-0051 keeps *capability* canonical in prose and ids; `Skills` is the user's word here and the route
  key stays as-is).

## 7. Waves

| Wave | Content | Done when |
| --- | --- | --- |
| **W1** ✅ | `buildNav` emits the new shape for all three classes; areas gain `collapsible`/`defaultOpen`; **Settings is a pane**; Stewardship, Records, Attestations areas; user menu; two gates — shape per class, and **every nav href resolves to a real route** | shipped 2026-08-31 |
| **W2** ✅ | Top band completed: Activities + Library for org and service; `Activity` → `Activities`, agent-scoped by filtering the one control plane | shipped 2026-08-31 |
| **W3** ◑ | Splits: `Agent` → Ask/Discussion replies/Playbook ✅; org lifecycle `Settings` → `Status` ✅; `Card & Projections` → Agent Card/Registry/**Naming** ◑ (the pane addresses them separately; the ap-naming projection and the A2A endpoint have NOT yet moved into the Naming editor); `Metadata` → Profile + Naming ◑ (person Profile is vault-only; the published tiers still live on the Metadata page) | no route renders a surface another route also owns |
| **W4** | The remaining per-class gaps: agent-scoped Visibility, agent-scoped Attestations, per-family Records | the §3 table's last row is empty |
| **W5** | `/you` reduced to the identity rows the user menu points at; `Metadata` route retired once W3 lands | — |

Each wave leaves the app shippable. W3 is the only one that moves stored data surfaces; it moves
*editors*, not records — no vault key changes, no re-projection.

## 8. Open questions

These change what gets built and are NOT decided here.

**8.1 — RESOLVED (2026-08-31).** `Work` is a main-nav item, directly under the top band and above
Stewardship — not inside Activities and not inside Settings. It is a participation surface (you go there
to take part), and the top band stays four, so it sits beside the band rather than in it. Person and
organization only: a service agent has no coordination surface today, and an always-empty item teaches
nothing (§5's empty rule).

**8.2 — RESOLVED (2026-08-31).** The org-only surfaces go into the Settings pane's *People & access*
group: `Members` · `Access` · `Status`. The draft proposed a separate `Organization` area on the reasoning
that membership is not behaviour; that reasoning does not survive the pane — once Settings is a workspace
of its own rather than a sidebar accordion, "who is inside this org" sits beside "how it replies" without
crowding anything, and a second area for three items would be the same list one click further away.
`Treasury` still moves to Stewardship per §2.2, because a treasury is an agent you steward, not a setting.

**8.3 — Where does Visibility go?** Spec 338 §20 gives four independent choices (naming / listing /
resolution / inbound). Two of the four are Naming and Registry. **Recommendation:** keep it as its own
item in the pane's *Identity & presence* group rather than folding it into Naming and Registry — the pane
has room, and spec 338 is explicit that the four choices stay independent. Splitting them across two
items would teach that naming and listing are coupled, which is the one thing that spec forbids.

**8.4 — Does `Your apps` belong in the user menu or stay a workspace surface?** It is a person-scoped
developer surface, so the menu fits; but it is also the only *creation* surface being moved there.

**8.5 — What is inside Records and Attestations as AREAS?** Both are single pages today. An area with one
item is a heading with extra clicks. Either they hold per-family / per-type items (needs those to exist),
or they are top-level items rather than areas. **Recommendation:** ship them as single-item areas ONLY if
W4 also lands the per-family split; otherwise keep them as plain items until it does.

**8.6 — Does a service agent have Attestations?** It can sign them, so the area applies. But if no service
agent has ever signed one, an always-empty area teaches nothing. **Recommendation:** render the area only
when the agent has at least one, consistent with §5's empty-area rule.

**8.7 — RESOLVED (2026-08-31).** `Discussions` stays in the top band (where you take part); the settings
item is **`Discussion replies`** (what it edits). The pane separates them structurally, but two panes are
not enough on their own — a nav that distinguishes two surfaces by pluralisation will be misread wherever
they sit.
