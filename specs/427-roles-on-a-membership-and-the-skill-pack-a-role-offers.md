# Spec 427 — Roles on a membership, and the skill pack a role offers

**Status:** PROPOSED 2026-10-05; **W1 BUILT** the same day (`~/skills` 390e235: `composeDefinitions`, `POST
/context/compose`, five role packs published and composing live). Reviewed by the Home's other maintainer; §3.3 and
§5.2–5.4 carry the amendments. **Owner:** the Home (`apps/home` — the invitation and join ceremonies, the equip
step, the roster) and the agent runtime (`apps/agent-runtime` — the membership record). **First consumers:** the
field app (`~/engage`) and Field Operations (`~/pokernight`), never the subject.

**Depends on:** 324 (the organization ontology — §8 roles: a role definition is a template, a RoleAssignment is
materialized by Delegations and is never authority; §5 an invitation may propose role definitions), 325 (the
membership record `org.membership:member:<sa>`), 343 (vault-subject roles — the sign-and-revoke ceremony for a
role's access), 344 (team and workspace: a `.workspace` has no members; a team is an organization), 354 (one compiled
definition per agent, pinned by digest; behaviour is never authority), 368 (household facets on an invitation —
`role` there is a HOUSEHOLD role and stays one), ADR-0041 (a wire authorizes; nothing else does), ADR-0051
(capability is the canonical noun).

**Amends:** 354 §9.1 ("may an agent hold two archetypes? Proposal: no … composition happens in `~/skills` at authoring
time, keeping the runtime single-definition"). The runtime STAYS single-definition. What changes is WHEN composition
happens: at EQUIP time, by the registry's own compiler, from a base and the packs of the roles a person holds (§5).

---

## 1. The problem

A person belongs to an organization, and to teams, in some capacity: a field worker, a team lead, a coach. Today
that capacity exists nowhere the estate can read:

- **The membership record's role is a constant.** `org-membership.ts` writes `roleAssignment.assignedRole: 'member'`
  for everybody. The `role` an invitation carries is the household facet of spec 368.
- **The field app's roles are access roles only** (`member`, `field-recorder`, `community-steward`,
  `progress-steward`, `organization-steward`): what a person may read and write, issued by the `/vault-subject-role`
  ceremony. Nothing says what the person DOES.
- **A playbook is assigned by hand, per agent.** A person's agent holds one compiled definition
  (`archetype.assignment`). Nothing connects "she was invited as a field worker" to "her agent knows how to record
  field work". In Field Operations a script pins each character's playbook; in the field app nothing does.

So the role a person holds, the access that role needs and the skills that role needs are three unrelated facts
maintained by three different hands.

## 2. Decisions

**D1 — A role is a record on the membership that points at a role definition the organization owns.** Person ↔
organization and person ↔ team are the same structure, because a team is an organization (344). A `.workspace` has
no members and therefore no roles; roles hang on the organization that governs it.

**D2 — A role definition names two things and confers neither.** (a) the ACCESS the role needs, as the access role
whose delegations materialize it (the existing vault-subject roles); (b) a SKILL PACK — an archetype in the skills
registry — that the role offers the person's agent. The definition is declarative (324: "does not authorize
execution"). Authority is still only the delegation; behaviour is still only the playbook.

**D3 — Function and access are two axes, and the function is the one people see.** "What you do here" (field worker,
team lead, coach, partner liaison, coordinator) is the role. Each definition carries a DEFAULT access role; a
steward may issue more or less access through the 343 ceremony without changing the role.

**D4 — The organization assigns; only the person equips.** An organization may name a role, and sign the
delegations it needs. It may not write a person's playbook: `archetype.assignment` is writable by the agent's own
custodian (`isSelf || isSteward`), and this spec adds no other writer. The pack is OFFERED at join and the person
accepts it — one press, no signature beyond their session — or joins without it. Equipping writes the playbook and
nothing on chain (§5.4).

**D5 — One definition per agent, composed.** A person's playbook is their BASE (the default archetype for their
agent type, or whatever they chose) plus one PACK per active role assignment. The composition is done by the
registry's compiler from compiled, digest-pinned parts, and the result is one `AgentHarnessDefinitionV1`, validated
and pinned exactly as today. The runtime loads one record and knows nothing of packs.

