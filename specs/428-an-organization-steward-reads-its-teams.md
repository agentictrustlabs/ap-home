# Spec 428 — An organization's steward reads what its teams hold

**Status:** W1 + W3 built, 2026-10-05 (W1 backfilled for Boulder–Longmont 0xf98d…; W2 is the field app’s). **Owner decision:** "yes to 3" (the Home developer's list, item 3).
**Builds on:** spec 424 (a member reads the governed workspace through the governor — approach B), spec 344 (team ⊑
organization; the hub: `org → { members, teams, workspace }`), ADR-0055 (the vault is the record), ADR-0056
(resolution is not authority), ADR-0041 (Web3 authority; a projection authorizes nothing).

## 1. The problem

Nathan stewards the field realm's organization and custodies its workspace. A team affiliated with that organization
(`Weld Corridor Team`, `Boulder–Longmont Team`) keeps its own records in its own vault — its circles' detail, its
progress records, its library. When Nathan is not on a team, the field app can only show its circles as pointers and
its Progress counts as 0: the field gateway reads an agent through the reader's Home row for it (`orgWire`), and the
reader holds no grant from a team he is not on. Stewarding the organization the team belongs to gives him nothing to
present to the team's vault.

## 2. Decisions

**D1 — The team grants its ORGANIZATION a content read of itself.** At team charter (and by backfill for existing
teams) the team signs a 0x03-approved read delegation `team → org` over its CONTENT families only — exactly spec
424's shape one level down (424 §2.4 B, approach B). Never a per-steward grant: the organization is the hub, and a
grant to the hub is one record per team, revocable in one place.

**D2 — Content only.** The scope is `GOVERNED_CONTENT_SCOPE` (`lib/workspace-governor.ts`): `content.catalog`,
`content.artifact.*`, the discussion families and `coordination.*` — the same families 424 opened for a workspace.
Never the team's custody, its membership records, its relationships, its playbook or a member's private records.

**D3 — Read by the organization's STEWARDS, not its members.** The Home surfaces the grant only on the org-steward's
view (a synthesized `via:'governed'` row for a team the steward does not already hold). Members of the organization
keep reading only the teams they are on. Widening this to members is a separate decision (§7).

**D4 — The grant is evidence the vault re-verifies, never authority the Home asserts.** The Home's
`org-teams:<org>` projection (KV, rebuildable — 424's `org-workspace:<org>` pattern) carries the grant to the reader;
the field gateway presents it to the team's vault, which verifies the delegation chain and its record scope exactly
as it does the 424 workspace grant. A bogus projection authorizes nothing.

**D5 — Signed by the team's own custodian.** The grant is signed AS THE TEAM (its approveHash, through
`/harness/authorize` under the team's steward), at charter by whoever charters it, and in backfill by each team's
steward. The organization's steward cannot mint it on the team's behalf unless they also steward the team.

## 3. The records

| Where | Key | What |
| --- | --- | --- |
| chain | the grant's digest, approved AS THE TEAM (`approveDigest`) | the authority: a sentinel (0x03) delegation is valid exactly while its digest is approved and unrevoked |
| Home KV | `org-teams:<org>` | `{ governor, teams: { <team>: { teamName, grant, createdAt } } }` — the serving projection that carries the grant wire to a reader |

As in 424 W1, the team's vault gains no record in W1: a `team.governorRead` mirror would need a record scope the
team's interactions grant does not carry, and nothing reads it. If the projection is lost, re-running the backfill
mints and approves a fresh grant (the bereavement test passes: the loss is a re-mint, not a lost record). A vault
mirror can follow when a reader needs the team's own statement (§7).

## 4. The flow

1. **Charter / backfill.** Build `buildApprovedOrgReadDelegation(team, org, { server: MCP_SERVER_ID, resources:
   GOVERNED_CONTENT_SCOPE })`; approve its digest on chain AS THE TEAM; `POST /connect/related-orgs { orgAgent: org,
   governedTeam: { team, teamName, grant } }` (caller must steward `org`).
2. **Resolve.** `GET /connect/related-orgs` — for each organization the person STEWARDS, read `org-teams:<org>`; for
   each team she does not already hold, synthesize `{ orgAgent: team, kind: 'team', relationship: 'member', via:
   'governed', governor: org, parent: org, readGrantDelegation: grant }`. Discovery only; never written into her
   authoritative relationships.
3. **Read (field, W2 — the other developer's repo).** `orgWire` already admits a `via:'governed'` row carrying a
   `readGrantDelegation`; the team readers (`team-sources`, the circles/progress views) read the team's content with
   it, as `readGovernedWorkspaceContent` does for the workspace.

## 5. Revocation

The team's steward revokes the grant on chain (the delegation manager's `revoke(digest)`), and the team vault refuses
it from that moment. The projection is then stale and harmless; the next charter/backfill rewrites it, and a
`governedTeam` write with `grant: null` removes the team from the projection.

## 6. Waves

| Wave | Where | What |
| --- | --- | --- |
| **W1** | `ap-home` | `GOVERNED_CONTENT_SCOPE`; the `governedTeam` projection write + the steward-row synthesis in `related-orgs`; `org-teams` in the KV allowlist; `scripts/backfill-428-team-read.mts`; run for the field realm's teams |
| **W2** | `~/engage` (field) | team/circle/progress readers use the `via:'governed'` team row's grant |
| **W3** | `ap-home` onboarding | mint the grant at team charter (the Home's team-create ceremony), so new teams need no backfill |

## 7. Open questions

1. **Members of the organization.** Should every member read every team's content (the 424 rule for the workspace)?
   Not decided; D3 keeps it to stewards.
2. **Teams of teams.** A circle under a team is the team's (the field app treats circles as the team's holdings);
   whether a circle grants its team the same read is out of scope until a circle keeps records of its own.

## Reference: smart-agent patterns to port

smart-agent (branch `003-intent-marketplace-proposal`) models an organization's view of its sub-units through the
org's admin delegation reaching child agents it created; here a team is its own Smart Agent with its own custodian,
so the reach is a grant FROM the team TO its organization rather than an admin key over it — the deliberate divergence
keeps a team's records the team's (ADR-0055), revocable by the team.
