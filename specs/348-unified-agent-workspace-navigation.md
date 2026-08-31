# Spec 348 — Unified agent workspace navigation: one shape for every agent type

**Status:** Draft 1
**Date:** 2026-08-31
**ADRs of record:** [ADR-0046](../docs/architecture/decisions/0046-agent-classification-person-org-service.md)
(person / org / service — the closed trichotomy) · [ADR-0010](../docs/architecture/decisions/0010-smart-agent-canonical-identifier.md)
(the SA address is the identity; names and cards are facets) · [ADR-0051](../docs/architecture/decisions/0051-capability-as-canonical-noun.md)
(capability is the canonical noun) · [ADR-0062](../docs/architecture/decisions/0062-agent-card-projection-publication-binding.md)
(card / projection / publication / binding are four distinct things)
**Depends on:** spec 315 (workspace routing), spec 328 (agent config UX v2), spec 334 (coordination work
surface), spec 338 §20 (visibility), spec 346 (typed naming), spec 347 (Agent Card & Projection Studio)
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
- a **named area** — a heading, collapsible, remembering its own open/closed state.

The four top items are the same four for a person, an organization and a service agent, because they
answer the four questions you can ask of any agent: *what is it, who is talking to it, what has it done,
what does it hold.*

**The test for whether something belongs in the top band:** it is a place you go to *watch or participate*.
Everything you go to in order to *change how the agent behaves* is Setup.

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

### 2.2 Stewardship (person + organization only — collapsible, **collapsed by default**)

What this agent stewards *on behalf of someone*. A service agent has none: it is stewarded, it does not
steward. Collapsed by default because it is a directory, not a destination — most sessions never open it.

| Item | Person | Organization |
| --- | --- | --- |
| **Organizations** | orgs they steward or belong to | sub-organizations |
| **Treasuries** | their personal treasury | the org treasury (`/org/<sa>/treasury` today) |
| **Alliances** | coalitions they host | coalitions the org hosts |
| **Workspaces** | app workspaces they hold | workspaces the org holds |

Each item lists agents and links INTO that agent's own workspace. It never edits them: a treasury's own
Setup is reached by switching to the treasury.

### 2.3 Setup (all classes — collapsible, closed by default)

Everything that changes how the agent behaves or how it is described. Nine items, same order everywhere;
a class shows the ones that apply and hides the rest.

| Item | What it owns | Assembled from |
| --- | --- | --- |
| **Profile** | Who this agent is — **vault data only** | `/you` PersonalInfoPanel; `/metadata` tier 1; org `/profile` |
| **Naming** | Its name, its name records, and where it answers | `/naming` + `/metadata` tiers 2–3 + the **A2A endpoint** from the card editor + the **ap-naming projection** from the Studio |
| **Ask** | The assistant that answers when addressed | `Agent → Assistant` sub-tab |
| **Discussion** | How it behaves in discussions | `Agent → Discussions` sub-tab |
| **Skills** | Its declared capabilities | `/skills`, service/org `capabilities` |
| **Playbook** | `apguide:AgentSkillPackage` | `Agent → Playbook` sub-tab |
| **Agent Card** | The signed A2A card | Studio, card flow only |
| **Registry** | Its listing in the discovery registry | Studio ap-registry projection + `/registry` |
| **Trust graph** | Who holds keys, who granted authority | `/trust-graph` |

**§2.3 is the load-bearing change.** Three of today's pages are split by *what they are*, not by what
screen they happened to live on:

- **`Agent` splits into Ask · Discussion · Playbook.** They were horizontal sub-tabs of one page; they are
  three unrelated configurations and each earns a left item.
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

### 2.4 Records (all classes — collapsible, closed by default)

The agent's own vault records. Its own area rather than a Setup item because reading what is stored is not
configuration, and because the area expands to per-family entries as families are added.

### 2.5 Attestations (all classes — collapsible, closed by default)

Statements this agent signed. Its own area for the same reason, and because attestation *types* become the
items inside it.

## 3. The per-class matrix

| Area | Person | Organization | Service |
| --- | --- | --- | --- |
| Top band (4) | ✅ | ✅ | ✅ |
| Stewardship | ✅ | ✅ | ✕ |
| Setup | ✅ | ✅ | ✅ |
| Records | ✅ | ✅ | ✅ |
| Attestations | ✅ | ✅ | ✅ |
| *Organization* (§8.2, open) | ✕ | ✅ | ✕ |