**D6 — Every pack is recorded against the assignment that added it.** The assignment record keeps `composedFrom`:
the base and each pack with the organization, role and membership it came from. Removing a role removes exactly its
pack; a tool two packs both offer survives the loss of one.

**D7 — Not in this spec.** Loading only the pack of the organization a request is about (it needs the runtime to
choose per request; revisit when people commonly hold three or more roles). A member reading the ORGANIZATION's own
assistant playbook (the equip screen shows the PACK, which is public in the registry). Posts (`aporg:
OrganizationalPost`) — single-holder positions — stay unbuilt until something needs one.

## 3. The model

### 3.1 The role definition

Ring 0 already has the type (`packages/organization` `OrganizationRoleDefinition`: id, defining organization, name,
description, version, `allowedScopeKinds`, `authorityTemplateRefs`, `entitlementTemplateRefs`). It gains one field
and the ontology one property:

```ts
/** The skill packs this role offers the agent of whoever holds it — registry references, never content. */
skillPackRefs?: Array<{ context: string; archetype: string; version?: string }>;
```

`aporg:offersSkillPack` — domain `aporg:OrganizationRoleDefinition`, range `aps:AgentArchetype`. "Offers", because
the person decides (D4).

What crosses the wire and is stored is a SNAPSHOT of the definition, not a pointer the reader must chase:

```ts
interface RoleOfferV1 {
  type: 'ap.org.role-offer.v1';
  roleDefinitionId: string;          // `roledef:<org>:<slug>@<version>` — the organization's own id
  name: string;                      // "Field worker"
  description: string;               // one or two sentences a person reads before accepting
  scope: 'organization' | 'team';
  /** The access role whose delegations materialize this role, in the issuing app's vocabulary (343). Explains; never authorizes. */
  accessRole?: string;
  skillPackRefs: Array<{ context: string; archetype: string; version?: string }>;
}
```

WHERE an organization keeps its catalogue of definitions is the organization's app's business — the field app keeps
them as records in the governing organization's library, exactly as it keeps `role-assignment` (324: "held in the
organization's own vault"). The Home needs no catalogue: an invitation carries the offer.

### 3.2 On the invitation

`org.invite:agent:<sa>` gains `orgRole?: RoleOfferV1`, beside — never instead of — the household `role` of 368. The
steward's `/connect/org-invite/agent` body takes `orgRole`; it is validated for shape (ids and strings only, no key
that could be read as authority) and stored. The has-member relationship offer's `terms.role` carries the role's
`name` slug instead of the constant `'member'`.

### 3.3 On the membership

`ap.org.membership.v1` `roleAssignment` becomes:

```ts
roleAssignment?: {
  assignedRole: string;                 // the role's slug ('field-worker'); 'member' when no role was offered
  roleDefinitionId?: string;
  roleName?: string;
  scope?: 'organization' | 'team';
  accessRole?: string;
  skillPackRefs?: Array<{ context: string; archetype: string; version?: string }>;
  assignedBy?: string;                  // the steward who issued the invitation
  assignedAt?: string;
  materializedByDelegation?: unknown;   // unchanged
  householdRole?: string; kinRelation?: string;   // unchanged (368)
};
```

It is written where it is written today — by the MEMBER's own join (`org.recordMembership`, the member's session,
the member's signed grant) — from the offer on the invitation the organization stored. The object checks that the
role being recorded IS the one on the organization's own invite record for that member: a member cannot join as a
role they were not offered. No new vault record type, no new scope, no grant re-issue.

BOTH RECORDS LIVE ON THE ORGANIZATION, and for a governed workspace that is its GOVERNOR (344; the 2026-10-02
rule): `org.recordMembership` already refuses a `.workspace` with `not_an_organization` and names the governor, so
the invitation, the role and the membership of a workspace's people are the governing organization's records.

A role CHANGE is a steward act on the same record (`org.setMemberRole`, steward-gated like `org.endMembership`): it
replaces the role fields, keeps the delegation, and tells the member (a message with the new offer).

### 3.4 On the roster

Every roster read returns the role: the context package's `organization.membership.list` already reads
`roleAssignment.assignedRole`; the Home's member roster and `/connect/related-orgs` projection carry `roleName` and
`assignedRole` from the record. A relying app shows roles without a second lookup.

