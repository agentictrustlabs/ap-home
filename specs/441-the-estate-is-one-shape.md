# Spec 441 — The estate is one shape, and a builder stamps it

**Status:** written 2026-10-14; **W1 landed the same day** — `estates/*.estate.json`, `scripts/estate-shape.mts`, `pnpm check:estate-shape` (vars + secrets + `--kms`). First run: **9 drifts**, the list in §5. W1 is read-only and expected RED. **Owner decision:** "There is no reason why the two estates are different. There is a
town called faithnet that has different requirements but that should be clearly different from Estate. I want to make
these two Estates identical in configuration/capabilities and support another 100 being created in the future by a
simple Estate builder tool."
**Builds on:** spec 436 (the four contexts — Home · Estate · Town · Federation; §8 hosts and zones, §9 the second
estate), ap-federation spec 440 (one KMS tenant per estate; the four conditions), spec 439 (what an estate presents
across a boundary), ADR-0055 (the vault is the record), ADR-0021 (generic packages, white-label apps), ADR-0013 (no
silent fallbacks).

---

## 1. The problem

Spec 436 already says what an estate IS. Nothing says what an estate *is configured like*, so the two we run drifted
apart by accident — not by any decision either one recorded.

Measured 2026-10-14 from `apps/agent-runtime/wrangler.toml` and `wrangler secret list` on both:

| | faithnet | imbnet |
| --- | --- | --- |
| runtime vars | 83 declared | 71 declared; **30 of the union differ** |
| vault vars | 19 declared | 2 differ (both AKCS) |
| vault KEK backend | `agentic-kms` | `agentic-kms` |
| person custody | `local-aes` + `A2A_CUSTODY_ROOT_KEY` | `local-aes` + `A2A_CUSTODY_ROOT_KEY` |
| the relayer's key | AKCS (`AKCS_RELAY_KEY_ID`) | **`A2A_MASTER_PRIVATE_KEY`, a Worker secret** |
| the interactions session key | AKCS (`AKCS_INTERACTIONS_KEY_ID`) | **`A2A_INTERACTIONS_SESSION_PRIVATE_KEY`, a Worker secret** |
| `AKCS_ACCEPTED_PROTECTION_LEVELS` | **unset** | `CVM_WRAPPED,CVM_DERIVED` |
| `DEMO_REQUIRE_GATEWAY_ASSERTION` | `true` | `false` |
| KMS caller operations | 11 named (re-bound today) | 4 and 1 |

Two of those rows are not cosmetic:

- **imbnet keeps two raw private keys in Worker secrets and faithnet does not.** A Worker secret is readable by
  anyone who can deploy that Worker; an AKCS key id is a pointer to material that never leaves the CVM. Same
  software, same owner, two different answers to "where do this estate's keys live" — and nobody chose that.
- **faithnet leaves `AKCS_ACCEPTED_PROTECTION_LEVELS` unset,** so the one estate that holds keys in the KMS is the
  one that does not state which protection levels it will accept back.

The third-party-visible consequence: ap-federation's record carried a caveat saying an OIDC-custodied estate's
residents' seed lives in its tenant, "so the operator custodies them". **That is not true of either estate** —
custody is `local-aes` on both, and what faithnet actually holds in AKCS is its relayer and its interactions key.
A security claim in a record an auditor reads was describing a configuration that does not exist (§6).

And the shape of the drift is the real problem, not its contents. Of the 30 differing vars: 15 are faithnet's own
product extras, 3 are imbnet's, and 12 are settings both estates have and answer differently. Underneath them sit
**53 vars that are identical on both** — the chain's contracts, the shared services, the harness defaults — which
belong to the TOWN, not to either estate. Nothing in the repo distinguished the three kinds, so a 101st estate was
a copy-paste of whichever file you happened to open.

## 2. Decisions

**D1 — An estate has exactly one shape; the town it stands in has its own.** Every estate gets the same Workers, the
same backends, the same posture flags and the same KMS caller profile. faithnet's email zones, executors, Gather
limits, RealtimeKit credentials, extra model providers and connector tokens are **town/product extras** — real, kept,
and explicitly NOT part of being an estate. The test for any setting: *would the 101st estate need it to be an
estate?* If no, it is an extra and lives outside the shape.