A `✕` means **the area is absent**, not that its items moved. An org-class agent of subtype `.team` /
`.church` / `.circle` gets the org column; a `.svc` / `.workspace` / `.treasury` / `.registry` gets the
service column (ADR-0046 — the suffix names the derived type, the CLASS decides the nav).

A **member** of an organization (spec 318, authority-only) keeps today's behaviour: participation surfaces
only, no Setup, no Stewardship, no Records. Adding areas must never widen what membership grants.

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

**Why Network belongs here and not in Setup:** it is one substrate for every agent (§2 of the
2026-08-31 Discovery work established this — the panel is deliberately shared). A per-agent nav item for a
non-per-agent fact invents a distinction that does not exist.

**Why the Identity group leaves Profile:** §2.3 says Profile is vault data. Handle, SA address, access
level and explorer link are not vault data and not editable there — the handle is owned by Naming, and the
rest is account identity. Keeping them under a "Profile" heading taught that identity is profile data,
which is exactly the confusion ADR-0010 exists to prevent.

## 5. Collapse behaviour

- Every named area is collapsible. The top band is not.
- Defaults: **Stewardship collapsed**; Setup, Records, Attestations collapsed; the area containing the
  current route is **always expanded on load**, whatever the stored state.
- Open/closed is per-area, per-viewer, remembered in `localStorage`. It is a convenience, never
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
| **W1** | `buildNav` emits the new shape for all three classes; areas gain `collapsible` + `defaultOpen`; nav test extended to pin the shape per class | the three navs are shape-identical by test |
| **W2** | Top band completed: Activities + Library for org and service; `Activity` → `Activities` | all four top items resolve for all three classes |
| **W3** | The Setup splits: `Agent` → Ask/Discussion/Playbook; `Card & Projections` → Agent Card/Registry/Naming; `Metadata` folded into Profile + Naming; A2A endpoint moves into Naming | no route renders a surface that another route also owns |
| **W4** | Stewardship area (person + org); Records and Attestations as areas | — |
| **W5** | User menu: Security, Connected, Your apps, Network, Identity; removed from the left nav | the left nav contains only agent-scoped surfaces |

Each wave leaves the app shippable. W3 is the only one that moves stored data surfaces; it moves
*editors*, not records — no vault key changes, no re-projection.

## 8. Open questions

These change what gets built and are NOT decided here.

**8.1 — Where does Work go?** Spec 334's coordination surface (person `My Work`, org `Work`) is not in the
requested top four. It is a participation surface, so it does not belong in Setup. Options: (a) a fifth
top item — breaks "four items, always"; (b) inside **Activities** as a tab — commitments and audit
timeline are different things; (c) its own area. **Recommendation: (c)**, a `Work` area for person + org,
because it has sub-surfaces (requests, endeavors, board) that an area can hold and a tab cannot.

**8.2 — Where do the org-only surfaces go?** `Members`, `Access` and `Settings` are org-class and
unmentioned. **Recommendation:** an `Organization` area (§3 matrix row), holding Members · Access ·
Settings. Not Setup: Setup is about how the agent behaves, and membership is about who else is inside it.
`Treasury` moves to Stewardship per §2.2.

**8.3 — Where does Visibility go?** Spec 338 §20 gives four independent choices (naming / listing /
resolution / inbound). Two of the four are Naming and Registry. **Recommendation:** fold Visibility INTO
Naming and Registry rather than keep a fifth place that overlaps both — but this needs a check against
spec 338's insistence that the four stay independent, since a nav that splits them across two items may
teach that they are coupled.

**8.4 — Does `Your apps` belong in the user menu or stay a workspace surface?** It is a person-scoped
developer surface, so the menu fits; but it is also the only *creation* surface being moved there.

**8.5 — What is inside Records and Attestations as AREAS?** Both are single pages today. An area with one
item is a heading with extra clicks. Either they hold per-family / per-type items (needs those to exist),
or they are top-level items rather than areas. **Recommendation:** ship them as single-item areas ONLY if
W4 also lands the per-family split; otherwise keep them as plain items until it does.

**8.6 — Does a service agent have Attestations?** It can sign them, so the area applies. But if no service
agent has ever signed one, an always-empty area teaches nothing. **Recommendation:** render the area only
when the agent has at least one, consistent with §5's empty-area rule.

**8.7 — Org `Discussions` vs Setup `Discussion`.** The org's top-band Discussions is where you *take part*;
Setup's Discussion is where you configure how the agent behaves in them. Same word, two surfaces, one
letter apart. **Recommendation: rename the Setup item** (e.g. `Discussion replies`) — a nav that
distinguishes two things by pluralisation is a nav that will be misread.