## 4. The ceremonies

| Moment | Who acts | What happens |
|---|---|---|
| **Invite** | a steward | picks a role from the organization's catalogue (the inviting app supplies the offer); signs the access grant as today; the invite record stores `orgRole` |
| **Join** | the invitee | sees the role — name, description, what its access lets them do, what its pack adds — and joins; the membership record carries the role |
| **Equip** | the invitee | offered once, at join and afterwards on their Playbook page: "Equip my agent for Field worker at Weld Corridor Team". Accepting composes and writes their playbook (§5). Declining changes nothing; the membership stands |
| **Access** | a steward | the role's default access role is issued through the existing 343 ceremony (`/vault-subject-role`), which records the digests it produced. Unchanged by this spec except that the form opens on the role's default |
| **Change** | a steward | `org.setMemberRole`; the member is offered the new pack, and equipping REPLACES the old pack for that organization |
| **End** | steward or member | `org.endMembership` as today; the cascade plan (`planMembershipRevocationCascade`) revokes the delegations. The member's Home, which holds the playbook, drops that organization's pack the next time it reconciles (§5.3) |

## 5. Composing a playbook

### 5.1 Where

In the skills registry, by its compiler — the one place a definition is made (354 §9.1 stands: composition lives in
`~/skills`). The registry gains one route:

`POST /context/compose { base: Ref, packs: Array<Ref & { as?: string }>, version? }` →
`{ definition, digest, parts: Array<{ ref, digest }>, warnings }`

where `Ref = { context, archetype, version? }`. Each part is compiled exactly as `GET …/definition` compiles it, and
the parts are merged by one pure function in `@skills/archetype-compiler`, `composeDefinitions`:

- `instructions` — the base's, then for each pack a heading (`## As <as ?? pack label>`) and the pack's.
- `tools` — union by tool id, base first. A tool two parts both declare is kept ONCE, from the first part that
  declares it; its `source` is unchanged.
- `requiredMandateTypes`, `approvalPolicyRefs`, `retrievalQueries`, `evidenceRequirements` — sorted set unions.
- `specialists` — one per capability, base first. `triggers` — concatenated, de-duplicated by id.
- `declaredEffects`, `domainLexicon`, `domainRecords`, `planTemplates` — merged by key, base first.
- `sourceCommitments` — the union, plus `part:<context>/<archetype>` → that part's digest for every part.
- `archetypeId` — `<base id>+<pack ids, sorted>`; `archetypeVersion` and `applicableAgentTypes` — the base's.

A pack that does not apply to the agent's type is refused by name. The result must pass
`validateAgentHarnessDefinition`; a composition that does not is an error, never a partial playbook.

### 5.2 What the Home writes

The same record, by the same op, under the same gate (`channels.archetypeAssignment.put`, self or steward):

```ts
{ type: 'ap.archetype-assignment.v1', archetypeId, archetypeVersion, definitionDigest, definition,
  composedFrom: {
    base: { context, archetype, version, digest },
    packs: Array<{ context, archetype, version, digest,
                   organization: string, roleDefinitionId: string, roleName: string, equippedAt: string,
                   equippedBy: string, equippedAs: 'self' | 'steward' }>,
  } }
```

The loader (`packages/harness` `loadPlaybook`) reads `definition` and `definitionDigest` and ignores the rest, so no
runtime change is needed. A playbook somebody edited by hand (no `composedFrom`) is the base of the first
composition, kept by reference when the registry still serves it and refused — with the reason said — when it does
not: equipping never silently replaces a hand-made playbook.

`equippedBy` / `equippedAs` say WHO pressed. The gate stays `isSelf || isSteward` — a steward equips an agent they
custody (a service, a character in a game) — but the record and the Playbook page say when somebody's agent was
equipped by its steward rather than by them.

A composed playbook's `archetypeId` is `<base>+<packs>`, which no registry archetype carries, so the Playbook page's
"a newer version is published" check cannot match on it. For a composition it compares EACH PART: the digest in
`composedFrom` against what the registry compiles for that reference now.

### 5.3 Reconciling

