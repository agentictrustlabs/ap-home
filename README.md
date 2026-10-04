# ap-home — Home

**Home** is the product where a person, an organization or a service governs its own agent: the agent runtime
(A2A over HTTPS, the harness that turns an Ask into an Intent, a Mandate, a Plan, per-step verification and a
receipt), the vault that is the record, the admission edge in front of them, the Home MCP that lets Claude.ai reach
the person's agent as the person, and the Home web app that makes the one rule legible on every screen:

> being a participant does not authorize an action; the requested effect must be within the acting principal's
> current, scoped delegation.

Ring 0 — [`agenticprimitives`](https://github.com/agentictrustlabs/agenticprimitives) — keeps the packages, the
contracts and the Developer Kit. This repository is a **product** on published `@agenticprimitives/*` packages
(ADR-0063, [spec 399](https://github.com/agentictrustlabs/agenticprimitives/blob/master/specs/399-repository-split-program.md) W2),
extracted with history from Ring 0 by `scripts/split/extract-ap-home.sh` (the commit is named in `git log`).

## One estate — Home on faithchain

This repository deploys **one** estate: Home on faithchain (chain 34348) — five Workers named `home-*` on `faithnet.io`
hosts and the Home on Vercel — `[env.production]` in every `wrangler.toml`. **It does not deploy Faithnet**: Faithnet
(`www.faithnet.me`, `demo-*-faithnet`) is Ring 0's deployment of the same apps, and the Base Sepolia `production` estate
(impact-agent) with its treasury Workers and relying-app examples is not here either. `DEPLOYER.md` says which name
means what and who deploys what; `deploy/estate.json` lists the estate's names and ids.

## What is here

| Path | Was, in Ring 0 | What it is |
| --- | --- | --- |
| `apps/home` | `apps/home` | the Home web app (Next.js): Today · Work · attention · Library · Build, the Ask flyout, the Playbook ceremony, the Card Studio, approvals |
| `apps/agent-runtime` | `apps/agent-runtime` | the agent runtime Worker: `InteractionsDO`, `A2aTaskDO`, the harness, the gateway mount, the standard A2A surface |
| `apps/vault` | `apps/vault` | the vault: the person's / org's records behind delegated MCP (ADR-0055 — the vault is the record) |
| `apps/home-mcp` | `apps/home-mcp` | Home MCP — Claude.ai as a client of the person (spec 397) |
| `apps/edge` | `apps/edge` | the admission edge (ADR-0057): HTTPS required, mTLS optional, admission always |
| `apps/rpc-gateway` | `apps/rpc-gateway` | the chain RPC gateway Home's Workers read through |
| `scripts/` | root `scripts/` (the Home subset) | secrets (`ENV=production`), local dev vars, provisioning, the live gates (`scripts/live-gates.json`), every `verify-*` gate, the census; each Worker deploys with `wrangler deploy --env production` from its directory |
| `demo/` | `demo/` | the estate roster and deployment placements (→ `@agenticprimitives-demo/estate`, 399 §2.6) |
| `docs/architecture/` | the product docs | harness architecture, outside-in flow, inbox UX synthesis, the UX product brief, **the Home census** |
| `specs/398-…` | `specs/398-…` | the UX strategy this repository carries out: Home Work · Home Build · the Developer Kit |

Worker names are the estate's own (`home-runtime`, `home-vault`, `home-edge`, `home-mcp`, `home-rpc` — new Workers, fresh
Durable Objects); DO classes and migration tags are the code's and never change. `DEPLOYER.md` has the map.

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
