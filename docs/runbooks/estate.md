# The estate — Home on faithchain (`[env.production]`)

The one deployment this repository makes. Five Workers, each `[env.production]` in its `wrangler.toml`; the Home on
Vercel (`docs/runbooks/home-vercel.md`). Names and ids: `deploy/estate.json` (the copy Ring 0's derivation reads is
`scripts/split/ap-home-estate.json` there; `wrangler.toml` is the truth). Every command below is
`wrangler deploy --env production` from the app directory; nothing here touches a faithnet Worker, KV, D1 or Home.

| Worker | App | Host | Owns |
| --- | --- | --- | --- |
| `home-rpc` | `apps/rpc-gateway` | `home-rpc.faithnet.io` | KV `TOKENS` (app tokens, stored as `t:sha256(key)`), rate DO |
| `home-vault` | `apps/vault` | `home-vault.faithnet.io` | D1 `home-vault` (the records, the vault-key bindings), budget DO |
| `home-runtime` | `apps/agent-runtime` | `home-a2a.faithnet.io` | `InteractionsDO`, `A2aTaskDO`, …; KV ×4; the harness workflow |
| `home-edge` | `apps/edge` | `home-edge.faithnet.io` | admission; service bindings to `home-vault` + `home-runtime` |
| `home-mcp` | `apps/home-mcp` | `home-mcp.faithnet.io` | its own key (`HOME_MCP_PRIVATE_KEY`) — the Home's `home-mcp` client's `delegate` |

Custom domains, not `*.workers.dev`: Cloudflare refuses a Worker's subrequest to another same-account Worker on
`workers.dev` (error 1042) — the vault could not read the chain through the gateway, the runtime could not reach the
vault. `wrangler deploy` creates the DNS record for a `custom_domain = true` route.

## 0. Once

`wrangler whoami` — the account that owns the zone. The AKCS pilot (`akcs-pilot.faithnet.io`, tenant `faithnet`) holds
the vault KEKs and the runtime's signer; its caller token (`AKCS_TOKEN`) is the operator's to hand over — today it is
faithnet's runtime caller identity (`sub demo-a2a-faithnet`), shared. **Binding a caller identity of this estate's own
is the one open trust item**; the service agents it custodies (`INTERACTIONS_SERVICE_SA`, `HARNESS_AGENT_SA`,
`AKCS_*_KEY_ID`) become the estate's own with it.

## 1. Storage (created once; ids in `deploy/estate.json`)

```
cd apps/vault         && wrangler d1 create home-vault && wrangler d1 migrations apply home-vault --remote --env production
cd apps/agent-runtime && for b in BRIDGE_NONCES SUBJECT_SA_MAP FED_TOKENS RELEASED_CARDS; do wrangler kv namespace create "$b" --env production; done
cd apps/rpc-gateway   && wrangler kv namespace create TOKENS --env production
```

## 2. Deploy, in dependency order

rpc-gateway → vault → agent-runtime → edge → home-mcp. The gateway needs nothing; the vault needs `RPC_URL`; the
runtime needs the vault (`MCP_URL`) and the gateway; the edge binds both; home-mcp needs the runtime and the Home.

Mint the gateway's app token after the first gateway deploy (`apps/rpc-gateway/README.md`): the token is what every
other Worker's `RPC_URL` secret carries (`https://home-rpc.faithnet.io/?k=<token>`).

## 3. Secrets (per Worker; a new Worker has none)

`RPC_URL=https://home-rpc.faithnet.io/?k=<token> ENV=production bash scripts/set-cloudflare-secrets.sh` generates and sets
the runtime's `SESSION_JWT_SECRETS`, `CSRF_SECRET`, `A2A_SESSION_SECRET`, `A2A_INTERNAL_MARKER`, `A2A_CUSTODY_ROOT_KEY`,
the vault's `OAUTH_SIGNING_SECRET`, `RPC_URL` on both, and `GATEWAY_ASSERTION_SECRET` on edge + vault + runtime (one
value). Then, by hand:

