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
  cannot substitute, and GCP is not an option — **this org uses no Google KMS keys anywhere**; the
  gcp-kms code paths stay in the tree and are never configured, so a 501 naming `GCP_SERVICE_ACCOUNT_JSON`
  means "no KMS backend is configured here", never "add a GCP credential". The local KEK cannot substitute
  because wrangler's esbuild constant-folds `process.env.NODE_ENV === 'production'` to `true`, so
  `localKekEnabled` refuses in ANY deployed Worker — it is a `wrangler dev` path and nothing else.

  **It needs its OWN tenant, `imb`.** An AKCS tenant is a derivation root — "MAC keys are derived from
  the tenant root" (apps/vault/wrangler.toml) and the custody seed lives there too. A tenant is therefore
  an ESTATE boundary. `faithnet-b` and `skills-a2a` share tenant `faithnet` because they are a second
  deployment OF faithnet and a service WITHIN it; imbnet is neither. Its whole defining property is that
  its persons are different Smart Agents from faithnet's, which comes from a separate custody root —
  putting its keys under faithnet's seed would dissolve exactly that.

### Putting imbnet on AKCS

A NEW tenant, `imb`, with its own callers. On the Azure CVM (Bastion/JIT), as the AKCS pilot operator:

```
akcs operator create-tenant --tenant imb
akcs operator bind-caller --tenant imb --subject imb-vault   --operations data-key-generate,data-key-unwrap,mac-generate --protection-levels CVM_WRAPPED,CVM_DERIVED
akcs operator bind-caller --tenant imb --subject imb-runtime --operations mac-generate                                   --protection-levels CVM_WRAPPED,CVM_DERIVED
```

**NO `AZURE_HSM_DIRECT` ON EITHER CALLER — that is the one that costs money.** An HSM-direct key is a real
Azure Key Vault HSM key and is billed per key; `CVM_WRAPPED` and `CVM_DERIVED` are derived inside the
confidential VM from the ONE root and cost nothing per agent. Every per-person vault KEK and every service
MAC here must be derived, never HSM-direct. Leaving the level off the caller is what makes an accidental
billable key impossible rather than merely discouraged — a caller cannot ask for a protection level it was
not bound for. (`skills-a2a`'s key is `CVM_WRAPPED`; its caller was bound permissively and did not have to be.)

(Confirm the operator verbs against the AKCS CLI's own help — `create-tenant` is the shape this repo
needs, not necessarily the spelling it uses.)

Each caller is scoped to what that Worker actually does, the way skills-a2a's is ("a leak of this worker's
token can ask for one public key and one kind of signature"):

| caller | needs | why |
| --- | --- | --- |
| `imb-vault` | `data-key-generate`, `data-key-unwrap` | the per-person KEK envelope — the thing that is 501 today |
| both | `mac-generate` | the A2A→MCP service MAC; both halves of the hop must agree on the mechanism |
| `imb-runtime` | nothing else | its relay signs locally and its custody root stays local-aes |

Then `scripts/adopt-akcs.sh imbnet <vault-token-file> <runtime-token-file>` and follow what it prints. It
sets `AKCS_ACCEPTED_PROTECTION_LEVELS=CVM_WRAPPED,CVM_DERIVED` on both Workers, so a key that came back
HSM-direct would be REFUSED at the client as well — the cost guard holds at both ends.

**`A2A_CUSTODY_KMS_BACKEND` stays `local-aes`.** A person's home is a CREATE2 address over their derived
custodian; moving the custody root derives a different, empty Smart Agent and locks out everyone who
already signed in. Only the vault KEK and the MAC move onto AKCS, under tenant `imb`. faithnet carries the
same staged-cutover note for the same reason — and when imbnet's custody does move, it moves to `imb`,
never to `faithnet`, or every imbnet person's address changes.
