# Runbook — a new estate

**What this stands up:** one more estate on a chain that already has a town: a Home (Vercel), four Workers
(runtime, vault, edge, Home MCP) and an approval Workflow, with its own custody root, service agents, vault, KMS
tenant, naming gate and demo people. Written from impact-agent, the second estate on faithchain (2026-10-11); every step
below was run, and the ones that bit are marked **⚠**. Read
[What an estate is made of](https://github.com/agentictrustlabs/agentic-primitives/blob/main/docs/estate-anatomy.md)
first — it says why each step exists. The town's half (the manifest row, lanes, gateway token, KMS tenant, naming
gate allowance, heartbeat) is
[ap-town's publish-an-estate runbook](https://github.com/agentictrustlabs/ap-town/blob/master/operations/runbooks/publish-an-estate.md);
the two interleave and the order below says when to cross over.

`<estate>` throughout is the wrangler env name (`impact-agent`); Workers are `<prefix>-<job>` (`imb-runtime`,
`imb-vault`, `imb-edge`, `imb-home-mcp`, `imb-approval`). Never reuse another estate's Worker names, DO class
names, bindings or migration tags: they are storage.

## 0a. Start with the builder (spec 441 W4)

```
pnpm estate:new --id <estate> --home-host www.<host> --zone <zone> --town <town>   # writes estates/<estate>.estate.json
pnpm estate:new --id <estate> --plan                                              # the ten steps and their state
pnpm estate:new --id <estate> --run                                               # do what is the tool's; stop at what is not
```

**Read this runbook, but let the tool drive.** It is a resumable plan over ten ordered idempotent steps, and
**nine of them verify themselves** — the KMS tenant and callers from the operator's own status, the tokens by
secret NAME, the harness SA's custody ON CHAIN, the session leaves by asking the Home, and
`pnpm check:estate-shape` last. Run it again after every manual step; it never repeats work that is done.

What it will stop at, and why those two cannot be automated:

- an **operator** step runs on the KMS CVM as the operator of record (one holder today, deliberately — see
  ap-federation 440 §A). The tool runs it when `az` is logged in as that operator and prints it otherwise.
- a **signer** step charters an agent or rotates custody, which SPENDS AUTHORITY. A tool that charters
  unattended can create an agent nobody decided to create.

**The reason to use it rather than the steps below:** everything in §0 and the var tables is DERIVED from five
inputs by `scripts/estate-shape.mts`, which is the only place those vars exist. Hand-typing them is how the two
estates drifted into 30 differing variables, one of which left a private key in a Worker secret (spec 441 §1).
The sections below remain the explanation of WHY each step exists, and the record of the ones that bit.

## 0. Decide what the estate has

| Decision | impact-agent's answer | Why it matters |
| --- | --- | --- |
| A zone of its own? | no — Vercel's and `workers.dev` default hosts | without a wildcard zone there are no per-agent card hosts; agents are reached through the edge by name (the routing rule anyway). The town must declare every host it reaches as a **lane** |
| Chain + contracts | faithchain, the town's | shared by every estate on the chain |
| KMS | **its own AKCS tenant** `imb` | a tenant is a derivation root = an estate boundary |
| Custody root / relay | `local-aes`, in-Worker secrets | moving the root later orphans every home; decide now |
| Mail | reuse `faithnet.ai`'s rail (`invites@`) | a `workers.dev` estate has no mail rail of its own |
| Social sign-in | Google client shared with faithnet (one client holds two secrets) | consent screen is per Google Cloud project, so it shows that project's name |
| Demo people | five of its own, named for the estate | never another estate's roster |

## 1. Town first: the row, the lanes, the token

In `ap-town`: add the `estates:` row (`home`, `edge`, `a2a`, `nameRoots`, `lanes`, `kms: { tenant }`, `workers`,
`vercelProjects`), run `pnpm gen:town`, mint the estate's RPC app token on the chain gateway (`t:<sha256>` in the
gateway's `TOKENS` KV with writes allowed — the bootstrap script needs writes), and a heartbeat token. The chain
gateway caches reads: a just-created address reads as undeployed for a beat — **retry the same read, never switch
mechanism** (ADR-0013).

## 2. Keys and service agents

```
CHAIN_APP_TOKEN=<gateway token> npx tsx scripts/bootstrap-estate.mts --estate <estate> [--dry-run]
```

Writes `.estate-<estate>.local` (0600, gitignored): custody root, relay key, interactions key, the two service
agents deployed on chain (`INTERACTIONS_SERVICE_SA` salt 0 — what grants name; `HARNESS_AGENT_SA` salt 1 — what
the agent acts as), and every shared secret. **This file is the only copy of the custody root.** Losing it loses
every person's home; copying it copies the authority to be every one of them.

**⚠ Formats.** `CSRF_SECRET` and `DEMO_VAULT_LOCAL_KEK_SECRET` are `0x` + 64 hex; `SESSION_JWT_SECRETS` is
`k1:0x<64 hex>`; `BROKER_PRIVATE_JWK` is JSON. **Every value in the file is single-quoted** — a shell-sourced file
strips the quotes from JSON and ships `{kty:EC}`, which fails as an empty-bodied 500 that looks like a downstream
fault. Never build a secret with `node -e '…${var}…'`; write a script file.

## 3. The Workers

Add `[env.<estate>]` to each of the four `apps/*/wrangler.toml` (copy faithnet's block; rename every Worker,
D1 database, KV namespace and queue; `ESTATE_ID = "<estate>"` on runtime and vault — **⚠ the heartbeat once
defaulted to the first estate's id and impact-agent answered as faithnet**; `ESTATE_CENSUS_REGISTRY_ORIGIN` only where
that registry is the estate's own). `SA_BUDGET` is bound across Workers with `script_name = "<prefix>-vault"`.

```
scripts/set-estate-secrets.sh <estate>                      # each secret to only the Workers that share it
wrangler deploy --env <estate> -c apps/vault/wrangler.toml   # then agent-runtime, edge, home-mcp (order matters)
wrangler d1 migrations apply <vault db> --remote -c apps/vault/wrangler.toml --env <estate>
```

`wrangler tail` for a `<prefix>-*` name: omit the positional (`wrangler tail --env <estate> -c …`) — the name
gets mangled otherwise.

## 4. KMS: the estate's own tenant

**⚠ The step that cost a day.** The vault's per-person KEKs and the runtime→vault MAC need a KMS tenant. A local KEK
can never work in a deployed Worker (esbuild folds `NODE_ENV === 'production'` to `true`); and this org uses no
Google KMS keys anywhere — a 501 naming `GCP_SERVICE_ACCOUNT_JSON` means "no backend configured", never "add one".

On the AKCS pilot CVM (`az vm run-command invoke -g RG-AKCS-PILOT-WESTUS -n vm-akcs-pilot-0 --command-id
RunShellScript`; `set -a; . /etc/akcs/env; set +a`), as the operator:

```
akcs operator --config /etc/akcs/config.toml create-tenant --tenant-id <t> --name "<Estate>"
akcs operator … bind-caller --tenant-id <t> --issuer https://akcs-pilot.faithnet.internal --subject <prefix>-vault   --name "<prefix>-vault"   --operations data-key-generate,data-key-unwrap,mac-generate,key-create --purposes "*" --audiences urn:mcp:server:person --protection-levels CVM_WRAPPED,CVM_DERIVED --signing-purposes none
akcs operator … bind-caller --tenant-id <t> --issuer https://akcs-pilot.faithnet.internal --subject <prefix>-runtime --name "<prefix>-runtime" --operations mac-generate --purposes "*" --audiences urn:mcp:server:person --protection-levels CVM_WRAPPED,CVM_DERIVED --signing-purposes none
akcs dev mint-token --signing-key /etc/akcs/issuer/issuer-signing-key.pem --kid akcs-pilot-1 --issuer https://akcs-pilot.faithnet.internal --audience akcs-pilot --subject <prefix>-vault   --ttl-secs 31536000
akcs dev mint-token … --subject <prefix>-runtime --ttl-secs 31536000
```

- **Allowlists are exact-match or `*`.** `--audiences` must be the MAC audience the Workers send
  (`MCP_AUDIENCE` = `urn:mcp:server:person`); `--purposes` must be `*` (each person's KEK is purpose
  `vault-kek:<owner>`); the vault needs `key-create` to mint one. Bound without these, every MAC fails
  `AUDIENCE_NOT_ALLOWED`, and the Home shows `interactions_not_enabled` → `vault_key_unauthorized` with
  nothing naming KMS — the text only appears when you `curl /connect/inbox` with a home session.
- **CVM levels only.** `AZURE_HSM_DIRECT` is a real Key Vault HSM key billed per key; the couple of HSM roots are the
  whole Azure spend and every agent key derives from them for free. Leaving the level off the caller makes a
  billable key impossible, not discouraged.
- A binding cannot be edited: `disable-caller --tenant-id <t> --caller-id <id>` and bind a `-2` subject.
- **The two lines above are for an estate whose custody and relay stay `local-aes`** (impact-agent's shape, and the last
  line of this section). The moment an estate moves custody or the relay onto the tenant — faithnet's shape, where
  residents are OIDC-custodied THROUGH it — those operations and `--signing-purposes none` are both wrong, and the
  estate breaks in a way that names nothing. faithnet's two, for when that day comes:
  `--operations status,data-key-generate,data-key-unwrap,derived-signer-resolve,derived-signer-sign,mac-generate,mac-verify,key-create,key-read,key-public-key,key-sign`
  with `--signing-purposes EIP712,ERC4337_USER_OPERATION,EIP7702_AUTHORIZATION,PERSONAL_SIGN_DIGEST,RAW_32_BYTE_DIGEST`.
- **`RAW_32_BYTE_DIGEST` must be listed EXPLICITLY** — it is off by default and a `*` does NOT enable it. The relayer
  signs EIP-155 transaction digests and the interactions-session key signs a 32-byte DEL-001 leaf, so an estate using
  either on AKCS needs it named. Omitting it cost a day: no Worker log line, no gate failure, only
  `plannerTrace.playbookUnreadable` inside an ask reply, after which the harness asked "You have no treasury to be
  paying from" — a credential error wearing a domain question's clothes. **If a KMS change breaks something, read
  `playbookUnreadable` first.** Full account: `ap-federation/docs/runbooks/kms-tenant-for-an-estate.md` §2.

Then `scripts/adopt-akcs.sh <estate> <vault-token> <runtime-token>` (sets `A2A_KMS_BACKEND=agentic-kms`,
`AKCS_TENANT_ID`, `AKCS_ACCEPTED_PROTECTION_LEVELS=CVM_WRAPPED,CVM_DERIVED`, the two `AKCS_TOKEN` secrets) and
redeploy vault + runtime. Keep the tokens in `.akcs-<estate>-ceremony.local.json` (0600). Custody and relay stay
`local-aes`.

## 5. The Home (Vercel)

Project `<estate>-home`, root `apps/home`, branch of your choice. **⚠ `pnpm-lock.yaml` is gitignored here on
purpose**, so a build resolves fresh: every `@agenticprimitives/*` pin must be a published version whose peers
resolve, or the build fails before it starts.

Env (sensitive): the broker/session/CSRF secrets from `.estate-<estate>.local`, `RPC_URL` (the gateway token),
`A2A_CUSTODY_URL` + `A2A_CUSTODY_BRIDGE_SECRET` (the runtime's half), `NAMING_GATE_PRIVATE_KEY` (§7),
`DEMO_PERSONA_KEYS` (§8), Google client id/secret if used. Build-time (`NEXT_PUBLIC_*`, **redeploy after any
change**): chain id/name/RPC, `HOME_ORIGIN`, `A2A_DOMAIN`, `DEMO_EDGE_ORIGIN`, `INTERACTIONS_SERVICE_SA`,
`BRAND_NAME`, `AGENT_NAME_PARENTS`, `DISCOVERY_A2A_URL`, and:

- **⚠ `NEXT_PUBLIC_LOGOUT_RP_APPS`** — defaults to faithnet's relying apps; their `/sso-logout` refuses any other
  Home's return and strands the person on their root. Set `none` until the estate has relying apps of its own.
- Every other `NEXT_PUBLIC_*` default is faithnet's value. Grep `apps/home` for `process.env.NEXT_PUBLIC_` and
  decide each one.

**KV store: its own, and empty.** The login-facet index maps a credential to the agent it opens; a shared store
opens the WRONG Home. `redis-cli … dbsize` must be 0 before attaching (two offered stores had 1,925 and 1,222
foreign keys). `KV_KEY_PREFIX` exists for an unavoidable share; leave it unset on a dedicated store.

## 6. Sign-in

- **Email**: the Home posts to the runtime, which needs a mail rail (`[[env.<estate>.send_email]]`,
  `EMAIL_FROM` at a zone that has one). `emailSendingEnabled()` reports true from configuration PRESENT, so
  `DEV_OTP_ECHO` is dead on any estate with a custody URL — do not "fix" it by echoing on send failure. An
  operator can read the OTP from the store (`emailotp:<sha256(lowercased email)>`, 600 s).
- **Google**: one client may hold two secrets; add the Home's origin + `/oidc/google/callback` to the existing
  client. The client id is public (readable from `/oidc/google/start`); only the secret is supplied by hand.
- **Demo people** (§8) need neither.

## 7. Names: the estate's own gate

```
npx tsx scripts/add-naming-gate.mts --estate <estate>
```

Mints a gate key into `.estate-<estate>.local` and has `naming.svc` (the town's agent, clerk-signed through the
faithnet relayer) allow it on every priced root; set it as `NAMING_GATE_PRIVATE_KEY` on the Home. One gate per Home,
revocable alone. The **domain rule** refuses any label whose `.com`/`.org` exists (`maya`, `mayafernandes`,
`tomasvargas`…) unless a verified email at that domain is on the Home — hyphenated full names were free.

## 8. Demo people, and proving the estate works

```
CHAIN_APP_TOKEN=<token> npx tsx scripts/provision-estate-personas.mts --estate <estate>
```

Writes `demo/personas.<estate>.json` (0600, gitignored — it holds custodian keys); the same JSON is
`DEMO_PERSONA_KEYS` on the Home (**merge, never replace**, if the Home already has a roster). A demo person's agent
is never also their organization's.

Then walk one person through the live Home — headless works: `POST /connect/demo-signin {handle, client_id}` →
open `/you#session=<homeSession>&via=Wallet` → `/vault-key` (check the box, "Sign + activate vault": the click
signs the owner-control proof, provisions the KEK on the tenant, binds) → `/profile` ("Turn on storage" — a
wallet-credential person needs the click; KMS homes self-heal — then first/last name, Save) → `/naming` (buy +
present a `.me` name from the 1000 SHQ treasury birthright). What "working" looks like: `✅ Your vault is live`,
`Saved to your encrypted vault`, `Written on chain under <name>.me`, and `/connect/name-info?name=<name>.me`
returning the person's SA.

A purchase is two signed operations (claim + pay from the treasury, then `setPrimaryName` + records from the
owner). A client closed between them leaves a registered, unpresented name: `scripts/present-estate-names.mts
--estate <estate> --home <home> <handle>=<name>.me` finishes it.

## 9. What to check before calling it done

| Check | Expect |
| --- | --- |
| `GET <vault>/custody/vault-key/server-info` | the estate's vault id and delegate |
| `curl <home>/connect/inbox` with a demo session | an inbox, not `vault_key_unauthorized` / `[agentic-kms] …` |
| town Pulse | the estate's heartbeat under ITS id, its own census |
| sign out from the Home | ends on the Home's own origin |
| `ap-town pnpm check` | `check:town`, `check:no-estate-binding` green with the new row |

## Where things are recorded

`DEPLOYER.md` (the map: who deploys what, under which names) · `.estate-<estate>.local` and
`.akcs-<estate>-ceremony.local.json` (never committed) · `demo/personas.<estate>.json` (never committed) ·
ap-town `towns/<chain>/town.yaml` (the public facts).