| Secret | On | Value |
| --- | --- | --- |
| `AKCS_TOKEN` | vault, runtime | the pilot's caller token (§0) |
| `A2A_MAC_SECRET` | vault, runtime | one fresh `0x`+hex64 on both (service MACs; the halves must agree) |
| `A2A_CUSTODY_BRIDGE_SECRET` | runtime | the SAME value as the Home's (`home-vercel.md`) — rotate both together |
| `ANTHROPIC_API_KEY` | runtime | the planner (`ORCHESTRATION_LLM = "anthropic"` names only providers whose keys the estate holds — ADR-0013) |
| `HOME_MCP_PRIVATE_KEY`, `TOKEN_SECRET` | home-mcp | a fresh secp256k1 key (its address is the Home's `NEXT_PUBLIC_HOME_MCP_DELEGATE`) and a fresh hex64 |

NOT needed on faithchain: `GCP_SERVICE_ACCOUNT_JSON` (the vault selects the AKCS KEK provider when `AKCS_*` is set;
GCP is consulted only for `VERIFICATION_RECEIPT_KMS_KEY`, unset here) and `GROQ_API_KEY` (Groq is not on the offer).

## 4. People and planes

The estate has its own roster (`demo/personas.estate.local.json`, gitignored — `home-vercel.md` §3): Smart Agents on
faithchain, `<handle>.me` names, vault keys bound at `home-vault` under server id `home-vault`. Provision with Ring 0's
`apps/home/scripts/provision-demo-personas-local.ts` (`ROSTER=… LOCAL_ROSTER=… AGENT_NAME_PARENT=me
RPC_URL=… MCP_URL=https://home-vault.faithnet.io`), then `scripts/provision-all-demo-planes.mts <handles…>` at the Home
(interactions + delivery planes). An organization is chartered at the Home by one of them (the org-create ceremony).

### 4b. The gate fixture

The live gates read WHO plays each role from `scripts/fixture.estate.json` (`scripts/fixture.mts`; the ledger's
`fixture` key exports it as `FIXTURE_JSON`): steward `mara`, members `theo` / `priya`, outsider `jonas`, payee owner
`samuel`, invitee `naomi`; `soup-kitchen.org` (+ `food-bank.org` for the routed hop), `volunteer-rota.team` +
`volunteer-drivers.team` (the ambiguous word), `mara.treasury` / `mara2.treasury` / `samuel.treasury`. Make it true with

    FIXTURE_JSON=scripts/fixture.estate.json npx tsx scripts/provision-estate-fixtures.mts [--dry-run]

— charters through each person's own Ask (mandates signed at this Home; nothing minted by a script key), the steward
links and vault keys the Home's ceremony would have written, 100 demo USDC in the steward's treasuries, the
coordinator playbook on the routine agent, both halves of each membership. Idempotent: run it again after anything
fails. Roles still `null` (`specialist`, `ministry`) make their gates SKIP by name — chartering those is an
operator step (a runtime service with a payments playbook; a content-catalog agent in the public registry).

## 5. The clock

`live-gates-nightly.yml` runs `scripts/live-gates.json` (its `home` is this estate's Home) every night; repository vars
`A2A_URL` = `https://home-a2a.faithnet.io/api/a2a` and `MCP_URL` = `https://home-vault.faithnet.io/mcp` add `ap conform`.
Seven consecutive green nights → the cut PR (spec 399 §5.6). `HOME_URL=<home> npx tsx scripts/verify-route.mts` is the
first gate by hand.

## Open

- A product zone (`home.<zone>`, `a2a.<zone>`, …) instead of `home-*.faithnet.io`; per-agent hosts need a wildcard
  (`*.home-a2a.faithnet.io` + a route on `home-runtime`) — until then agents are reached by records through the edge.
- The email rail: no zone of the estate's is onboarded to Cloudflare Email Sending, so invitations by email are
  unconfigured (fail-closed). `EMAIL_FROM` on an onboarded zone + the `send_email` binding, or `SENDGRID_API_KEY`.
- `REALTIMEKIT_*` if huddles are wanted.
