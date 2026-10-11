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

Every value lives in `[env.faithnet.vars]` — no `--var` injection. Dry-run first:
`wrangler deploy --env faithnet --dry-run --outdir <scratch>`. The runtime's Container image installs
`@agenticprimitives/runtime-member` + `acp` from npm at the versions pinned in `runtime-container/Dockerfile`.

Deploy order (each needs the one before it reachable): vault → agent-runtime → edge → home-mcp → the Home.

The chain RPC gateway (`faithchain-rpc-gateway`, `rpc.faithnet.io`) is a TOWN service: it serves every estate on
faithchain, and it deploys from [`ap-town`](https://github.com/agentictrustlabs/ap-town) (`apps/chain-gateway`) since
2026-10-05 (spec 429). The town's other services — the registry, the public graph, discovery — deploy from there too.

## Rules

- **Worker names, Durable Object class names, DO bindings and migration tags are NEVER renamed** — that orphans
  storage. They are the names faithnet has always deployed under (`demo-a2a-faithnet`, …); the directories were renamed,
  the deployment was not.
- **One deployer per estate.** Once faithnet deploys from here, nothing in Ring 0 deploys it again.
- `wrangler deploy` deletes triggers created out of band — custom domains and crons are declarative in `wrangler.toml`.

## imbnet — the town's second estate (2026-10-11)

Same chain (faithchain), same contracts, same town, same repository. Its own custody root, relay key,
interactions key, service agents, vault, Workers and Home — an imbnet person is a different Smart Agent
from a faithnet person of the same name, because a KMS-custodied home is a CREATE2 address over a derived
custodian and the roots differ. It has no zone of its own, so the default hosts ARE its addresses.

| Directory | Worker (`[env.imbnet]`) | Host |
| --- | --- | --- |
| `apps/home` | — (Next.js on Vercel, project `imb-home`) | `https://imb-home.vercel.app` |
| `apps/agent-runtime` | `imb-runtime` | `imb-runtime.richardpedersen3.workers.dev` |
| `apps/vault` | `imb-vault` | `imb-vault.richardpedersen3.workers.dev` |
| `apps/edge` | `imb-edge` | `imb-edge.richardpedersen3.workers.dev` |
| `apps/home-mcp` | `imb-home-mcp` | `imb-home-mcp.richardpedersen3.workers.dev` |

Bring up a new estate (or rebuild this one's keys, which orphans every account the old ones custody):

```
npx tsx scripts/bootstrap-estate.mts --estate <name>   # keys + the two service agents, on chain
scripts/set-estate-secrets.sh <name>                   # the secrets, each to only the Workers that share it
wrangler deploy --env <name> -c apps/vault/wrangler.toml   # then agent-runtime, edge, home-mcp
wrangler d1 migrations apply demo-mcp-<name> --remote -c apps/vault/wrangler.toml --env <name>
```

`.estate-<name>.local` (0600, gitignored) is the only copy of the custody root. Losing it loses every
person's home on that estate; copying it elsewhere copies the authority to be every one of them.

What imbnet deliberately does NOT have, each failing closed rather than quietly:
- **AKCS custody** — imbnet is NOT on AKCS yet, so the vault KEK path does not work at all: `POST
  /custody/vault-key/provision` answers 501 and every person's storage stays off. `DEMO_VAULT_LOCAL_KEK_SECRET`
  cannot substitute — wrangler's esbuild constant-folds `process.env.NODE_ENV === 'production'` to `true`, so
  `localKekEnabled` refuses in ANY deployed Worker. It is a `wrangler dev` path and nothing else.

  **It does not need an `imb` tenant.** The house pattern is one tenant, many least-privilege callers:
  `skills-a2a` and `faithnet-b` both sit in tenant `faithnet` with their own. imbnet needs two callers in
  that same tenant (see "Putting imbnet on AKCS" below), then `scripts/adopt-akcs.sh`.
- **A paid-name gate key** — `NAMING_GATE_PRIVATE_KEY` is the town clerk's, not an estate's, so registering
  a priced name from this Home refuses until the town issues imbnet a gate credential.
- **Mail** — no zone, so no inbound routing and no sending rail: an email invitation is refused, not dropped.
- **Google sign-in** — no OAuth client for this redirect URI; the demo and credential paths are the way in.


### Putting imbnet on AKCS

Two callers in the EXISTING `faithnet` tenant — not a new tenant. On the Azure CVM (Bastion/JIT), as the
AKCS pilot operator:

```
akcs operator bind-caller --tenant faithnet --subject imb-vault    --operations data-key-generate,data-key-unwrap,mac-generate
akcs operator bind-caller --tenant faithnet --subject imb-runtime  --operations mac-generate
```

Each is scoped to what that Worker actually does, the way `skills-a2a`'s caller is ("a leak of this
worker's token can ask for one public key and one kind of signature"):

| caller | needs | why |
| --- | --- | --- |
| `imb-vault` | `data-key-generate`, `data-key-unwrap` | the per-person KEK envelope — the thing that is 501 today |
| both | `mac-generate` | the A2A→MCP service MAC; both halves of the hop must agree on the mechanism |
| `imb-runtime` | nothing else | its relay signs locally and its custody root stays local-aes |

Then `scripts/adopt-akcs.sh imbnet <vault-token-file> <runtime-token-file>` and follow what it prints.

**`A2A_CUSTODY_KMS_BACKEND` stays `local-aes`.** A person's home is a CREATE2 address over their derived
custodian; moving the custody root derives a different, empty Smart Agent and locks out everyone who
already signed in. Only the vault KEK and the MAC move. faithnet carries the same note for the same reason.
