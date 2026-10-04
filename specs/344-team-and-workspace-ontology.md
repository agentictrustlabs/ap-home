# Spec 344 — Teams, Workspaces, and Responsibility: the coordination plane

**Status:** Draft 3 (deep reconciliation: external review + `~/engage` field-web + Gather27 as
reference implementations)
**Date:** 2026-08-21
**ADRs of record:** [ADR-0010](../docs/architecture/decisions/0010-smart-agent-canonical-identifier.md)
(the SA address is canonical) · [ADR-0025](../docs/architecture/decisions/0025-related-agent-links-are-private.md)
(person↔org links are private; membership ≠ stewardship) ·
[ADR-0046] (agent classification is PROV-O's trichotomy: Person / Organization / Software) ·
[ADR-0055](../docs/architecture/decisions/0055-vaults-are-the-canonical-system-of-record-for-content.md)
(the vault is the record; everything else is a projection) · ADR-0013 (one mechanism, fail closed)
**Depends on:** spec 324 (membership, enrollment, DiscussionTopic) · spec 315 (workspace switcher —
**terminology collision resolved in §6.4**) · spec 322 (per-principal interactions substrate) ·
spec 325 (collaboration profile / W3C ORG crosswalk) · spec 326 (actor context + portable authority
chain — the base for acting-context) · spec 327 (org assistant — the delegated-service-agent
pattern the coordinator reuses) · spec 340 (inbox exchange performatives) · spec 341 §5.1c
(messaging scope classes) · spec 342 (organization lifecycle status)
**Ontology:** `packages/ontology` — `tbox/core.ttl`, `tbox/org.ttl`, `tbox/actor-context.ttl`,
`cbox/controlled-vocabularies.ttl`, `mappings/collaboration-crosswalk-organization.ttl`
**Reference implementations read for this draft:** `~/engage` — `apps/field-web` +
`packages/field-domain` (disclosure envelopes, projection manifests, work items, capability tiers),
`apps/gather27-web` + `packages/gather-domain` (a live minimal workspace), `packages/engage-home`
(the Home-client adapter), and the `at:` upper ontology's DataCovenant / DataProjection /
DataSubscription cluster.
**Normative language:** **MUST**, **MUST NOT**, **SHOULD**, **MAY** are normative.

> **Provenance.** This spec follows the external structural review
> ["Design field workspace ontology"](https://chatgpt.com/share/6a87f0ce-c3f8-83ea-a2f7-7d0cafc14ad2)
> (three parts: field operational ontology; feature comparison with GAPP, Disciple.Tools,
> MissionHub, iShare, KapTrack/ODK/Kobo, MissionsApp; reframing around Agentic Primitives Home).
> Its conclusions adopted here, each with the section that carries it:
>
> 1. *Model the field as a graph, not a hierarchy* → §1.2, §2.
> 2. *A chartered Team is a real agent; an informal group is not* → §1.1.
> 3. *Home is principal-centric, Workspace is purpose-centric, Apps are capability- and
>    experience-centric, Vaults are custody-centric, Agents are authority- and action-centric* —
>    the five-plane doctrine → §1.6.
> 4. *One Workspace can host several specialized applications without each application recreating
>    the Organization, Team, roles, and domain context* → §2, §2.4.
> 5. *The Workspace should not automatically own every represented entity — domain entities exist
>    independently, custodians control the authoritative record, the Workspace receives an
>    authorized representation* → §2.2 (**WorkspaceRepresentation**, the load-bearing concept).
> 6. *Membership, Role, Capability, Responsibility, Accountability are five different questions* →
>    §1.5.
> 7. *Switching Workspace is switching authority context, policy context, visible data, allowed
>    disclosure, and audit destination — not changing a filter* → §2.5, §6.
> 8. *Do not create a Workspace for every object* → §2.6.
>
> Field-domain concepts the review also defines (People Group, People Community, Engagement,
> Circle/Church, Mission Field) stay out of this spec: they compose on top in the faith-domain
> profile — `~/engage` is where they live today, and §3 shows the seam. This spec carves only what
> every domain needs: **Team, Affiliation, Workspace, Representation, Responsibility.**

---

## 0. The problem

The substrate today has three durable principals — person, organization, service — and one
collaboration surface, the organization. Every real deployment immediately wants three more things,
and `~/engage` proves all three by having built app-local versions of each:

1. **A team**: a group smaller than (or cutting across) organizations that needs to **act** — hold
   a vault, run boards, be a messaging counterparty, receive delegations. Today the only option is
   a full disconnected organization, losing the chartering relationship entirely.

2. **A workspace — the coordination plane.** Gather27 needed "the set of host organizations whose
   events one app projects" and had to invent `GatherWorkspace` as an app constant. Field-web
   needed "the governed context whose policy caps what a projection may disclose" and had to carry
   it per-record. Neither could say *at Home*: this collaboration exists, these principals
   participate, these apps are bound to it, this is its policy. The container each app rebuilt
   locally is the thing Home should hold once.

3. **Responsibility**: the substrate answers "may they?" (delegations) and "what seat?" (roles) but
   not "what are they expected to care for, and who answers for it?" — the question field-web's
   workboard, Disciple.Tools' assigned-to, and every coverage report actually runs on.

The failure mode to avoid is parallel machinery. Everything here MUST reuse the gates that exist —
membership (324), interactions (322), messaging scope classes (341 §5.1c), inbox performatives
(340), actor context (326), the delegated-assistant pattern (327) — or it will drift from them.

## 1. Doctrine

### 1.1 A chartered Team IS an Organization Agent; an informal group is NOT an agent

Adopted verbatim from the review: *only a chartered Team with leadership, membership, operating
continuity, responsibility, and delegated authority becomes a Team Agent; an informal collection
remains a WorkingGroup.*

- A **Team Agent** is a **custodied Smart Agent of agentKind `org`** — the on-chain 3-valued kind is
  deliberately not extended (the Treasury precedent: `treasury` is a profileType ⊂ service, never a
  fourth agentKind). Teamness is a profile fact (`profileType: 'team'`).
- The payoff: **everything that works for an organization works for a team with zero new gates** —
  directory, membership + enrollment (324), boards and library (322), the org-scope messaging class
  (341 §5.1c: a wire naming a team SA covers its current members, resolved live), lifecycle (342),
  assistant (327).
- A **WorkingGroup** is *not* an agent: no SA, no custody, no authority — a named grouping record,
  promotable by chartering a Team Agent. Promotion is a creation ceremony, never a mutation: the SA
  that did not exist cannot retroactively have acted.

### 1.2 Chartering and affiliation: Situations + Mandates, never a hierarchy

A team associated with several organizations cannot be modeled by ownership and MUST NOT be modeled
by membership-of-people. Two planes, exactly as membership already separates them:

**Evidential plane — `aporg:TeamAffiliation`**, a private-by-default Situation relating exactly one
**teamAgent** and one **organizationAgent**, of exactly one kind:

| kind | meaning | W3C ORG grounding |
| --- | --- | --- |
| `chartered` | this org chartered the team (a sponsor named in the team's charter) | `org:unitOf` (single sponsor) · `org:linkedTo` (joint) |
| `engaged` | the team works WITH this org while remaining external to it | `org:linkedTo` |

- Internal team: one `chartered` affiliation. Cross-organizational team: several `chartered`
  affiliations (joint charter — the review's model 2) or one from an **Alliance Agent** (model 1,
  §1.4). It MUST NOT be stored as if owned by whichever person created it.
- `engaged` affiliations are unbounded. Affiliation is **informational and evidential — never
  authority**: ending every affiliation revokes nothing; revoking every delegation leaves the
  affiliations as history.

**Authority plane — the Mandate**: the delegation the org signs to the team SA, which the ontology
names (`aporg:mandatedByDelegation`, the `materializedByDelegation` pattern from RoleAssignment) so
applications can *talk about* it. The gate never reads the affiliation; it verifies the delegation.

**Evidence rules** (fail closed, both sides for anything cross-boundary): a `chartered` affiliation
minted by the team-create ceremony carries the chartering steward's decision alone (one signer
custodied both sides at that moment); every later `chartered` and every `engaged` affiliation
REQUIRES decisions signed by **both** stewards. Either side may end one unilaterally — ends
currency, revokes nothing.

### 1.3 A Workspace is a governed coordination plane, not an agent and not a tenant

The review's definition, adopted: *a persistent, governed, purpose-bound collaboration context that
binds participating agents, roles, responsibilities, policies, applications, tools, resources, and
authorized data representations.* It is **not** an application tenant, a folder, a Team, an
Organization, or a database — it binds those into an operating context. §2 gives the plane its full
structure; the litmus:

> **If it must sign, hold custody, or be a counterparty — Team (or Org). If it names a governed
> context that apps, agents, entities and activities layer into — Workspace. If it is an informal
> huddle — WorkingGroup.**

**A `<label>.workspace` agent is a SERVICE, and a workspace holds no members** (the owner's rule,
2026-10-02; `core.ttl` `ap:WorkspaceAgent ⊑ ap:ServiceAgent`, `org.ttl` `aporg:coordinatedBy`). The
agent the `.workspace` suffix names is the workspace's agentive face — it coordinates the plane — and it
is NOT an organization: it cannot have `aporg:OrganizationMembership`, and it is a type error to write
`org.membership:member:<sa>` on it. Every workspace that needs membership has an accompanying
ORGANIZATION agent (`.org` root) that GOVERNS it (`aporg:governedBy`), and membership — the
`org.membership:member:<sa>` record with its `aporg:RoleAssignment` `materializedByDelegation` —
lives on the GOVERNING ORGANIZATION. Stewardship (`ap:Stewardship`) is a separate situation, and an
`ap:RelationshipCredential` (has-member, steward-of) grants nothing. The Home's `workspace-create`
charters the organization first and the workspace under it, and writes the pair as records: the
organization's vault holds the `aporg:Workspace` entity keyed `workspace:<ws sa>`
(`{ type, governedBy, coordinatedBy, label, purpose, createdAt }`) and the workspace agent's vault holds
the pointer `workspace.governor` (`{ governedBy, coordinatedBy }`), so any reader holding either agent
finds the other. A workspace chartered before the rule has no pointer and is LEGACY: it still holds its
own membership records, every reader treats it as it was, and `apps/home/scripts/workspace-governor.mts`
charters its governor and moves its membership.

### 1.4 Alliance and the informal counterpart

An **Alliance Agent** is an OrganizationAgent (`profileType: 'alliance'`) whose members are
organizations — `aporg:OrganizationMembership` already permits it (memberAgent ranges over
`ap:Agent`). It exists only when real joint authority is delegated (charter, governance, officers,
its own vault). A loose partnership stays an
`aporg:InterorganizationalCollaborationArrangement` — a record, not an agent — parallel to
WorkingGroup vs Team. Alliance ceremonies are out of this spec's waves; the class is carved now
because Gather27-style multi-host workspaces and the field profile both reach for it.

### 1.5 Membership, Role, Capability, Responsibility, Accountability — five questions, five concepts

| Concept | Question | Substrate artifact |
| --- | --- | --- |
| Membership | May this agent participate here? | `OrganizationMembership` / `WorkspaceParticipation` |
| Role | In what recognized capacity? | `RoleAssignment` (+ role templates) |
| Capability | What acts are authorized? | **Delegations and grants — the only authority** |
| Responsibility | What are they expected to care for? | **NEW: `ResponsibilityAssignment`** |
| Accountability | Who answers for the result? | `accountableAgent` on the assignment |

A Responsibility is a visible, time-scoped commitment — never an authorization. It is *more durable
than an application task*: one responsibility may generate many work items, be fulfilled through
several apps, and survive any one app being replaced. That property is exactly why it belongs to
the substrate (Home) and not to field-web's workboard, which today holds the nearest thing
(`work-item` records) with no cross-app object above them.

### 1.6 The five-plane division of responsibility

The review's doctrine, normative here because every §2 decision derives from it:

| Plane | Centric on | Owns |
| --- | --- | --- |
| **Home** | the principal | identity, principal chooser, relationships, custody admin, mandates, workspaces list, responsibilities, inbox/approvals, app+agent catalog, cross-app workboard |
| **Workspace** | the purpose | governance context, participants, workspace roles, responsibility scope, policy, app/agent/resource bindings, representations, shared artifacts, audit context |
| **App** | capability + experience | domain modeling, capture, analysis, specialized UX and AI — *never* identity, orgs, roles, or another notification center |
| **Vault** | custody | the authoritative record, always with its owner |
| **Agent** | authority + action | signing, commitments, continuity |

An app that recreates a lower plane (its own accounts, its own org table, its own notification
center) is the legacy pattern this substrate exists to end — `@engage/home`'s header says this
about auth in as many words, and this spec extends the same rule to collaboration structure.

## 2. The workspace plane: how Agents, Entities, and Activities layer in

The workspace binds the PROV triad. Each layer has its own admission rule, its own custody rule,
and its own refusal.

### 2.1 The Agents layer — who participates, in what capacity, operated by whom

**Participants are agents of any kind** — persons, orgs, teams, alliances, service agents. This is
the review's key correction and Gather27's live shape (its participants are *host organizations*,
each with a steward, not individual people):

- Participation policy `open` (derived — every current member of the governing agent; never
  asserted) or `restricted` (asserted `WorkspaceParticipation` records, invitation → accept over
  the inbox — the DiscussionTopic §10 doctrine, container-wide).
- An org/team participant **projects its people in through its own live roster** — the 341 §5.1c
  resolution pattern, never copied. Gather27's `GatherHost { org, steward }` is precisely a
  participation record naming an org and resolving its steward live.
- Participants carry **workspace-scoped `RoleAssignment`s** from a template scheme (Workspace
  Steward, Security/Data Steward, Contributor, Partner Observer + domain-profile additions). Roles
  are recognized capacities — the capability is still only ever a delegation.

**The coordinator.** A workspace MAY be operated by an **`ap:WorkspaceAgent`** (called
`WorkspaceCoordinatorAgent` until 2026-08-31) — a service-kind SA the governor delegates to (exactly
the spec-327 org-assistant pattern, scoped to the workspace), the one the `.workspace` suffix names
(`aporg:coordinatedBy` / `aporg:coordinatesWorkspace`). It provides the workspace's A2A/MCP surface:
context resolution, projection publishing, notification generation, audit recording. It is **never an
independent source of authority** — revoke the governor's delegation and the coordinator is inert —
**and it is never a membership subject**: who belongs is the governor's roster (§1.3), read through the
pointer the workspace agent keeps (`workspace.governor`). Gather27's `gather27-a2a` worker (serving
`gather.workspace`, `gather.groups-near` as public skills) is this coordinator, currently without the
named delegation; field-web's `field-a2a` is the same for its richer workspace; a Game Night club is
one too, with its governing organization chartered beside it.

**Bound domain agents.** Beyond the coordinator, a workspace binds specialized agents (the review's
research/planning/validation agents; engage's matching). The binding record answers three questions
the app must not answer for itself: *which principal does this agent represent, which
responsibility does it support, which data may it access* — each answered by a reference to a
mandate, an assignment, and grants respectively. The binding itself is projection, never authority.

### 2.2 The Entities layer — representations, never custody transfer

**This is the load-bearing concept of the whole plane**, and both reference implementations already
enforce it app-locally:

> **`aporg:WorkspaceRepresentation`** — a workspace-scoped, policy-bounded projection of a domain
> entity whose authoritative record stays in its custodian's vault.

| | Conventional SaaS | This substrate |
| --- | --- | --- |
| record | belongs to the tenant | exists independently, custodian controls it |
| workspace sees | everything in the tenant | an **authorized representation** |
| un-sharing | delete/export fight | representation expires or is revoked; the record never moved |

A representation carries: `represents` (the entity), `sourceVault` / source record pointer,
`localLabel` (how *this* workspace knows it — the org-local-name pattern from 341 §7, generalized),
`sensitivity`, `locationPrecision`, `sharingPolicy`, `validUntil`, provenance.

Grounding in code that already runs:

- **Gather27**: the workspace listing is *documented in-code* as "a published projection
  (rebuildable); the event record of truth is the host org's vault." Every `GatherGroup` row is a
  WorkspaceRepresentation of a `GatherEvent` custodied by the host.
- **field-web**: `eng:ProjectionManifest` is the representation's **decision record** — named
  source records and versions, fields included and withheld, transformations, recipient, purpose,
  sensitivity ceiling, precision cap, retention. Its rules become this spec's normative floor:
  **absence of a policy is never public** (unclassified fails closed); a release may never exceed
  the governing precision cap; an L5-class fact is never represented because it is never stored.
- **Upper ontology**: the `at:` DataCovenant → DataProjection → DataSubscription cluster is the
  crosswalk target — the covenant is the workspace's sharing policy, the projection is the
  representation, subscriptions are the participants' reads.

**Adopted resources are entities too.** The review's resource fabric — provider publishes; **Home**
discovers, licenses, favorites; **Workspace** adopts an approved version for a purpose; **App**
renders — enters the model as a representation whose source is an external provider rather than a
participant vault (`aporg:adoptedResource`, versioned). Ontology carved now; Home resource-library
UX is a later wave (§8).

### 2.3 The Activities layer — acts, exchanges, and work carried out within the plane

Three kinds of activity touch a workspace, each already having a rail:

1. **Acts** (PROV Activities with authority): every consequential act records *who acted, for whom,
   within which workspace, under which mandate* — one new edge (`apactor:withinWorkspace`) on
   spec 326's `ActorContext`, joining the portable authority chain (`actingAgent`, `rootPrincipal`,
   `AuthorityChainEnvelope`) to the coordination plane. This is what makes the workspace an **audit
   context** and not a folder: filtering the audit log by workspace becomes a query, not a
   reconstruction.

2. **Exchanges** (coordination performatives): invitations, affiliation proposals, responsibility
   proposals, approval requests, data-sharing requests ride the spec-340 inbox as typed
   performatives — an app sends an interaction to Home; it does not build another notification
   center. The workspace contributes only the *scope* on the performative.

3. **Work** (domain activities): engagements, work items, observations are **domain records in the
   responsible participant's vault** (field-web's `work-item` lives in the acting org's vault
   today — correct; unchanged), surfaced in the workspace as representations (§2.2) and rolled up
   to the person's cross-app workboard through the responsibility that generated them (§1.5). The
   layering that results: *Responsibility (substrate, durable) → generates WorkItems (domain,
   per-app) → performed as Acts (audit, per-hop)* — three different lifetimes, three different
   owners, never one table.

