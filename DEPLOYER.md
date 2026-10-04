# DEPLOYER — who deploys what

**This repository deploys Home on faithchain. It does not deploy Faithnet.**

Four names, four things — never one word for two of them:

| Name | What it is | Where it appears |
| --- | --- | --- |
| **faithchain** | the chain (Azure, id 34348, free gas, dev-mode paymaster) | `CHAIN_ID`, `RPC_URL`, the contract addresses — vars, never an env name |
| **Faithnet** | Ring 0's deployment of these same apps (`www.faithnet.me`, `demo-*-faithnet`, `faithnet-b`) | NOT in this repository — its `[env.faithnet]` blocks are removed at extraction |
| **Home** / `ap-home` | this product and this repository | package names `@ap-home/*`, the Vercel project `home` |
| **the estate** | this repository's ONE deployment: Home on faithchain, `[env.production]` | every Worker's `wrangler.toml`; `deploy/estate.json` (names + ids, reference) |

What is faithnet's in the estate, on purpose: the **DNS zone** `faithnet.io` (the account's; Worker→Worker calls need a
custom domain, CF error 1042 — until the product has a zone of its own, its hosts are `home-*.faithnet.io`); the **AKCS
pilot** (`akcs-pilot.faithnet.io`, tenant `faithnet` — the KMS operator's namespace, and the caller identity the runtime
signs as is still faithnet's until the operator binds one for this estate: the open trust item); **discovery**
(`discovery.faithnet.io` — the public KB, world-readable by construction, another product's). Everything else is the
estate's own: Workers, Durable Objects, KV, D1, secrets, broker key, the Home, the people.

## The map

| Directory | Package | Worker (`[env.production]`) | Host | Deployer |
| --- | --- | --- | --- | --- |
| `apps/home` | `@ap-home/home` | — (Next.js on Vercel, project `home`) | `https://home-rho-orpin.vercel.app` | Vercel from `master` |
| `apps/agent-runtime` | `@ap-home/agent-runtime` | `home-runtime` | `home-a2a.faithnet.io` | `wrangler deploy --env production` |
| `apps/vault` | `@ap-home/vault` | `home-vault` (D1 `home-vault`) | `home-vault.faithnet.io` | " |
| `apps/edge` | `@ap-home/edge` | `home-edge` | `home-edge.faithnet.io` | " |
| `apps/home-mcp` | `@ap-home/home-mcp` | `home-mcp` | `home-mcp.faithnet.io` | " |
| `apps/rpc-gateway` | `@ap-home/rpc-gateway` | `home-rpc` | `home-rpc.faithnet.io` | " |

The vault's server id — the `server` every record-scope grant names and the `vaultId` a person signs in the vault-key
ceremony — is **`home-vault`** (`VAULT_SERVER_ID` on the vault and the runtime, `NEXT_PUBLIC_VAULT_SERVER_ID` on the
Home). A grant made to faithnet's vault (`demo-mcp`) satisfies nothing here, and the reverse.

Deploy order (each needs the one before it reachable): rpc-gateway → vault → agent-runtime → edge → home-mcp → the Home.
`docs/runbooks/estate.md` is the runbook; `docs/runbooks/home-vercel.md` the Home's.

## Rules

- **Durable Object class names, DO bindings and migration tags are NEVER renamed** — that orphans storage. Worker names
  were chosen once, when the estate was created (2026-09-12); they are not renamed either.
- Until the cut PR (spec 399 §5.6), the apps are still developed in Ring 0 (`apps/demo-*`) and this repository is
  RE-CUT from it (`scripts/split/extract-ap-home.sh` there) — `[env.production]` is DERIVED at extraction from Ring 0's
  `[env.faithnet]` by `derive-ap-home-env.py` with the names and ids in `ap-home-estate.json`. After the cut it is
  hand-maintained here and the derivation retires.
- Two deployers never both believe they own an estate: Ring 0 deploys Faithnet; this repository deploys the estate.
  Nothing here reaches a faithnet Worker, KV, D1 or the live Home.
