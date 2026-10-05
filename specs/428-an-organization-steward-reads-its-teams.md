# Spec 428 — An organization's steward reads what its teams hold

**Status:** W1 + W2 + W3 built and live, 2026-10-05 (W1 backfilled for the field realm’s four teams; W2 in `~/engage` 8eb83ce — §6.1), and the team’s BOARD admits the same reader, read-only (§6.2). **Owner decision:** "yes to 3" (the Home developer's list, item 3).
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

### 6.1 W2 as built (`~/engage` 8eb83ce)

The gateway's roll-ups (`workspace-circles`, `workspace-progress`) already read a team through `workspaceVault`, which
presents the `via:'governed'` row's grant. Three readers did not, and now do:

- **`field.records-list`** was steward-only, so a board named a circle from the roll-up and was then refused its
  record. A caller who does not steward the organization but holds a content grant for it — this grant, or their own
  member access grant (`reader-grant.ts`; the roster wire alone is not one) — lists a kind's folder READ-ONLY. The
  answer says so (`readOnly`, `readVia: 'governed' | 'member'`), keeps back what must not leave the vault (rosters,
  grant indexes, L5 — `keptBack` counts them; D2), and a grant that reads no catalog stays the steward's refusal with
  how far the reader got (`reader: 'no-relationship' | 'no-content-grant' | 'grant-reads-no-content'`). Writes are
  unchanged: still stewardship.
- **`workspace-progress`** learned whom a body serves only from the body's own vault. A body sealed to the reader
  takes it from its steward team's genealogy record (`communitiesSource: 'team-record'`), so Progress counts a team's
  circle for the organization's steward. The body's own vault stays sealed (§7.2).
- **`workspace-circles`** prefers that exact record over the coarse list of every people the team works with.

The board shows such a row with all its detail and no edit. Proven live by `~/pokernight`
`scripts/walk-field-org-steward.cjs`: Nathan (steward of the organization, on none of Weld, Plains or Larimer) reads
Weld's circle with its people and count; the team's roster is kept back; Bob, neither on the team nor a steward of
the organization, is refused and told why.

### 6.2 The board is a second door, and the same reader reads it (owner, 2026-10-05)

A team's DISCUSSIONS are not read from its vault by a reader: they are served by its board (`channels.list` /
`channels.read` on the team's own object), which admits people who are IN the community — a listing, stewardship of
the team, a member access grant, the team's membership record, or membership of a governing organization (a workspace
only). The organization's steward is none of those, so W1–W3 left them reading a team's circles and being told
"join this community first" on its Discussions, although D2 names the discussion families in the grant. The owner's
decision: they read the conversations too.

`governedBoardReader` (agent-runtime) is that door. The caller presents `governedRead: { grant, stewardship }` and the
team's object checks BOTH against the chain:

- `grant` — this team → an organization, a vault-record-scope READ that names `conversation.index`, live and
  unrevoked (`hasScopedAccess` with the organization as the delegate);
- `stewardship` — THAT organization → the caller, a stewardship wire by shape and by chain. A member of the
  organization is not its steward (D3) and is refused.

What it gives is deliberately less than admission:

- **Read only.** It is NOT one of `communityPresence`'s proofs. Only the board READ consults it, and only after
  presence has refused; every op that writes (post, react, create, the assistant, a local name) still asks for
  presence, which this reader does not have. The answer carries `readOnly: true, readVia: 'governed'`.
- **Open topics only.** The reader is served what any member of the team may see and nothing a RESTRICTED topic
  holds — not its descriptor, not its messages, and not their bodies when asked for by id.
- **Nothing is written for the reader**: no Welcome topic is created by their look, and the team records nothing
  about them.
- **The team closes it.** Revoking the team → organization grant (§5) closes this door with the vault's.

In the field app (`~/engage`): the gateway picks the two proofs out of the caller's own roster (`governedBoardProofOf`
— the governed row's grant, and the caller's stewardship wire for the governor) and sends them with every board read;
Discussions shows the open conversations with no composer, no reactions and no "new"; and a reader is told that
Attention is worked out for a team's stewards instead of being shown a refusal. Somebody who is not on the team and
does not steward its organization is told so plainly, where the screen used to say "usually momentary — try again".

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