**D2 — Three kinds of setting, named and separated.** Every estate setting is exactly one of:
- **`input`** — what the builder asks a human for. Target: **five or fewer.**
- **`derived`** — computed from the inputs by one function, never typed twice. (`BROKER_ISS`, `BROKER_JWKS_URL`,
  `MCP_URL`, `DEMO_EDGE_URL`, `ALLOWED_ORIGINS`, `A2A_PUBLIC_BASE_DOMAIN`, `ESTATE_ID`, `AKCS_TENANT_ID` — all of
  them fall out of {estate id, home host, zone}.)
- **`extra`** — product or town, declared per estate, absent by default, and never required for the estate to work.

A setting that is none of the three is a bug in this spec, not a fourth category.

**D3 — No estate keeps a private key in a Worker secret.** The relayer's key and the interactions session key are
AKCS key ids on every estate. imbnet converges onto faithnet's answer, not the reverse — this is the one divergence
where one side is simply better, and `A2A_MASTER_PRIVATE_KEY` / `A2A_INTERACTIONS_SESSION_PRIVATE_KEY` leave the
shape entirely. (Person custody is a separate decision: D4.)

**D4 — Person custody stays `local-aes` on every estate, and the record says so plainly.** Moving residents' custody
derivation into the tenant would make the KMS operator a custodian of every resident of every estate — the cost
ap-federation 440 §A4 warned about, which no estate has actually paid. Until a decision is taken with that cost on
the table, custody is local on all 100, identically, and `A2A_CUSTODY_KMS_BACKEND = "local-aes"` is an explicit
declaration rather than a default nobody read.

**D5 — One KMS caller profile per Worker, named in faithkms, not derived by hand.** `estate-vault` and
`estate-runtime` as named profiles, so `bind-caller --profile estate-runtime` replaces eleven operations and five
signing purposes retyped per estate. Deriving the set by hand cost a day on 2026-10-14 and the mistake was invisible
(ap-federation runbook §2). A profile is also the only way a hundredth estate gets the same grant as the first.

**D6 — The raw-digest grant is closed before the profile is stamped 100 times.** `estate-runtime` needs
`RAW_32_BYTE_DIGEST` today only because the relayer signs EIP-155 transaction digests that no purpose in faithkms's
enum describes, and the interactions leaf signs a 32-byte digest that is really EIP-712. A grant to sign bytes whose
meaning nothing can check is tolerable on one estate as a named residual; it is not something to mint a hundred of.
W2 adds a typed purpose upstream and the profile drops the grant.

**D7 — The shape is a declaration, and the deployment is generated from it.** One `estates/<id>.estate.yaml` per
estate holds the inputs and the extras; the wrangler env block and the secret checklist are **generated**, never
hand-edited. The generator is the single place the derived settings exist.

**D8 — A gate compares every live estate against the shape, and drift is a failure.** `check:estate-shape` reads
each declaration, derives what it should be, and diffs against what is deployed — vars from wrangler, callers from
`akcs operator status`, secrets by name only. Today's finding (the federation record describing a configuration that
does not exist) is exactly what this gate would have caught the day it drifted. Bookkeeping that is not checked is
decoration.

## 3. The estate's inputs (D2), in full

Five, and the builder asks for nothing else:

| input | example (imbnet) | why a human must say it |
| --- | --- | --- |
| `id` | `imbnet` | the estate's name in the town, the federation and its tenant |
| `homeHost` | `www.impact-agent.me` | the rpId of every passkey; cannot be derived or changed later |
| `zone` | `impact-agent.io` | where the estate's own hosts live (`mcp.`, `edge.`, `a2a.`) |
| `town` | `faithchain` | which town's chain, naming and Pulse it stands in |
| `kmsTenant` | `imb` | defaults to `id`; separate only because imbnet's tenant was named before the rule |

`HARNESS_AGENT_SA` and `INTERACTIONS_SERVICE_SA` are **outputs of the build**, not inputs: each estate charters its
own, and the builder writes them back into the declaration after it charters them. An estate that reuses another
estate's interactions SA is not a second estate (439 §7.13, memory `project_federation_vault_is_the_record`).

## 4. The one KMS profile (D5)

