# DEPLOYER — who deploys what

**This repository deploys Faithnet: the Home at `www.faithnet.me` and the Workers behind it, on faithchain.**
(The owner's decision, 2026-10-04: ap-home becomes the one place faithnet deploys from; Ring 0 —
`agenticprimitives` — keeps packages and contracts only. This supersedes the 2026-09-12 shape, in which this
repository deployed a separate `home-*` estate and "never Faithnet".)

Three names, three things — never one word for two of them:

| Name | What it is | Where it appears |
| --- | --- | --- |
| **faithchain** | the chain (Azure, id 34348, free gas, dev-mode paymaster) | `CHAIN_ID`, `RPC_URL`, the contract addresses — vars, never an env name |
| **Faithnet** | the deployment: `www.faithnet.me` + the `*-faithnet` Workers | `[env.faithnet]` in every Worker's `wrangler.toml` |
| **Home** / `ap-home` | this product and this repository | package names `@ap-home/*` |

Shared with other products on purpose: **discovery** (`discovery.faithnet.io` — the public KB, its own repository) and
the **AKCS pilot** (`akcs-pilot.faithnet.io`, the KMS operator's).

## The map

| Directory | Package | Worker (`[env.faithnet]`) | Host | Deployer |
| --- | --- | --- | --- | --- |
| `apps/home` | `@ap-home/home` | — (Next.js on Vercel, project `faithnet-home`) | `https://www.faithnet.me` | Vercel from `master` |
| `apps/agent-runtime` | `@ap-home/agent-runtime` | `demo-a2a-faithnet` | `a2a.faithnet.io`, `*.faithnet.ai/*`, per-agent hosts | `wrangler deploy --env faithnet` |
| `apps/vault` | `@ap-home/vault` | `demo-mcp-faithnet` | `mcp.faithnet.io` | " |
| `apps/edge` | `@ap-home/edge` | `demo-edge-faithnet` | `edge.faithnet.io` | " |
| `apps/home-mcp` | `@ap-home/home-mcp` | `home-mcp-faithnet` | `home-mcp.faithnet.io` | " |
| `apps/rpc-gateway` | `@ap-home/rpc-gateway` | `faithchain-rpc-gateway` | `rpc.faithnet.io` | " |

Every value lives in `[env.faithnet.vars]` — no `--var` injection. Dry-run first:
`wrangler deploy --env faithnet --dry-run --outdir <scratch>`. The runtime's Container image installs
`@agenticprimitives/runtime-member` + `acp` from npm at the versions pinned in `runtime-container/Dockerfile`.

Deploy order (each needs the one before it reachable): rpc-gateway → vault → agent-runtime → edge → home-mcp → the Home.

## Rules

- **Worker names, Durable Object class names, DO bindings and migration tags are NEVER renamed** — that orphans
  storage. They are the names faithnet has always deployed under (`demo-a2a-faithnet`, …); the directories were renamed,
  the deployment was not.
- **One deployer per estate.** Once faithnet deploys from here, nothing in Ring 0 deploys it again.
- `wrangler deploy` deletes triggers created out of band — custom domains and crons are declarative in `wrangler.toml`.
