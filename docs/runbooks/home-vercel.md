# The Home on Vercel — project `home` (`https://home-rho-orpin.vercel.app`)

Root directory `apps/home`, builds `master` of this repository (root script `build:home`). A build that is Ready is not
a Home that is ready: the Home takes its whole identity from its environment — which chain, which runtime, which
vault, whose broker key, which KV. One Vercel project per estate; `home-mcp.vercel.app` (Vercel's Hono auto-detect of
`apps/home-mcp`, a Worker that cannot run there) is to be deleted.

## 1. Environment

The Home reads ~60 variables (chain, contracts, brand, coins, the other products' live services it reads and never
writes). The ones that name THIS estate — set them with the REST API (`POST /v10/projects/{id}/env?upsert=true`; the
CLI's `vercel env add` stores an empty value for a piped secret) and redeploy (`NEXT_PUBLIC_*` is inlined at build):

| Variable | Value |
| --- | --- |
| `NEXT_PUBLIC_HOME_ORIGIN`, `ALLOWED_ISSUER_HOSTS` | `https://home-rho-orpin.vercel.app` / `home-rho-orpin.vercel.app` |
| `A2A_CUSTODY_URL`, `DEMO_A2A_URL` | `https://home-a2a.faithnet.io` |
| `A2A_VAULT_URL` | `https://home-vault.faithnet.io` |
| `DEMO_EDGE_URL`, `NEXT_PUBLIC_DEMO_EDGE_ORIGIN` | `https://home-edge.faithnet.io` |
| `NEXT_PUBLIC_VAULT_SERVER_ID` | `home-vault` — the `server` of every grant the Home issues; the vault's and the runtime's `VAULT_SERVER_ID` |
| `NEXT_PUBLIC_HOME_MCP_ORIGIN`, `NEXT_PUBLIC_HOME_MCP_DELEGATE` | `https://home-mcp.faithnet.io` and the address of its `HOME_MCP_PRIVATE_KEY` |
| `A2A_CUSTODY_BRIDGE_SECRET` | the SAME value as `home-runtime`'s |
| `BROKER_PRIVATE_JWK`, `BROKER_KID` | the estate's own key (`node apps/home/scripts/gen-broker-key.mjs`, Sensitive); the runtime's `BROKER_ISS`/`BROKER_JWKS_URL` name this Home |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | the estate's own Upstash store (`home-shadow-kv`, connected through Vercel Storage) |
| `DEMO_PERSONA_KEYS` | the estate's roster (§3) |
| `GOOGLE_REDIRECT_URI` | `…/oidc/google/callback` here, registered in the Google console — or Google sign-in off |

`curl https://home-rho-orpin.vercel.app/jwks` answers with the broker key; `/.well-known/agentic-home` answers.

## 2. The runtime points back

`home-runtime`'s `BROKER_ISS` / `BROKER_JWKS_URL` / `ALLOWED_ORIGINS`, `home-edge`'s `EDGE_ALLOWED_ORIGINS` and `home-mcp`'s
`HOME_ORIGIN` / `BROKER_JWKS_URL` name this origin (`deploy/estate.json#vars`).

## 3. The estate's people (2026-09-12)

Six people provisioned on faithchain for this estate, none of faithnet's — `mara.me` Mara Lindqvist · `theo.me` Theo
Adeyemi · `priya.me` Priya Raman · `jonas.me` Jonas Weber · `naomi.me` Naomi Castellanos · `samuel.me` Samuel Ochieng.
Smart Agents deployed, `<handle>.me` claimed as primary, vault keys bound at `home-vault` (server id `home-vault`),
interactions + delivery planes granted. The roster with their keys is `demo/personas.estate.local.json` (gitignored —
`demo/*.local.json`) and is this Home's `DEMO_PERSONA_KEYS`. They custody no organizations yet: charter one at the Home
as one of them; the live gates that name alice / Missio Nexus run with `HANDLE=` / `ORG=` overrides here.