```
estate-vault     operations: status, data-key-generate, data-key-unwrap, mac-generate, mac-verify,
                             key-create, key-read, key-public-key
                 purposes:   *            (each person's KEK is purpose vault-kek:<owner>)
                 audiences:  urn:mcp:server:person
                 levels:     CVM_WRAPPED, CVM_DERIVED
                 signing:    none         (the vault signs nothing)

estate-runtime   operations: status, mac-generate, mac-verify, key-read, key-public-key, key-sign
                 purposes:   *
                 audiences:  urn:mcp:server:person
                 levels:     CVM_WRAPPED, CVM_DERIVED
                 signing:    EIP712, ERC4337_USER_OPERATION, EIP7702_AUTHORIZATION, PERSONAL_SIGN_DIGEST
                             (+ RAW_32_BYTE_DIGEST until D6 closes it)
```

Neither profile carries `key-rotate`, `key-disable` or `key-schedule-destruction` — the three a wildcard wrongly
grants a Worker, and the floor ap-federation condition 1 asserts. Neither carries `derived-signer-*`, which only a
custody-in-tenant estate would need and D4 says no estate is.

The profiles are **narrower than what faithnet holds today** (11 operations each, granted as a superset while
hunting). Converging onto them is a reduction for faithnet and an expansion for imbnet.

## 5. Convergence (what each estate owes)

**imbnet** — create its relay and interactions keys in its tenant, move both off Worker secrets, set
`AKCS_ACCEPTED_PROTECTION_LEVELS`, re-bind its two callers to the profiles, set
`DEMO_REQUIRE_GATEWAY_ASSERTION = true`, and adopt the estate's model baseline.

**faithnet** — set `AKCS_ACCEPTED_PROTECTION_LEVELS` (it is unset on the one estate holding keys in the KMS),
re-bind its two callers down to the profiles, and move its ~10 product extras out of the shape into its own
`extras:` block so they stop reading as part of being an estate.

Neither estate changes a host, an SA, a name or a vault record. This is configuration convergence only; no resident
of either estate sees anything.

## 6. The correction this spec owes the federation record

ap-federation spec 440 caveat A4 says residents who sign in with Google, email or phone have their custody seed in
their estate's tenant, "so the operator custodies some residents of every town that opts in", and the 2026-10-14
condition-1 work repeated that as the reason faithnet needed a wider caller than imbnet.

Checked against both the running configuration and the operator's own key list:

- `A2A_CUSTODY_KMS_BACKEND = "local-aes"` on **both** estates, so custody derives from `A2A_CUSTODY_ROOT_KEY`, a
  Worker secret of the estate. **No resident's custody seed is in any tenant.**
- faithnet's tenant does hold exactly **one `oidc-custodian` envelope key** — provisioned, and never selected by
  the configuration that runs. imbnet's holds none.
- What faithnet actually keeps in its tenant beyond its 413 vault KEKs is its `relay` and `interactions-session`
  signing keys, which is precisely why it needed the wider caller — not custody at all.

So A4 is a **conditional** caveat: true the day an estate flips custody to its tenant, and D4 says no estate does
until that cost is decided. Corrected in `federation.yaml#kms.custodyToday` and in 440's A4 row, with the date and
the method, because a security claim nobody can reproduce is worse than no claim.

## 7. Waves