The person's Home recomposes when the set of packs it SHOULD hold differs from `composedFrom.packs`: on equip, on a
role change, and when a membership the person holds has ended or lost its role. The set is read from the person's
own memberships: their links say which organizations, and each organization answers for ITS record of them through a
member-self read on its own object — `org.membership.mine`, gated like `org.endMembership`'s self branch (the session
must be the member; it returns that member's record and nothing else). A person cannot read an organization's vault,
and does not need to. A pack whose membership ended is dropped; nothing is ever added without the person's press.

### 5.4 The card catches up; equip does not write it

Equip writes the playbook. It does NOT write `atl:capabilities`: that is an on-chain profile write needing the
person's signature (which D4 promises equip will not ask for), and what a card advertises comes from a Card Studio
release bound to the playbook (354 K6) — never from a second hand editing the capability list. So after equipping,
the Playbook page says what it already says of any private playbook — "your card does not advertise this yet" — and
names the capabilities the new pack offers that the card lacks, with the one link to release a card bound to it.
Until then the person's own asks reach the pack's tools; another agent asking for a capability the card does not
advertise is told so.

## 6. Invariants

1. A role name authorizes nothing. No gate reads `assignedRole`, `roleName` or `accessRole` (324; ADR-0041).
2. An organization cannot write a person's playbook. The only writers of `archetype.assignment` are the agent's own
   custodian and steward, as before.
3. A member cannot record a role they were not offered: the recorded role equals the invite record's.
4. One definition per agent, validated and digest-pinned; the runtime never sees a pack.
5. A pack is traceable to the assignment that added it, and leaves with it.
6. A role offer carries ids and words only — a key that could be read as authority is refused at the door.

## 7. The first consumers

**The field app.** Five default role definitions, created with a workspace in its governing organization and
inherited by its teams: field worker (`field-recorder`), team lead (`community-steward`), coach (`member`), partner
liaison (`member`), coordinator (`progress-steward`). Its invite forms send the offer; its rosters show the role;
the access ceremony opens on the role's default. Packs are `role-field-worker`, `role-team-lead`, `role-coach`,
`role-partner-liaison` and `role-coordinator`, registered in the `field-operations` context beside the real
`field-worker` archetype (`field-circles` has no recorded owner and refuses writes; `register-field-roles.mjs` moves
them with one variable once it has one).

**Field Operations.** A character's playbook becomes its character sheet (the base) plus the pack of its part. The
season writes real roles as it plays: founding a team makes the founder its lead, an invitation carries the role,
joining records it, and the character's playbook is composed from its memberships instead of pinned by a script.

## 8. Waves

| Wave | Where | What |
|---|---|---|
| **W1** | `~/skills` | `composeDefinitions` in the compiler; `POST /context/compose`; the five field role packs published |
| **W2** | `apps/agent-runtime`, `apps/home` | `orgRole` on the invitation; the role on the membership record, checked against the invite; `org.setMemberRole`; `org.membership.mine`; the role on roster reads |
| **W3** | `apps/home` | the role on the join screen; the equip step and the Playbook page's "Roles" section; `composedFrom` with who equipped; per-part freshness; "your card does not advertise X yet"; reconcile |
| **W4** | `~/engage` | the role catalogue, the offer on invites, roles on rosters and in Ask |
| **W5** | `~/pokernight` | the season writes roles; characters composed from sheet + pack; the walks check both |
| **W6** | `~/agenticprimitives/packages` | `skillPackRefs` on `OrganizationRoleDefinition`, `proposedRoleDefinitionRefs` on `MembershipInvitationV1` (324 §5), `aporg:offersSkillPack`, the membership binding's new fields |

W6 is the Ring 0 statement of the model and can land at any point: W1–W5 ride the flat records the apps already
write and need no package release.

## 9. Open questions

1. **Scoped loading (D7).** When does one playbook holding every role's pack become too much? Measure tool-list
   size and wrong-pack selections once people hold several roles.
2. **A role without a join.** A founder (`{ role: 'founder' }` in the charter credential) never passes through an
   invitation. Does the charter write a role, and which definition does it name?
3. **Equip on behalf of a custodied agent.** A steward may write the playbook of an agent they steward. For a
   character in a game that is how it must work; for a person's own agent it must never be used. Is the existing
   `isSteward` gate enough, or does equip need to say which it is?
