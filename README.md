# ap-home — Home

**Home** is the product where a person, an organization or a service governs its own agent: the agent runtime
(A2A over HTTPS, the harness that turns an Ask into an Intent, a Mandate, a Plan, per-step verification and a
receipt), the vault that is the record, the admission edge in front of them, the Home MCP that lets Claude.ai reach
the person's agent as the person, and the Home web app that makes the one rule legible on every screen:

> being a participant does not authorize an action; the requested effect must be within the acting principal's
> current, scoped delegation.

Ring 0 — `agenticprimitives`, the private source monorepo, published as [`agentic-primitives`](https://github.com/agentictrustlabs/agentic-primitives) — keeps the packages, the
contracts and the Developer Kit. This repository is a **product** on published `@agenticprimitives/*` packages
(ADR-0063, spec 399 W2),
extracted with history from Ring 0 by `scripts/split/extract-ap-home.sh` (the commit is named in `git log`).

## The estates this repository deploys

An estate is one shape, stamped once per deployment: a Home, an agent runtime, a vault, an admission edge, a Home MCP,
its own key-service tenant and the chain it lives on. This repository deploys two:

| Estate | Home | Chain | Workers |
| --- | --- | --- | --- |
| **faithnet** | `www.faithnet.me` (Vercel project `faithnet-home`) | faithchain (34348) | `[env.faithnet]` — `demo-a2a-faithnet`, `demo-mcp-faithnet`, `demo-edge-faithnet`, `home-mcp-faithnet` |
| **imbnet** | `www.impact-agent.me` | hopechain (34349, a generation-3 chain) | `[env.impact-agent]` — `imb-runtime`, `imb-vault`, `imb-edge`, `imb-home-mcp` |

Ring 0 (`agenticprimitives`) keeps packages and contracts and deploys no app. `DEPLOYER.md` has the map. A person is a
resident of one estate; her treasuries, wires and credentials are bound to that estate's chain. Estates interoperate over
proof, through the federation ([`ap-federation`](https://github.com/agentictrustlabs/ap-federation)): neutral ground
where each estate anchors what it vouches for, and doors that admit a visitor on a proof read from the chain.

## What the Home can do

- **Three kinds of agent.** A person, an organization or a service is a Smart Agent on chain; names, cards and
  listings are facets of that address. A person charters organizations, teams, treasuries, households and service
  agents under her own agent.
- **The Ask.** One conversational surface drives everything the buttons drive: classify → resolve in the asker's
  private tier → preview → confirmation-as-signature → receipt. A chat "yes" never authorizes; the signature does.
- **Mandates.** Every act that changes anything runs under a mandate the acting principal signs, bound to the intent's
  digest, verified per step on chain, revocable one wire at a time. Reads run no gate.
- **Treasuries and payments.** Value lives only in treasuries; an organization pays from its own; a standing wire lets
  an agent pay a named payee up to a cap for a window; every settled payment leaves both parties a receipt.
- **Messaging, Library, routines, connectors.** Direct messages and topics between agents; the person's own Library
  with signed public releases; standing instructions and scheduled routines; GitHub, Calendar, Mail and any MCP server
  as connectors under her grant.
- **The Security section.** Sign-in by credential grade, sessions, recovery with trustees, the vault key, one grants
  list — a removal is a rotation or a recovery, never a quiet remove.
- **Anonymous credentials.** A member asks her organization for a credential through her own agent
  (`credential.request`: the public half of her device key, nothing else). The organization's own agent issues it
  (`credential.issue`) under its steward's mandate — reads its roster, its published issuer facet, signs through the
  key service's issuing key, records the issuance without the claim values, vouches on its live-credential row, and
  delivers the credential into the member's vault by her own grant. The `org-issuer` playbook (the organization
  steward's set plus issuing) is assigned only to an organization that has published a facet. The member then proves
  facts about the credential in zero knowledge at a federation door, never showing it.
- **A person's agent at other services.** A service whose card declares the pairwise asker is asked under her
  per-service pseudonym, with no credential; a Home session never rides a routed ask to another host.

## What is here

| Path | Was, in Ring 0 | What it is |
| --- | --- | --- |
| `apps/home` | `apps/home` | the Home web app (Next.js): Today · Work · attention · Library · Build, the Ask flyout, the Playbook ceremony, the Card Studio, approvals |
| `apps/agent-runtime` | `apps/agent-runtime` | the agent runtime Worker: `InteractionsDO`, `A2aTaskDO`, the harness, the gateway mount, the standard A2A surface |
| `apps/vault` | `apps/vault` | the vault: the person's / org's records behind delegated MCP (ADR-0055 — the vault is the record) |
| `apps/home-mcp` | `apps/home-mcp` | Home MCP — Claude.ai as a client of the person (spec 397) |
| `apps/edge` | `apps/edge` | the admission edge (ADR-0057): HTTPS required, mTLS optional, admission always |
| `scripts/` | root `scripts/` (the Home subset) | secrets, local dev vars, provisioning, the live gates (`scripts/live-gates.json`), every `verify-*` gate, the census; the headless ceremonies — `create-organization-via-home.mts` (a person creates an organization at her Home), `put-issuer-facet.mts` (the steward publishes the organization's issuer facet), `assign-org-archetype.mts` (a playbook, e.g. `org-issuer`), `join-org-via-home.mts` (the Join chip, headless), `run-act-via-home.mts` (any act, with its mandate signed by the persona's Home), `link-own-agent.mts` (an agent linked to its holder in her private records, no public name), `enable-interactions-at.mts` (the storage and delivery planes on a deployment), `issue-self-host-vault-credentials.mts` (a scoped vault credential for a worker that writes as an agent); each Worker deploys with `wrangler deploy --env <estate>` from its directory |
| `demo/` | `demo/` | the estate roster and deployment placements (→ `@agenticprimitives-demo/estate`, 399 §2.6) |
| `docs/runbooks/new-estate.md` | **stand up another estate** — every command, in order, with what bit the second one (build 4 of [five](https://github.com/agentictrustlabs/agentic-primitives/blob/main/docs/builds.md)) |
| `docs/architecture/` | the product docs | harness architecture, outside-in flow, inbox UX synthesis, the UX product brief, **the Home census** |
| `specs/398-…` | `specs/398-…` | the UX strategy this repository carries out: Home Work · Home Build · the Developer Kit |

Worker names are the estate's (`demo-a2a-faithnet` …, `imb-runtime` …) — the directories were renamed, the
deployments were not; DO classes and migration tags never change. The services every estate on a chain shares — the
chain RPC gateway, the registry, the public graph, typed naming — are the town's, in
[`ap-town`](https://github.com/agentictrustlabs/ap-town): faithnet.town on faithchain, hopenet.town on hopechain.

## The UX program (spec 398)

Gate **G0 — the census** is here: `pnpm census` verifies `docs/architecture/home-census.json` against this tree
(every Home page route and harness endpoint claimed by a row whose status is earned by bindings that exist;
`pnpm census:md` regenerates the human projection). Then, in order: **G1** one governed work journey (Today, one
state vocabulary, cancel, the artifact-first inspector, attention filters, acting-as/in on every mutation);
**G2** shared workspace + developer entry; **G3** reuse + operations; **G4** Home Build
(the [`ap-build`](https://github.com/agentictrustlabs/ap-build) repository mounts into Home as a workspace mode);
**G5** federation + portability. Each gate exits on scripts, not screenshots (398 §12).

## Commands

```
pnpm install
pnpm doctor                     # ap doctor — the doctrine rules over this tree
pnpm doctor:rules               # drift between the projected rules and the pinned source
pnpm census                     # spec 398 G0 — the Home census as a gate
pnpm live-gates                 # scripts/live-gates.json against HOME_URL (nightly in CI)
pnpm conform:a2a https://…      # A2A 1.0 conformance of a deployment
pnpm conform:mcp https://…      # MCP conformance of a deployment
pnpm upgrade:pin <version>      # one coherent published set, then doctor
```

## Status

This repository is in the **parallel run** of 399 §5.5: the estate is deployed from here and the nightly live gates
run against it (the seven-night clock); the apps are still DEVELOPED in Ring 0 and this tree is re-cut from there
until each app's cut PR. `docs/split-status.md` is the honest list of what stands between here and the cut.

## Rules

`AGENTS.md`, `CLAUDE.md` and `.cursor/rules/*.mdc` are projected from Ring 0's `docs/architecture/agent-rules`
by digest (`ap doctor --rules`); the managed block is never edited by hand. The hard rules that bind this
repository most: the vault is the record and DO storage is a serving plane (ADR-0055); first-party web expresses
intents to the agent and never drives MCP directly (ADR-0044); money moves to treasuries only; one capability
model generates both the UX and the agent surfaces; behaviour is generated, authority never is.