| wave | what lands | the gate that proves it |
| --- | --- | --- |
| **W1** ✅ | `estates/*.estate.json` for both estates; the derive function; `check:estate-shape` over vars, secret NAMES and (with `--kms`) the live callers | **landed 2026-10-14: 9 drifts named, the two Worker-secret keys at the top.** The gate also corrected this spec before anything deployed — §7.1 |
| **W2** ✅◐ | **landed AND LIVE 2026-10-14 — half of what D6 promised, by design (§7.4)** — faithkms gained `EIP155_TRANSACTION` and the two named profiles; key-custody gained a per-ACT signing purpose; the relayer no longer needs the raw grant. The interactions-session key still does, and §7.4 says why that is the honest answer rather than a shortfall to hide | **the binary is installed on the CVM** (sha verified before replacement, `healthz=200`, and the live operator's own `--help` names both profiles), **both estates' callers are bound FROM the profiles** — faithnet 8 and 6 operations, down from 11 each — and **all seven live gates are green** |
| **W3** ✅ | **landed 2026-10-14.** W3a: faithnet declares the two settings it only had by default. W3b: imbnet's relay and interactions keys moved into its own tenant, its callers re-bound to the profiles, the edge assertion required, and both raw private keys DELETED from the Worker | **`check:estate-shape` GREEN on all three arms** — vars, secret names, live callers. `gate:pay-outward` green for maya with no key of imbnet's in a Worker. §7.2 |
| **W4** | the builder: `estate new <id> --home-host … --zone … --town …` → declaration, tenant, callers (by profile), the three-step interactions-key provisioning of §7.2, charters, secrets checklist, deploy | a third estate is built from the tool alone and passes the gate on its first run |
| **W5** | one `VAULT_SERVER_ID` per estate, with the grant and vault-key-binding migration it needs (§7.3) | a grant naming one estate's vault is refused by the other's |
| **W6** | the runtime's credential SPLIT PER KEY ROLE, so the binding that may sign app-defined digests cannot also sign transactions (§7.4) | no estate profile carries `RAW_32_BYTE_DIGEST` |

W1 is deliberately read-only: it measures before it changes anything, because the only reason this spec exists is
that nothing was measuring.

### 7.1 What W1 corrected in this spec, before a single deploy

Writing the posture table, I set `A2A_ALLOW_LOCAL_MASTER_KEY = "false"`, reasoning that with the relayer and the
interactions key in the KMS there is nothing local left to sign. The gate flagged both estates, and the code says
why the flag exists: `key-custody`'s `LocalSecp256k1Signer` refuses `NODE_ENV=production` unless it is true, and
custody is local on every estate by D4. `false` would have broken custody on both. The shape now carries `true`
with the reason written down — **it is the cost of D4 made visible, and it leaves the day custody moves into the
tenant.** This is the argument for a gate that measures before it converges: the first thing it caught was the
spec's own mistake.

Two smaller corrections from the same run: `ORCHESTRATION_*` is a product extra (which models an estate pays for),
not a town baseline two estates must agree on; and a serving domain is not a browser origin, so imbnet's
`workers.dev` host belongs beside its zones and not in `ALLOWED_ORIGINS`.

### 7.2 What moving a key actually costs — the three steps W4 must take

Swapping imbnet's two keys broke two things, both because **a key's ADDRESS is load-bearing somewhere a
configuration variable does not mention**:

1. **The playbook stopped reading** (`auth failed — mcp: auth failed`, visible only as
   `plannerTrace.playbookUnreadable`). Every resident's DEL-001 session leaf names the interactions key as its
   delegate, so each leaf pointed at an address that no longer signs. `scripts/reissue-interactions-grants.mts`
   fixes it and needs no argument for the new key — it reads the live one from
   `/a2a/agent/interactions-session-key`.
2. **The payment reverted the whole transaction**, not the inner call — which is why the harness reported "inner
   userOp reverted" with nothing behind it. **The harness agent SA's sole custodian IS the interactions-session
   key** (`executeAsServiceSa`'s own comment says so), so changing the key orphaned the account that executes
   every redemption. One `executeBatch` rotated `0x193B496d`'s custodian onto the AKCS address. faithnet's
   harness SA was already custodied by its own AKCS key — the difference nobody had noticed.

So **provisioning an estate's interactions key is three steps, not one**: create the key, rotate the harness
agent SA's custody onto it, and re-issue every resident's session leaf. The builder does all three or it produces
an estate that answers questions and cannot act. The relay key, by contrast, is one step — nothing references its
address; its brand-new account holds no gas and the paymaster sponsors the op regardless.

## 7.3 A gap the shape found and has not closed: both vaults answer to one name

`VAULT_SERVER_ID` is the id every record-scope grant names and the `vaultId` a person signs in the vault-key
ceremony, and `domain.ts` says of it: *"a second deployment on the same chain names its own, so a grant made to
one estate's vault never satisfies another's."* **It is unset on both estates**, so both answer to the default
`demo-mcp` — and that sentence is not true today. A grant a resident of one estate signed names a server id the
other estate's vault also answers to.

What saves it right now is that the grant also names the delegate (each estate's own `INTERACTIONS_SERVICE_SA`,
and those do differ) and the vault re-verifies the chain per record. So this is a missing layer, not an open door.
But it is exactly the kind of accidental sharing the shape exists to find, and a per-estate id is one derived var
(`VAULT_SERVER_ID = <id>`) plus a migration: every existing grant and every vault-key binding names the old id, so
flipping it without re-issuing them strands both estates. **W5**, and not before the builder, because the builder
is what makes a fresh estate get its own id for free.

## 7.4 Why `RAW_32_BYTE_DIGEST` survives W2, and what actually removes it

D6 said the grant would be closed before the profile was stamped a hundred times. Half of it closed, and the
other half turned out to be the wrong shape of problem.

**A signing purpose is a policy label and an audit statement, never part of the computation** — faithkms signs
`sign_digest` over the 32 bytes it was handed whatever the purpose says. So its whole value is that the operator's
audit row says what the signature was *for*, and that a caller allowed to sign one kind cannot sign another.

**The relayer is closed.** It signs exactly two things and both now have names: the EIP-155 transaction it
broadcasts (the new `EIP155_TRANSACTION`, which `kms-viem-account`'s `signTransaction` declares *itself* — a
serialized unsigned transaction is the one digest an adapter can identify without being told), and the paymaster's
sponsorship digest, which it signs as a message and which `SmartAgentPaymaster` recovers over
`toEthSignedMessageHash`, making `PERSONAL_SIGN_DIGEST` exactly what that act is.

**The interactions-session key is not, and relabeling it would be a lie.** That one key signs genuinely different
32-byte digests through a single raw-digest path: peer attestations, harness digests (`signAsHarness`), DEL-001
bound tokens, invocation proofs, and the service SA's userOp hashes. Declaring all of them `EIP712` or
`ERC4337_USER_OPERATION` would put a false statement in the operator's audit row, which is worse than a wide
grant that is honestly labelled. `RAW_32_BYTE_DIGEST` says what is true: a digest whose meaning lives in this
application.

**One more thing an auditor would otherwise be misled by: the audit PRECISION lags the capability.** ap-home pins
`key-custody` at a published version, so until a release carries the per-act purpose, its `signTransaction`
declares whatever purpose its signer was constructed with — `EIP155_TRANSACTION` is enforceable today and appears
in no audit row yet. A changeset records it.

**What removes it is W6, and it is a different change.** Name the purpose at each act — the per-call
`signingPurpose` that `signA2AAction` now accepts — and then split the runtime's credential per key role, so the
binding that may sign application-defined digests cannot also sign a transaction. Two tokens on one Worker, not
one. Until then the grant is carried by one caller, for one key, with the reason written where the caller is
bound.

## 7.5 The builder (W4)

`pnpm estate:new --id <id> --home-host <host> --zone <zone> --town <town>` writes the declaration; after that
every run is `--plan` (say the state) or `--run` (do what is mine). Ten steps, ordered, idempotent, and **nine of
them verify themselves** — which matters more than the automation:

| step | kind | how it knows it is done |
| --- | --- | --- |
| declaration | auto | the file exists and the five inputs are sane (and no sibling shares a Home host, zone or tenant) |
| wrangler-env | auto | `[env.<id>.vars]` present in both tomls, generated from `estate-shape.mts` |
| kms-tenant | operator | the operator's own status lists the tenant |
| kms-callers | operator | the status lists this estate's two subjects, EXACTLY matched |
| kms-keys | operator | both key ids are in the runtime's env |
| kms-tokens | operator | `AKCS_TOKEN` present on both Workers **by name** — a value is never read |
| charter-agents | signer | the declaration records both SA addresses |
| custody-of-the-harness-sa | signer | **on chain**: `isCustodian(harnessSA, <the key the live Home reports>)` |
| session-leaves | auto | the Home says the first declared resident's grant is `current` |
| shape | auto | `check:estate-shape` passes |

Both existing estates return 10/10, which is the real test: the plan describes the estates we have rather than the
one it would have been convenient to imagine. Three things it caught about itself on the way — a substring match
that reported a caller which did not exist, a TOML value full of double quotes that produced a file wrangler could
not parse, and a wish to rename both estates' legacy callers (now recorded in the declaration instead).

## 8. What this spec does NOT do

- It does not change what an estate *is* (spec 436 owns that), nor any vault record, host, name or SA.
- It does not move person custody into the KMS (D4 says no, and says why).
- It does not make the estate shape a Ring-0 package. The shape is a deployment concern of this repo; what a
  package would own is the derive function if a second product ever needs it (ADR-0021).
- It does not promise the builder charters agents unattended. Chartering spends authority and signs as a custodian;
  the builder prepares and the human signs, as everywhere else.