Engage's own algebra is the boundary proof: its ten-step need→probe→offer→**mandate**→receipt flow
stays entirely in the domain (Ring 2) — the workspace does not absorb it. What the workspace adds
is only where such a flow is *hosted*: which principals could see the projected need, under whose
policy, into which audit context.

### 2.4 App bindings — several apps, one context

A workspace names the applications bound into it (`aporg:boundApp`, by OIDC client id). The review's
central improvement over legacy tenancy is normative:

> One workspace can host several specialized applications without each application recreating the
> organization, the team, the roles, and the domain context.

- Binding is **projection** ("this app appears in this workspace; this workspace appears in this
  app") — a bound app's reads still ride its own per-app read grants (341 §4.3). Binding an app
  grants nothing; unbinding it revokes nothing except presence.
- Apps declare which **workspace profiles** (§2.5) they support; Home's catalog matches on it.
- What an app may contribute: routes, Home cards, workspace panels, MCP tools, A2A skills, agents.
  What it MUST NOT contribute: identity, principals, roles, another inbox (§1.6).
- Concretely: field-web and gather27-web could both bind to one field workspace — gather27
  projecting public event listings out of the same context field-web plans in, without either app
  knowing the other exists. Today they cannot, because "the workspace" is a constant inside each.

### 2.5 Workspace profiles and policy

A workspace has one **profile** (field-operations, coordination, data-collection, mobilization,
personal-project… — a SKOS scheme domain packs extend) plus capability modules. The profile is what
an app binding matches against and what seeds the policy set.

Switching workspace is switching **authority context, policy context, visible data, allowed
disclosure, and audit destination — not changing a filter**. The policy set (classification scheme,
disclosure/precision caps, retention, AI-use) is owned by the governor and inherited — the
workspace has no policy its governor did not give it. v1 carries the policy fields normatively but
enforces disclosure only where field-domain already enforces it (the projection path); §5 states
what is honest now versus later.

### 2.6 When NOT to create a workspace

Adopted as normative guidance (the review's §12): create one only when the **governing principal,
participant boundary, custody/disclosure policy, security classification, shared purpose/lifecycle,
cross-org commitment, or audit boundary** materially changes. Otherwise use a lens, a saved view, a
topic, a team, or an app page. *Somali Families—Weld* is a community **within** a field workspace,
not a workspace; one engagement is an activity within it, not another workspace. A separate
protected workspace is justified when participants, disclosure, custody, or leadership genuinely
differ.

## 3. Grounding: the two reference implementations, mapped

| Concept (this spec) | Gather27 (minimal, live) | field-web (rich, live) |
| --- | --- | --- |
| Workspace | `GATHER27_WORKSPACE_ID` app constant | implicit in `field-a2a` deployment |
| governedBy | the Gather27 operator (implicit) | the fielding org (implicit) |
| Participants (org-kind) | `GatherHost { org, steward }[]` | teams/orgs in circles |
| Participation ceremony | host onboarding + invite tokens | enrollment |
| WorkspaceRepresentation | listing rows; "published projection (rebuildable); record of truth is the host org's vault" | `eng:ProjectionManifest` + `at:DataProjection`; disclosure envelopes with sensitivity + precision caps |
| Coordinator agent | `gather27-a2a` worker (`gather.workspace`, `gather.groups-near`) | `field-a2a` (33 capability-tiered skills) |
| boundApp | gather27-web (hard-wired) | field-web (hard-wired) |
| Activities | events (host-vault records) | `work-item` records, plans, evidence |
| Responsibility | — (gap) | workboard approximates it per-app (gap above apps) |
| Policy floor | public listings only | **absence of a policy is never public**; L5 = never stored |

What changes for them when this spec lands: the constants become records at Home (a workspace the
operator governs, host participations, a coordinator delegation); the projection conventions become
`WorkspaceRepresentation`s the substrate can list, expire, and audit; and the workboard gains the
durable Responsibility above it. What does NOT change: where any record lives.

## 4. Ontology changes (`packages/ontology`)

### 4.1 `tbox/core.ttl`

```turtle
ap:TeamAgent a owl:Class ;
    rdfs:subClassOf ap:OrganizationAgent ;
    rdfs:label "Team Agent" ;
    rdfs:comment "A CHARTERED org-kind Smart Agent operating within or across organizations
      (aporg:TeamAffiliation): leadership, membership, continuity, responsibility, delegated
      authority. An informal collection is aporg:WorkingGroup, not an agent. NOT a fourth agentKind
      (the treasury⊂service precedent). ⊑ org:OrganizationalUnit under a sole 'chartered'
      affiliation (mappings)." .

ap:AllianceAgent a owl:Class ;
    rdfs:subClassOf ap:OrganizationAgent ;
    rdfs:label "Alliance Agent" ;
    rdfs:comment "An org-kind Smart Agent whose members are organizations, existing only where real
      joint authority is delegated. A loose partnership is
      aporg:InterorganizationalCollaborationArrangement — a record, not an agent." .
```

### 4.2 `tbox/org.ttl`

```turtle
# ─── Team affiliation (§1.2) ──────────────────────────────────────────

aporg:TeamAffiliation a owl:Class ;
    rdfs:subClassOf apsit:Situation ;
    rdfs:comment "Private-by-default Situation: exactly one teamAgent + one affiliatedOrganization +
      one affiliationKind under signed AffiliationDecision evidence. Informational — never authority.
      Cross-org teams hold several 'chartered' affiliations (joint charter) or one from an Alliance." .

aporg:teamAgent a owl:ObjectProperty ;
    rdfs:domain aporg:TeamAffiliation ; rdfs:range ap:TeamAgent .
aporg:affiliatedOrganization a owl:ObjectProperty ;
    rdfs:domain aporg:TeamAffiliation ; rdfs:range ap:OrganizationAgent .
aporg:affiliationKind a owl:ObjectProperty ;
    rdfs:domain aporg:TeamAffiliation ; rdfs:range skos:Concept ;
    rdfs:comment "aporg:affiliationKindScheme — chartered | engaged (cbox)." .
aporg:mandatedByDelegation a owl:ObjectProperty ;
    rdfs:domain aporg:TeamAffiliation ; rdfs:range apdel:Delegation ;
    rdfs:comment "The chartering org's mandate — the delegation org→team that MATERIALIZES what the
      affiliation only evidences. The gate verifies the delegation, never this record." .

aporg:AffiliationProposal a owl:Class ; rdfs:subClassOf prov:Entity .
aporg:AffiliationDecision a owl:Class ; rdfs:subClassOf prov:Entity ;
    rdfs:comment "Signed accept/reject. Both stewards for 'engaged' and post-hoc 'chartered'; the
      chartering steward alone when minted by the team-create ceremony itself." .
aporg:AffiliationTermination a owl:Class ; rdfs:subClassOf prov:Entity ;
    rdfs:comment "Either side, unilaterally. Ends currency; revokes nothing." .

aporg:charteredBy a owl:ObjectProperty ;
    rdfs:domain ap:TeamAgent ; rdfs:range ap:OrganizationAgent ;
    rdfs:comment "DERIVED: current 'chartered' TeamAffiliation exists. Never asserted globally." .
aporg:engagedWith a owl:ObjectProperty ;
    rdfs:domain ap:TeamAgent ; rdfs:range ap:OrganizationAgent ;
    rdfs:comment "DERIVED: current 'engaged' TeamAffiliation exists." .

# ─── Boundary cases (§1.1, §1.4) ──────────────────────────────────────

aporg:WorkingGroup a owl:Class ; rdfs:subClassOf prov:Entity ;
    rdfs:comment "An informal named collection of agents — NOT an agent: no custody, no authority.
      Promotable by chartering a TeamAgent (a creation ceremony, never a mutation)." .

aporg:InterorganizationalCollaborationArrangement a owl:Class ; rdfs:subClassOf prov:Entity ;
    rdfs:comment "A loose partnership among organizations. Becomes ap:AllianceAgent only when real
      joint authority is delegated." .

# ─── Workspace: the coordination plane (§2) ───────────────────────────

aporg:Workspace a owl:Class ; rdfs:subClassOf prov:Entity ;
    rdfs:comment "A persistent, governed, purpose-bound coordination plane binding participant
      agents, roles, responsibilities, policies, app/agent/resource bindings and representations.
      NOT an agent, NOT a tenant: no custody, no address, no authority of its own. Governance
      inherited from its governor; records in the governor's vault (ADR-0055). Several apps may
      bind to ONE workspace — none of them recreates the org, team, roles, or domain context.
      MEMBERSHIP IS THE GOVERNOR'S: a workspace has no members and its coordinating agent cannot
      have any (it is a ServiceAgent); who belongs is aporg:OrganizationMembership on the
      organization that governs it. The entity is recorded in the governor's vault as
      `workspace:<coordinating sa>`; the coordinating agent keeps the pointer `workspace.governor`." .

aporg:governedBy a owl:ObjectProperty ;
    rdfs:domain aporg:Workspace ; rdfs:range ap:OrganizationAgent ;
    rdfs:comment "Exactly one governing agent (org, team, or alliance). Source of every policy the
      workspace has, AND the subject of every membership read about it. Switching workspace =
      switching authority/policy/disclosure/audit context." .
aporg:workspacePurpose a owl:DatatypeProperty ;
    rdfs:domain aporg:Workspace ; rdfs:range xsd:string .
aporg:workspaceProfile a owl:ObjectProperty ;
    rdfs:domain aporg:Workspace ; rdfs:range skos:Concept ;
    rdfs:comment "aporg:workspaceProfileScheme. One primary profile; apps declare which profiles
      they support and the catalog matches on it." .
aporg:focusedOn a owl:ObjectProperty ;
    rdfs:domain aporg:Workspace ;
    rdfs:comment "What the collaboration is ABOUT (a field, an initiative — domain profiles narrow
      the range). The focus is not the workspace (review §12: a community or engagement within a
      workspace is not another workspace)." .
aporg:workspaceParticipationPolicy a owl:ObjectProperty ;
    rdfs:domain aporg:Workspace ; rdfs:range skos:Concept ;
    rdfs:comment "open (derived from the governor's membership — never asserted) | restricted
      (asserted WorkspaceParticipation records)." .

# Agents layer (§2.1)
aporg:WorkspaceParticipation a owl:Class ; rdfs:subClassOf apsit:Situation ;
    rdfs:comment "Asserted participation in a RESTRICTED workspace: exactly one participantAgent
      (ANY agent kind) + one inWorkspace, by invitation → accept. An org/team participant projects
      its people in through its own live roster — never copied (the 341 §5.1c resolution pattern;
      Gather27's GatherHost is this record)." .
aporg:participantAgent a owl:ObjectProperty ;
    rdfs:domain aporg:WorkspaceParticipation ; rdfs:range ap:Agent .
aporg:inWorkspace a owl:ObjectProperty ;
    rdfs:domain aporg:WorkspaceParticipation ; rdfs:range aporg:Workspace .

aporg:coordinatedBy a owl:ObjectProperty ;
    rdfs:domain aporg:Workspace ; rdfs:range ap:WorkspaceAgent ;
    rdfs:comment "The ap:WorkspaceAgent: a service-kind SA the GOVERNOR delegates to (the
      spec-327 assistant pattern, workspace-scoped). Provides the workspace's A2A/MCP surface —
      projection publishing, notifications, audit. NEVER an independent source of authority:
      revoke the governor's delegation and it is inert. NEVER a membership subject: it is a
      service, and a service has no members. Range narrowed from ap:ServiceAgent to
      ap:WorkspaceAgent by spec 346 §2.2 — the workspace agent is the derived type the
      '.workspace' suffix names." .

aporg:coordinatesWorkspace a owl:ObjectProperty ;
    rdfs:domain ap:WorkspaceAgent ; rdfs:range aporg:Workspace ;
    owl:inverseOf aporg:coordinatedBy ;
    rdfs:comment "The workspace context this workspace agent custodies and serves. At most one. The
      NAME binds to the workspace agent SA (the workspace's agentive face); the context is a governed
      Entity in the governor's vault (§5) and is never itself named." .

aporg:boundAgent a owl:ObjectProperty ;
    rdfs:domain aporg:Workspace ; rdfs:range ap:Agent ;
    rdfs:comment "A specialized domain agent bound into the workspace. The binding must reference
      which principal it represents (mandate), which responsibility it supports (assignment), and
      which data it may access (grants) — three references, never new authority." .

# Entities layer (§2.2)
aporg:WorkspaceRepresentation a owl:Class ; rdfs:subClassOf prov:Entity ;
    rdfs:comment "A workspace-scoped, policy-bounded PROJECTION of a domain entity whose
      authoritative record stays in its custodian's vault. Conventional SaaS: record belongs to
      tenant. Here: entity exists independently; custodian controls the record; the workspace
      receives an authorized representation that can expire or be revoked without the record ever
      moving. Crosswalk: at:DataProjection under an at:DataCovenant; decision record precedent:
      eng:ProjectionManifest (field-domain). NORMATIVE FLOOR: absence of a policy is never public —
      an unclassified representation fails closed." .

aporg:represents a owl:ObjectProperty ;
    rdfs:domain aporg:WorkspaceRepresentation ;
    rdfs:comment "The domain entity represented. Range open — domain profiles narrow it." .
aporg:representationOfWorkspace a owl:ObjectProperty ;
    rdfs:domain aporg:WorkspaceRepresentation ; rdfs:range aporg:Workspace .
aporg:sourceCustodian a owl:ObjectProperty ;
    rdfs:domain aporg:WorkspaceRepresentation ; rdfs:range ap:Agent ;
    rdfs:comment "Whose vault holds the authoritative record. Custody NEVER moves." .
aporg:localLabel a owl:DatatypeProperty ;
    rdfs:domain aporg:WorkspaceRepresentation ; rdfs:range xsd:string ;
    rdfs:comment "How THIS workspace knows the entity — the org-local-name pattern generalized." .
aporg:sharingPolicy a owl:ObjectProperty ;
    rdfs:domain aporg:WorkspaceRepresentation ; rdfs:range skos:Concept ;
    rdfs:comment "Disclosure bound on the representation (sensitivity / precision caps — domain
      packs supply the scheme, e.g. eng: sensitivity L0–L5 + gc: location precision)." .
aporg:representationValidUntil a owl:DatatypeProperty ;
    rdfs:domain aporg:WorkspaceRepresentation ; rdfs:range xsd:dateTime .

aporg:adoptedResource a owl:ObjectProperty ;
    rdfs:domain aporg:Workspace ;
    rdfs:comment "A versioned external resource the workspace adopts for its purpose (the resource
      fabric: provider publishes → HOME discovers/licenses → WORKSPACE adopts a version → APP
      renders). A representation whose source is a provider, not a participant vault." .

# App bindings (§2.4)
aporg:boundApp a owl:ObjectProperty ;
    rdfs:domain aporg:Workspace ;
    rdfs:comment "An application (OIDC client) bound into this workspace. PROJECTION ONLY — the
      app's reads still ride its own per-app read grants (spec 341 §4.3); binding grants nothing,
      unbinding revokes nothing but presence. Several apps per workspace is the point (§2.4)." .

apmsg:hostedInWorkspace a owl:ObjectProperty ;
    rdfs:domain apmsg:DiscussionTopic ; rdfs:range aporg:Workspace ;
    rdfs:comment "A topic MAY be hosted in one workspace of the same governor. Absent = the
      org-wide board (today's behavior, unchanged)." .

# ─── Responsibility (§1.5) ────────────────────────────────────────────

aporg:ResponsibilityAssignment a owl:Class ; rdfs:subClassOf apsit:Situation ;
    rdfs:comment "A time-scoped, visible commitment: an agent is expected to care for an outcome or
      resource within a scope, under named authority and accountability. NEVER an authorization.
      More durable than an app task: one responsibility → many work items → many apps; survives
      app replacement. Five questions, five concepts (spec 344 §1.5)." .

aporg:responsibleAgent a owl:ObjectProperty ;
    rdfs:domain aporg:ResponsibilityAssignment ; rdfs:range ap:Agent .
aporg:accountableAgent a owl:ObjectProperty ;
    rdfs:domain aporg:ResponsibilityAssignment ; rdfs:range ap:Agent ;
    rdfs:comment "Who answers for the result. MAY differ from responsibleAgent." .
aporg:responsibilityKind a owl:ObjectProperty ;
    rdfs:domain aporg:ResponsibilityAssignment ; rdfs:range skos:Concept .
aporg:responsibilityScope a owl:ObjectProperty ;
    rdfs:domain aporg:ResponsibilityAssignment ;
    rdfs:comment "A workspace, team, engagement, record family — domain profiles narrow the range." .
aporg:underMandate a owl:ObjectProperty ;
    rdfs:domain aporg:ResponsibilityAssignment ; rdfs:range apdel:Delegation ;
    rdfs:comment "The authority the responsible agent exercises — a reference, not a grant." .
aporg:expectedOutcome a owl:DatatypeProperty ;
    rdfs:domain aporg:ResponsibilityAssignment ; rdfs:range xsd:string .
aporg:reviewCadenceDays a owl:DatatypeProperty ;
    rdfs:domain aporg:ResponsibilityAssignment ; rdfs:range xsd:integer .
```

### 4.3 `tbox/actor-context.ttl` — the Activities edge

```turtle
apactor:withinWorkspace a owl:ObjectProperty ;
    rdfs:domain apactor:ActorContext ; rdfs:range aporg:Workspace ;
    rdfs:comment "The workspace this hop was performed within, when one applies. Joins the portable
      authority chain (actingAgent / rootPrincipal / AuthorityChainEnvelope) to the coordination
      plane — the review's WorkspaceContext realized ON spec 326, not beside it. Makes the
      workspace an audit context: filtering acts by workspace becomes a query." .
```

### 4.4 `cbox/controlled-vocabularies.ttl`

The profileType vocabulary (agent-profile / HCS-11 mirror; `treasury ⊂ service` is the precedent —
see the cbox `ap:agentKind` disambiguation note) gains **`team ⊂ org`** and **`alliance ⊂ org`**.
Never new agentKinds. New schemes in the existing cbox style:

```turtle
aporg:affiliationKindScheme a skos:ConceptScheme .
aporg:CharteredAffiliation a skos:Concept ; skos:inScheme aporg:affiliationKindScheme ; skos:prefLabel "chartered" .
aporg:EngagedAffiliation   a skos:Concept ; skos:inScheme aporg:affiliationKindScheme ; skos:prefLabel "engaged" .

aporg:workspacePolicyScheme a skos:ConceptScheme .
aporg:OpenWorkspace       a skos:Concept ; skos:inScheme aporg:workspacePolicyScheme ; skos:prefLabel "open" .
aporg:RestrictedWorkspace a skos:Concept ; skos:inScheme aporg:workspacePolicyScheme ; skos:prefLabel "restricted" .

aporg:workspaceProfileScheme a skos:ConceptScheme ;
    rdfs:comment "coordination | field-operations | data-collection | mobilization |
      personal-project — domain packs extend. An app binding declares supported profiles." .

aporg:workspaceRoleScheme a skos:ConceptScheme ;
    rdfs:comment "Workspace Steward · Security/Data Steward · Contributor · Partner Observer —
      templates, never the authorization model. Assignment = aporg:RoleAssignment scoped to the
      workspace." .
```

### 4.5 `mappings/collaboration-crosswalk-organization.ttl`

```turtle
ap:TeamAgent skos:closeMatch org:OrganizationalUnit ;
    rdfs:comment "A unit only under a sole 'chartered' affiliation; jointly-chartered or independent
      teams are org:FormalOrganization like any other." .
ap:AllianceAgent skos:closeMatch org:FormalOrganization ; rdfs:seeAlso org:linkedTo .
aporg:charteredBy skos:closeMatch org:unitOf , org:subOrganizationOf .
aporg:engagedWith skos:closeMatch org:linkedTo .
aporg:TeamAffiliation rdfs:seeAlso dul:Situation , gufo:Relator .
aporg:WorkingGroup skos:closeMatch foaf:Group .
aporg:WorkspaceRepresentation rdfs:seeAlso at:DataProjection ;
    rdfs:comment "The at: cluster is the covenant-governed sharing precedent: DataCovenant (terms) →
      DataProjection (the released view) → DataSubscription (the receivers). eng:ProjectionManifest
      is the decision-record refinement." .
aporg:AffiliationProposal    skos:closeMatch as:Offer .
aporg:AffiliationDecision    skos:closeMatch as:Accept , as:Reject .
aporg:AffiliationTermination skos:closeMatch as:Leave , as:Remove .
```

### 4.6 SHACL (`cbox/org-team-shapes.shacl.ttl`, new)

- **TeamAffiliationShape** — exactly one `teamAgent`/`affiliatedOrganization`/`affiliationKind`;
  `teamAgent` profiled `team`; sides distinct; post-ceremony `chartered` and every `engaged`
  affiliation carry two `AffiliationDecision`s with distinct signers.
- **WorkspaceShape** — exactly one `governedBy`; policy + profile from their schemes; `restricted`
  participations all name it; an `open` workspace MUST NOT have asserted participations; at most
  one `coordinatedBy`.
- **WorkspaceRepresentationShape** — exactly one `represents`, `representationOfWorkspace`,
  `sourceCustodian`; **a missing `sharingPolicy` is a violation** (absence of a policy is never
  public — the field-domain rule, made structural).
- **ResponsibilityShape** — exactly one `responsibleAgent`, at most one `accountableAgent`; a kind;
  MUST NOT carry grant/authority terms (`underMandate` is a reference).
- Fixtures: internal team; jointly-chartered cross-org team; engaged-only team; open + restricted
  workspace; org-as-participant (the Gather27 shape); representation with and without policy
  (fail); responsibility with distinct accountable agent.

## 5. Records and residency

| Fact | THE RECORD (vault, ADR-0055) | Projection |
| --- | --- | --- |
| team-ness / alliance-ness | the agent's own profile: `profileType` | `related:*` rows gain `kind`; resolvers |
| affiliation (both kinds) | `org.affiliation:<counterparty>` in **both** vaults (each side its own copy, like membership) | relationships doc entry each side |
| workspace descriptor + bindings + policy | `workspace.index` in the **governor's** vault | Home cards; app-visible via interactions ops |
| participation | `workspace.participation:<id>` per-workspace docs (the spec 322 §10 lesson) | resolved live with participant rosters |
| representation | `workspace.representation:<id>` in the governor's vault — **pointing at**, never copying, the source record | what bound apps actually list |
| shared workspace artifacts (topics, shelf) | governor's vault under the workspace scope (`workspaceId` on `ChannelV1`; `ws/<id>/…` library convention) | board reads filter by it |
| domain work (work items, engagements, events) | **the responsible participant's vault — unchanged** (Gather27 events in host vaults; field work items in the acting org's vault) | representations, workboard roll-ups |
| responsibility | `org.responsibility:<id>` in the accountable side's governing vault | Home Responsibilities view (§6.3) |

Writes ride existing grants: stewardship delegations for affiliation/responsibility/workspace
records, the plane-B interactions grant for boards and artifacts, the coordinator's scoped
delegation for projection publishing. **No new grant type, no new secret, no new plane.**

The review's "workspace vault" (§10 of its Home part) maps to the **workspace scope of the
governor's vault** plus the coordinator's delegated write path — a real workspace-owned vault would
require the workspace to be an agent, which §1.3 forbids. If a collaboration truly needs its own
custody, that is the signal it is a **Team**, and the litmus already routes it there.

## 6. Home design

### 6.1 Home navigation: workspaces and responsibilities become first-class

The review's target nav — Today · Inbox & Exchanges · Responsibilities · **Workspaces** ·
Principals · Library · Apps & Agents · Vaults & Access — is adopted as the direction. This spec's
waves deliver the two missing nouns (Workspaces §6.3, Responsibilities §6.4); **Today** (the
cross-app workboard fed by responsibilities, exchanges, and workspace cards) becomes buildable once
they exist and is specified separately.

### 6.2 Create a team (W1)

`createOrganization` (`src/home/onboarding.ts`) gains `opts.team?: { charteringOrg?: Address }`:

1. Same SA deploy + custody + stewardship + grant mint as an org (the chain sees an org).
2. Profile write marks `profileType: 'team'`.
3. With `charteringOrg`: the ceremony writes the `chartered` affiliation into both vaults and mints
   the **mandate delegation** (charteringOrg → team SA) the affiliation references. Precondition:
   the caller stewards both sides (checked exactly as spec 342 checks the lifecycle write). One
   ceremony, one signer, three records.
4. UI: "Create an organization" gains a kind choice — *Organization* / *Team* — with a charterer
   selector (orgs the person stewards, or independent). The 315 switcher groups teams under their
   charterer; independent and multi-chartered teams list among orgs.

An **Affiliations** panel on the team's environment (W2): current affiliations with kind badges;
propose engagement / joint charter (an `AffiliationProposal` riding the inbox as a spec-340
performative; counterparty steward's approval signs their decision); end affiliation — with the
copy stating *ending an affiliation revokes nothing; revoke the mandate to withdraw authority*, and
the mandate's revoke action rendered beside it: adjacent, never conflated.

### 6.3 The Workspaces surface (W3–W4)

On an org/team environment, a **Workspaces** card (list from `workspace.index`; a steward creates
one: name, purpose, profile, participation policy). A workspace page follows the review's card and
nav, restricted to what v1 actually has:

```
COLORADO FIELD COORDINATION                     [profile: field-operations]
governed by colorado-outreach.impact
you participate as Alice — on behalf of Greeley Field Team
your workspace roles: Contributor
responsibilities here: 2 open · 1 review due
participants: 3 organizations · 2 teams · 14 people
bound apps: Field Operations · Gather27
─────────────────────────────────────────────────
Overview · Participants · Boards · Shelf · Representations · Responsibilities · Apps & Agents
```

- **Participants**: governor's roster for `open`; participation records for `restricted`
  (invitation → accept over the inbox), org/team participants expanding through their own live
  roster with their local labels.
- **Boards / Shelf**: existing topics and library scoped by `workspaceId` — no new content plane.
- **Representations**: what has been projected in, each row showing source custodian, local label,
  sharing policy, expiry — and *nothing without a policy* (fails closed, rendered as a refusal to
  represent, not an empty cell).
- **Apps & Agents**: bound apps with what each can actually read (its 341 §4.3 grants) side by side
  — binding shown as projection, grants shown as authority. The coordinator agent listed with its
  delegation and a revoke affordance.

### 6.4 The spec-315 name collision, resolved

Spec 315's "workspace switcher" selects **which principal the person acts as** — the review names
these the person's *Agent Environments*, and its acting-context concept confirms the split:
acting-as is context (§4.3's `withinWorkspace` hangs off it); *Workspace* is the container.
Normative: the ontology term `aporg:Workspace` means ONLY this spec's container; Home copy for the
315 switcher SHOULD migrate to **"acting as"** language at the next copy pass. Code identifiers
(`WorkspaceScope`) MAY stay.

### 6.5 Responsibilities (W5)

A **Responsibilities** view in the person's Home nav, grouped by principal (the review's §4.3
layout: PERSONAL / each org / each team), plus a card per workspace:

- assignments where the person is `responsibleAgent` (mine) and `accountableAgent` (answering for);
- each renders kind, scope, expected outcome, review cadence, and the mandate it exercises;
- create is steward-gated on the governing side; **acceptance by the responsible agent rides the
  inbox** — a commitment is taken, not imposed (proposal → accept, spec-340 performatives);
- apps surface their own work items *under* a responsibility by reference — the durable object is
  Home's, the tasks are theirs (§2.3's three-lifetime layering).

### 6.6 What relying apps see (W6)

- `related-orgs` / `listManagedAgents` return teams and alliances with `kind` + charterer; Commons'
  `OrgSummary` renders a team badge under its charterer.
- New interactions ops on the governor's DO, same gates as `directory.*`: `workspace.list`,
  `workspace.get`, `workspace.representations`. A bound app calls them with its session; a
  non-participant's read of a restricted workspace returns the refusal, not an empty list.
- Messaging needs **nothing**: a wire naming a team SA already covers current team members
  (341 §5.1c). Protected by a conformance test, not re-implemented.
- Migration proof for the reference apps: Gather27's `GatherWorkspace` constant becomes a
  `workspace.get` read; its host onboarding becomes participation; its listing publish becomes the
  coordinator writing representations. Field-web binds to the same workspace without either app
  changing its domain.

## 7. What this deliberately does NOT do

- **No fourth agentKind**; team and alliance are profile facts.
- **No nested teams in v1** (a charterer MUST be a non-team org or alliance; one SHACL line to
  relax later).
- **No workspace vault and no workspace authority boundary in v1.** The workspace scope lives in
  the governor's vault; a restricted workspace hides projection, it does not gate the vault. The
  UI states this ("private within this app's surfaces") until a per-workspace record-scope carve
  lands. Honest projection now, real gate later — never a pretend gate. A collaboration needing
  its own custody is a Team (§5).
- **Policy fields are carried before they are all enforced.** v1 enforces sharing policy where the
  projection path already enforces it (the field-domain floor: unclassified fails closed); ceilings
  like retention and AI-use are recorded, surfaced, and audited but not yet gated. Recorded ≠
  enforced is stated in the UI, because a comment asserting an unenforced property is the thing
  AGENTS.md forbids.
- **No resource-fabric UX in v1.** `adoptedResource` is carved; Home's discover/license library and
  the provider integrations (the review's §6 table) are their own spec.
- **Affiliation is not membership; binding is not authority; responsibility is not capability;
  representation is not custody.** Each pair stays distinct; no resolver may flatten any of them.
- **No domain concepts.** People Group, Engagement, Circle/Church, Mission Field stay in the
  domain profile (`~/engage`), which gains from this spec exactly the classes the review asked it
  to stand on: TeamAgent, Workspace, WorkspaceRepresentation, ResponsibilityAssignment,
  `focusedOn`, `withinWorkspace`.

## 8. Waves

| Wave | Contents | Proof |
| --- | --- | --- |
| W0 | Ontology §4 complete: classes, cbox, crosswalk, SHACL + fixtures | fixtures pass/fail as designed, incl. policy-absent representation failing |
| W1 | Team-create ceremony + mandate + kind rows + switcher grouping (§6.2) | e2e: create team under charterer; team board/directory/DM work unchanged |
| W2 | Affiliations: records, propose/approve inbox flow, panel | e2e: two-steward engagement; one-sided proposal NOT current |
| W3 | Workspace records + create + participants + scoped boards/shelf (§6.3) | e2e: restricted workspace invisible to a non-participant member |
| W4 | Representations + coordinator delegation + app bindings (§2.2, §2.4) | e2e: representation lists with policy; expires; unbinding app removes presence only |
| W5 | Responsibilities: records, accept flow, Home view (§6.5) | e2e: proposal→accept; visible to responsible + accountable, absent to others |
| W6 | Relying surface: ops, Commons badges, Gather27/field-web migration path (§6.6) | extend `commons-*` Playwright; Gather27 reads its workspace from Home |

## 9. Open questions

1. **Public names for teams** — same rule as any agent (public name optional, directory label
   always; the 341 nameless-member pattern covers nameless teams)? Draft position: yes.
2. **Joint-charter governance** — v1 stores N chartered affiliations + N mandates; threshold /
   multi-party governance over the team SA itself (spec 207 custody policy) is a natural W7 needing
   its own ceremony design.
3. **Coordinator skill surface** — should `workspace.*` A2A skills be standardized in the catalog
   (as `gather.workspace` informally is) so any coordinator exposes the same card shape?
4. **Representation refresh** — pull (participant re-projects on change) vs push (coordinator
   subscribes)? The `at:` DataSubscription leg suggests push; v1 can ship pull-only.
5. **WorkingGroup residency** — simplest is a workspace with a `workingGroup` marker rather than a
   distinct record type. Decide at W3.
6. **Escalation paths on responsibilities** — deferred; is cadence + accountable agent enough for
   v1?
