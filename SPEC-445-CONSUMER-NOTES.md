# Spec 445 — ap-home consumer notes

Branch `spec-445-ring0-hardening`, worktree `/home/barb/ap-home-spec445`, cut from `master` @ `69f5911d`.
Nothing committed, pushed or deployed. Source of truth: Ring 0 `specs/445-…` §3 and §9, branch `spec-445-w0-hardening`.

**This branch does not build against the published pins** — it imports unpublished API (`principalFor`). Bump the
pins in the same change that lands it, never before.

## Read this first: Ring 0 moved while this was being prepared

The ten items below were verified against the Ring 0 builds as they stood at **13:26** (see "How it was verified"). Between 13:32 and 13:45 other work rebuilt `fabric`, `a2a`, `delegation`, `harness`, `service-host` and
`runtime-member` with further breaking changes that are **not in the ten items and are not adapted here**. Against the
13:45 builds ap-home has 18 type errors and 21 failing tests, all from these:

| Ring 0 change | What breaks in ap-home | Sites |
| --- | --- | --- |
| **RUN-9** — `a2a` session wire: `SessionWireEnforcers` requires `allowedTargets`; `sessionWirePrincipal` / `checkSessionWireShape` require `target` (this host's own agent) | 16 type errors; 16 agent-runtime tests and 3 home tests fail on the session-wire check ("the verifier named no target") | `apps/agent-runtime/src/a2a-task-do.ts:650,1864` · `agent-signing-wire.ts:68` · `index.ts:1452,1529,4110` · `interactions-do.ts:5642,5998,6010` · `library-granted-fetch.ts:64` · `self-host-wire.ts:47` · `standard-a2a.ts:167` · `apps/home/src/home/workspace-read-wire.test.ts:24,48,49,116` |
| **DATB-3** — `fabric/messaging` consult routing: `eligibleConsultMembers` requires `currentMembers` (the organization's own membership read, never the grant store); `buildConsultRequest` requires `memberSA` + `eligible` and may return `null` | 2 type errors | `interactions-do.ts:3991` · `consult-rail.ts:149` (caller `member-consult.ts:101`) |
| **RUN-12** — `runtime-member` `serve` binds loopback by default; a non-loopback bind refuses to start without `AP_RUNTIME_WAKE_SECRET`; an unauthenticated wake gets a turn count and no text | no type error — the runtime Container stops being wakeable | `apps/agent-runtime/runtime-container/Dockerfile` `CMD` (needs `--host 0.0.0.0`) · `src/runtime-container.ts` `envVars` (the secret) · the wake consumer in `src/index.ts` (the Bearer) · `scripts/verify-runtime-wake.mts:119-126` reads turn text |
| **DATA-3 / DATA-4** — `fabric` `PrincipalGatewayDO`: every ingress needs an injected `authenticate`; delivery, post, join and `applyEvent` take a minted `AuthenticatedCaller`; `orchestrate` needs `key` + `runCaveatPass` | nothing today — ap-home calls only `verifyAndCache` and `invokeFast` (`interactions-do.ts:1513-1530`) | note: `invokeFast` now refuses `principal_mismatch` if a `PRINCIPAL_SA` var is ever set and differs from the grant's delegator; ap-home sets none |
| `payments` `PAYMENT_MANDATE_DOMAIN_VERSION` `'1'` → `'2'`; `admission` transport evaluator abstains instead of allowing | nothing today — ap-home signs no payment mandate and uses only `meetsTransportAssurance` / `observedTransportAssurance` | — |

`DATB-3` needs a decision (which record is "a current member" for consult eligibility); `RUN-9` needs the right
`target` at eleven sites, some of which check a wire that will be presented to another host. Neither is mechanical.
`payments`, `admission`, `a2a` and `service-host` still had source newer than their build at 13:48, so this table is
a floor, not a complete list. Re-run the override loop below once Ring 0 is frozen.

## The ten items

### 1. `harness` `delegationMandateVerifier` — `principalFor` (done)

- **`apps/agent-runtime/src/harness-run.ts:2413` — new `authorityPartyFor(capability, asked, resolveName)`.** One rule
  for whose authority a step needs: the step's declared `authority`; else, for a capability that declares an
  `authorityArg`, the agent being asked; else the `resource` (for a capability that declares no authority the resource
  is the party — the parent a team is chartered under); else the agent being asked. A name is read once from the
  naming records; a name nothing holds falls to the agent asked; nobody named is `null`.
- **`:4558-4560` — the reply builder (`askReplyForInner`) now calls it.** It replaced the six lines that computed the
  `authority_required` reply's `delegator`. Same result as before for every input.
- **`:5318-5358` — the verifier.** `principalFor` reads a per-step map filled just before `verify` by a small wrapper
  (the port is synchronous; a name needs one async read). Fallback party: `input.addressee ?? input.person` — the
  legacy `/harness/run` route passes no addressee.
- **Why this source.** It is the rule that already decided who is asked to sign. A mandate asked of X is now verified
  against X; before, nothing compared them.

Hand checks, per invoker:

| Site | Check | Decision |
| --- | --- | --- |
| payment `:2659-2664` | chain **root** delegator vs `args.payer` | **Removed.** `payer` is this capability's declared authority, so it is exactly what the verifier now checks, on the same selected mandate. The argument is still resolved (a payer naming no agent throws); `refuseUnlessTreasury` now reads `rootPayer`. |
| team create `:937`, invite `:1637` | **leaf** `wire.delegator` vs a **required** argument | **Kept.** The verifier binds the chain's root to the resolved party, which falls back to the agent asked when the argument is empty. These refuse an empty argument, and refuse a child chain these invokers cannot redeem (they use the leaf alone). |
| fund `:1819`, primary payee `:1865` | leaf `wire.delegator` vs an optional argument | **Kept.** Both act as the leaf's delegator and redeem `[wire]` alone; the verifier checks the root. For a chain of one they repeat the verifier — cheap, and they are the only thing naming the single-link assumption. |
| grant revoke `:1970, :1989, :1998`; friend remove `friend-offers.ts:358` | delegator vs the **person**, and the stored grant's issuer vs the delegator | **Kept.** Not about the step's authority argument at all. |
| `asSelf` `:2282, :2336` | root delegator == person | **Kept.** Chooses the rail (the agent's own, no session); not an authorization duplicate. |

Not changed, worth knowing: `memberRoleSetInvoker` and `credentialIssueInvoker` (`:2597, :2602`) take the **leaf's**
delegator as the organization. Both capabilities declare `authorityArg: 'org'`, so the verifier now guarantees the
root is the org — but under a child chain the leaf's delegator is the delegate key, not the org.

Approval port (`:1511-1527`): comment rewritten to cite `chain-not-attenuated` and `chain-root-not-principal`. Confirmed
in `orchestration/src/loop.ts:455-500` that `approvalPort.request` is called only with the evidence of a `verify` that
did not deny, and that the loop verifies again after the approval. The port's own check (the leaf's immediate parent
is a standing wire and is hers) is kept — the verifier does not ask it.

**Verified:** typecheck; new `apps/agent-runtime/test/harness-principal.test.ts` (7 tests) — five on the rule, and a
run through `runUnderMandate`: a mandate signed by another account is denied `chain-root-not-principal` and nothing is
sent; the same wire from the person gets past that rule and is refused for having no caveats. Before this file no
test in ap-home drove `runUnderMandate` with a presented mandate.

### 2. `delegation` `createPresentationRelease` — `holder` + `chain` (done)

- `apps/agent-runtime/src/index.ts:7381` — the runtime sends `holder: asker.toLowerCase()` to the prover. `asker` is
  the person whose vault the credential and device key were read from two lines earlier; it is not read from the wire.
- `apps/holder-prover/server.mjs:91-104` — `/present` requires `holder` (400 without it), parses the standing wire's
  salt, and passes `holder` and `chain: [child, standing]`.
- `apps/agent-runtime/src/reader-pass.ts` does not construct a release; it builds the standing wire and derives the
  child. No change.

**Verified:** four new tests in `apps/agent-runtime/test/reader-pass.test.ts` build the release exactly as the prover
does, from a real `buildReaderStanding` + `readerChildMandate`: allow under her wire; deny `chain-root-not-principal`
for another holder; deny on the next call once the standing wire is revoked; deny an audience her wire does not name.
**Not verified:** `server.mjs` itself (`node --check` only — it needs the 274 MB proving key and a key service).

### 3. `delegation` `verifyAuthorityChain` / `assembleAuthorityChain` (not applicable)

No direct caller. No site forwards the presented array to redemption: the payment invoker (`harness-run.ts:2702-2722`)
walks `authority` hashes from the leaf and pushes each parent, refusing a missing one — leaf first, root last. Every
other `redeemDelegation` call (`:1827, :1927, :2030`, `friend-offers.ts:376`) redeems one wire.

### 4. `a2a/standard` push notifications (done — cards now say false)

**This runtime does not deliver push.**
- The Worker's standard server (`standard-a2a.ts:160-181`) is handed `createMemoryPushStore()` — a per-isolate map —
  and delivers with the package's default fetch, which nothing keeps alive past the response.
- A delegated task's events happen in the agent's object. Its server (`a2a-task-do.ts:1376`) is rebuilt per request
  with a fresh in-memory push store, and the runtime behind it is built with no `pushSender` (none anywhere in
  `apps/agent-runtime/src`).
- No client in ap-home registers a push config.

What changed:
- `index.ts:1421` (`standardCardFor`): no opt-in. `withStandardCardFields` used to force `true` over a live card that
  says `false` (`host-context.ts:400`); with the new package the served card and the server built from it agree. The
  doc comment says what opting in would need.
- `a2a-task-do.ts:1391`: `pushNotifications: true` → `false`.
- `host-context.ts:400` and `apps/home/app/external-agent/card/card.ts:10` already said `false`.

**Behaviour:** `capabilities.pushNotifications` on every served card goes `true` → `false`; a push config is answered
`PushNotificationNotSupported`.

Ring 0 gap found: an inline `taskPushNotificationConfig` on a **delegated** task is forwarded by
`a2a/src/standard/from-agent.ts:130` (`beforeSend`) to the runtime as `pushConfig` and stored on the task record
without the capability check or the URL policy. Nothing delivers it here (no `pushSender`); a host that wires one
would POST to an unchecked URL.

### 5. `payments` `x402.createX402Rail` (done — one builder; no rail in ap-home)

No `createX402Rail` and no `settle` call anywhere in ap-home. The one place a payment mandate is built is
`apps/home/src/connect-client.ts:257-290` (`chargePayment`): it now sets `delegationRef = hashDelegation(delegation,
CHAIN_ID, delegationManager)` (`:270, :280`); the payer was already the delegation's own delegator. Checked that
`buildRedemptionCalldata` reads only `mandateId`, `nonce`, `payee` and the amount, so the calldata is unchanged.
**Verified:** home typecheck at the 13:26 builds; the home suite in the 13:45 run (1095/1099, the four failures unrelated).

### 6. `fabric` exchange store `insert` / insert-only delivery (not applicable — confirmed)

ap-home injects no `exchangeStore` or `interactionStore` (`gateway-mount.ts:78-91`, `interactions-do.ts:1460-1499`) and
calls only `verifyAndCache` + `invokeFast` on the mounted gateway (`:1513-1530`) — one vault read. No code delivers
through the gateway, reopens an ended interaction through fabric's stores, or re-puts an exchange under a held id.
`apps/home/src/home/inbox-data.ts:347,425` uses `createAuditedInteractionStore(...).applyEvent` over the Home's own
store, through the reducer.

### 7. `acp` `AcpHost` / `runtime-member` `classify` (blocked — nothing to wire, and it will fail closed)

ap-home constructs no `AcpHost` and no `RuntimeMemberLoop`. The one place a runtime member runs is the Container
(`apps/agent-runtime/runtime-container/Dockerfile`), whose entrypoint is the package's own CLI: `ap-runtime serve
--member … --agent …`. That CLI has `--allow-local` and no way to supply a classifier.

- `claude-code-acp`: no field of a permission request is known to be outside the model's reach. No classifier written.
- `acp-stub-agent`: the stub does set an adapter mark (`_meta.mcp.server`), but only the CLI could read it.

So once the image runs the new versions, **every permission prompt in the Container is refused, workspace tools
included**, for both agents. `scripts/verify-runtime-wake.mts:120` asserts `workspace tool allowed` and will go red.

The image pins its own versions (`ARG RUNTIME_MEMBER_VERSION=0.0.0-alpha.4`, `ARG ACP_VERSION=0.0.0-alpha.4`), far
behind the repository's `runtime-member` pin (alpha.27) and npm's `acp` (alpha.23). Until those two ARGs move, the
Container keeps running the old host — the one that classifies from agent-written text.

Also found: `scripts/verify-runtime-acp-member.mts:31-32` and `scripts/verify-cast-messaging.mts:21-23` import
`../packages/acp/…` and `../packages/runtime-member/…`, paths that do not exist in this repository.

### 8. `estate-projection` / `admission` foreign-estate (not applicable)

ap-home uses `credentialDigestOf` and `estateIdOf` (unchanged) and, in `apps/edge`, `meetsTransportAssurance` /
`observedTransportAssurance`. No `commitmentOf`, no presentation, no `foreignEstateEvaluator`.

### 9. `context` party resolution — inventory only

ap-home builds no providers; it passes its `HarnessDeps` (`resolveName`, `readSubjectRecord`, `charteredAgents`,
`verifyGrant`, …) as the lookups and the package does the rest. All in `apps/agent-runtime/src/harness-run.ts`:

| Site | What it resolves | A non-resolved outcome |
| --- | --- | --- |
| `:4034` (`resolveStepArgs`, first arm) | every party argument of a step, with `types`, `room`, `nearest`, `capabilityId`, `consults`, `subject` | `resolveParty` throws `InputRequired`; not caught here — the loop suspends the run with the question. A bare address, the asker's own agent for a `NEVER_THE_ASKER` argument, "us" in a room, and an empty optional party are handled before the call. |
| `:4269` (second arm of the same function) | the same, without `consults` | same |
| `:6577` (`resolveExecutor`) | the plan's `executor` word | throws `InputRequired`; an executor equal to the addressee becomes `undefined` (runs here) |
| `:6603` (`onResolved`, passed by `normalizeArgs`) | records each decided party in `resolved`, keyed `arg:agent`, keeping the labelled record | not called when nothing resolved |

`onResolved` is also called directly by the acting-party rules at `:3790, 3805, 3819, 3829, 3858, 3938, 3971, 3991,
4004, 4031, 4138, 4148, 4177, 4239, 4266`. Two fallbacks read the public naming registry outside `resolveParty`:
`partyAddress` (`:1764`, dotted names only, throws otherwise) and `authorityPartyFor` (`:2413`, item 1). Spec 385's
confirmation memory is written at `apps/agent-runtime/src/index.ts:5750`.

### 10. The production preflight (comments corrected; no preflight exists)

`scripts/check-production-deploy.ts` exists nowhere. `docs/split-status.md:53` already records it as "not carried".
Four comments in `apps/vault/src/index.ts` cited it or "the preflight" as enforcing something; each now says what
actually holds: `:422-433` (`A2A_MAC_SECRET`), `:776-778` (service-mac middleware — enforced per request, 401),
`:2340-2343` (`update_profile` classification, N10.2), `:2402-2408` (the `/_dev/seed` guard). `:760` and
`worker-routes.test.ts:52` refer to a different, real check and are untouched.

What ap-home has today:
- `apps/agent-runtime/scripts/deploy.mts` (also each estate's wrangler `build.command`): the vault's `/health` names
  the catalog door. One check, agent-runtime only, with an acknowledged skip.
- `pnpm check:estate-shape`: vars and secret names against each estate's declaration; CI runs it `--no-secrets`.
- `pnpm run doctor` (`ap doctor`): static rules — `web-no-direct-mcp`, `no-private-keys`, `no-hmac-home-bridge`,
  `no-cross-subject-vault-reads`, `fail-open-knobs`, `internal-marker-split`, `custodian-coverage`,
  `archetype-catalog`, `capability-vocabulary`, `demo-person-org-distinct`, `rules-drift`, `lock-coherent`. Not run
  here: it reads the pins, and the override made them incoherent by design.
- CI (`.github/workflows/ci.yml`): typecheck, tests, doctor, census, gate fixture, estate shape. `estate-deploy.yml`
  tests and deploys the estate site only.

None of these is a production preflight for the vault or the runtime. One would need to check, per estate, before
`wrangler deploy`: every required secret is present by name (with secrets, not `--no-secrets`); no route is
registered outside a production guard (`/_dev/*`); every tool route has a classification; the bundle was built with
`NODE_ENV=production`; no fail-open knob is set in the target env; the contract addresses and `CONTRACTS_GENERATION`
match the published deployment record; the runtime Container's image pins equal the repository's pins.

## Pins to bump once published

Each to "the next published version" of that package. `agentic.lock.json#packages` carries the same eleven entries
and moves with them (`ap upgrade --pin`).

| Package | Current pin | Files |
| --- | --- | --- |
| `@agenticprimitives/harness` | `0.0.0-alpha.30` | `apps/agent-runtime/package.json`, `apps/home/package.json` |
| `@agenticprimitives/delegation` | `1.0.0-alpha.46` | `package.json`, `apps/agent-runtime`, `apps/home`, `apps/home-mcp`, `apps/vault`, `apps/holder-prover` |
| `@agenticprimitives/a2a` | `0.0.0-alpha.48` | `package.json`, `apps/agent-runtime`, `apps/home`, `apps/home-mcp` |
| `@agenticprimitives/payments` | `0.0.0-alpha.42` | `apps/home` |
| `@agenticprimitives/fabric` | `0.0.0-alpha.39` | `package.json`, `apps/agent-runtime`, `apps/home`, `apps/shared` |
| `@agenticprimitives/runtime-member` | `0.0.0-alpha.27` | `package.json`, `apps/home` |
| `@agenticprimitives/service-host` | `0.0.0-alpha.27` | `apps/agent-runtime` |
| `@agenticprimitives/estate-projection` | `0.0.0-alpha.21` | `apps/agent-runtime` |
| `@agenticprimitives/admission` | `0.0.0-alpha.21` | `apps/edge` |
| `@agenticprimitives/context` | `0.0.0-alpha.28` | `apps/agent-runtime` (item 9, when it lands) |
| `@agenticprimitives/orchestration` | `0.0.0-alpha.27` | `package.json`, `apps/agent-runtime` (changed in Ring 0, not linked here) |
| `runtime-member` in the Container image | `0.0.0-alpha.4` | `apps/agent-runtime/runtime-container/Dockerfile` `ARG RUNTIME_MEMBER_VERSION` |
| `acp` in the Container image | `0.0.0-alpha.4` | same file, `ARG ACP_VERSION` |

`harness` and `delegation` are the two this branch cannot build without. Ring 0's local `master` is one release commit
behind `origin/master` (#741), so its `package.json` versions read one lower than these pins.

## How it was verified

`pnpm.overrides` with `link:` to the ten Ring 0 package directories, `pnpm install --config.strict-peer-dependencies=false`
(the strict install rejects the peer range), then `pnpm -r typecheck` and `pnpm -r test`. No duplicate-instance type
errors appeared.

| When | Ring 0 builds | Typecheck | Tests |
| --- | --- | --- | --- |
| Baseline, published pins, no changes | — | 0 errors | 2989 pass across six apps (agent-runtime 1679, home 1099) |
| Items applied, app by app | 13:26 | agent-runtime 0 errors after item 1, home 0 after item 5 | agent-runtime 1679/1679 after item 1; the 11 new tests pass |
| Same tree | 13:42–13:45 rebuild | 18 errors (16 RUN-9, 2 DATB-3) | agent-runtime 1673/1690, home 1095/1099 — 19 on RUN-9, two 5 s timeouts (`friend-offers`, `rotation`) not re-run |
| Overrides removed, published pins | — | 2 errors, both `principalFor` | not run |

No single run has all ten items against the 13:26 builds: Ring 0 was rebuilt before one could be made. The 13:45 run
is the only full typecheck and test run with every change in; all 18 errors and all 19 non-timeout failures are in
the table at the top, and none is in a file this branch touches except through the session-wire call sites.

Not verifiable here: anything live (the act-as-me chain, the runtime wake, the reader's proof end to end, the x402
charge); `server.mjs`; `ap doctor`.

## What users of ap-home will see

- A mandate signed by anyone other than the party the step needs is refused `chain-root-not-principal`, where it
  used to be judged on its own caveats. A child wider than its standing wire is refused `chain-not-attenuated`.
- Agent cards say `pushNotifications: false`.
- A reader's proof is refused if the standing wire is revoked, or is not the holder's.
- After the Container image is bumped: every tool-permission prompt in a runtime member is refused.
- Nothing changes for payments in the connect ceremony.

## Open questions

1. **Scope.** RUN-9, DATB-3 and RUN-12 landed in Ring 0 during this work. Adapt ap-home to them on this branch, or
   in a follow-up once Ring 0 is frozen?
2. **DATB-3.** Which record is "a current member" for consult eligibility — the directory listing, the membership
   credential, the invitation record?
3. **Runtime Container.** Should Ring 0's `ap-runtime serve` ship a named classifier for `acp-stub-agent`, or does
   `verify-runtime-wake.mts:120` change to expect a refusal? For `claude-code-acp`, is any adapter field vetted?
4. **Child chains.** Should team create, invite, fund, primary payee, member role and credential issue work under an
   act-as-me child chain? Today they act on the leaf's delegator, so they refuse or act as the delegate key.
5. **Legacy `/harness/run`.** It passes no addressee, so the party falls to the signed-in person. Correct, or should
   the route require one?
6. **Prover signature check.** `server.mjs` passes `hashMessage(digest)` to the validator, the runtime passes the
   raw digest. A custodian-signed standing wire verifies both ways; one approved by the approved-hash sentinel
   (`0x03`) would not verify in the prover. Does a reader pass ever use the sentinel?
7. **Push.** Is real push delivery wanted? It needs a durable store, a wired sender and a host resolver.
8. **Preflight.** Who owns writing the production preflight, and does it gate `wrangler deploy` through
   `build.command` as the vault check does?

---

## 2026-11-10 — second pass — .impact retirement, naming, tooling

Same worktree, nothing committed, pushed or deployed; no live service called; `/home/barb/ap-home` untouched.
Scope: the owner's decision to retire the `.impact` NAME root, the `agent-naming` NAME-8 API, `agent-profile` NAME-7,
and devkit NAME-10 / REM-1 / REM-3. Not touched: the product "impact-agent", its hostnames, `[env.impact-agent]`,
the vault key `impact-profile`, the brand default "Impact".

**This pass also does not build against the published pins**: it imports `confirmDnsHost`, `dnsHostReadings`,
`labelClaimViolation` and passes `root` to `buildSubregistryRegisterCall` (agent-naming, unpublished).

### What "bare label" means now

`AGENT_NAME_PARENT` (runtime `host-context.ts:22`, Home `lib/domain.ts:21`) defaults to **`me`**, not `impact`: a bare
label is a person (`alice` → `alice.me`, host `alice.<zone>`). Every other kind is named under its typed root. No code
path can produce a `.impact` name: the two `subregistryForTld` functions (runtime and Home) no longer have an untyped
branch — **a claim that names no suffix is refused** (`suffix_required` at the runtime; "no naming root for that kind
of agent" at the Home), where it used to register under `.impact`.

### Config changes (apply the matching var at deploy)

| File | Before → after |
| --- | --- |
| `apps/agent-runtime/wrangler.toml:192` (`[env.faithnet.vars]`) | `AGENT_NAME_PARENTS = "me,impact"` → `"me"` |
| `apps/agent-runtime/wrangler.toml:717` (`[env.impact-agent.vars]`) | `AGENT_NAME_PARENTS = "me,impact"` → `"me"` |
| `apps/agent-runtime/wrangler.toml:360-366` | comment only: says what `PERMISSIONLESS_SUBREGISTRY` is now |
| `.mcp.json`, `.cursor/mcp.json` | `npx ap mcp --root .` → `node node_modules/@agenticprimitives/devkit/bin/ap.mjs mcp --root .` (the template's files, byte for byte) |

**Not in the repo, must be checked by hand:** the Home's Vercel variables `NEXT_PUBLIC_AGENT_NAME_PARENTS` and
`NEXT_PUBLIC_AGENT_NAME_PARENT` (faithnet's Home and imb-home). If either still lists `impact`, set it to `me` (or
delete it — the default is now `me`). Both the runtime (`nameParents`) and the Home (`knownRoots` in `domain.ts`) now
DROP a root the naming package does not know and log a warning, so a stale `me,impact` degrades to `me` instead of
throwing `unknown_tld` on every bare host — but the var should still be fixed.

**`PERMISSIONLESS_SUBREGISTRY` — kept, on purpose** (`wrangler.toml:366` faithnet `0x9E80…11CC`, `:817` impact-agent
`0xa91c…3719`; `scripts/estate-shape.mts:118,245`; Home `CONTRACTS.permissionlessSubregistry`). It IS only the `.impact`
subregistry, and no name is claimed through it any more (reader removed from `subregistryForTld`, `index.ts:9095`).
But it is still the third allowed target of every oversight/stewardship wire (`apps/shared/src/oversight-targets.ts`,
the other engineer's file from this morning: `oversightMintTargets`), and removing the var changes the caveat terms of
newly minted wires. That file already has the exit (`retiredTargets`: "addresses wires minted in the past may still
name; never minted") — dropping the var is one decision for the owner of that change, not part of this pass.
Also still naming it: `scripts/record-service-stewardship.mts:39`, `charter-cast.mts:33,191`,
`provision-estate-fixtures.mts:153`, `gen-dev-vars.ts:79,185`, `equip-cast-*.mts`, `apps/home/src/home/runtime-pairing.ts:97`.

### Possible live .impact names (confirm against the registry before the pin bump)

Nothing below was checked against a chain. After the bump these names do not resolve, route or sign in — they fail
closed, they do not degrade.

- `scripts/fixture.mts:93` — `workspace: { handle: 'alicefield.impact', agent: 0xee11…682c }` (faithnet gate fixture;
  `verify-mention-into-run.mts:37` resolves it by name; also `verify-ask-surface.mts:34`, `verify-harness-team-create.mts:38`).
- `scripts/fixture.mts:101` — `routineAgent.handle: 'playwright-demo-team.impact'`. The generated host list has
  `playwright-demo-team-team.faithnet.io`, i.e. a typed `playwright-demo-team.team` exists too.
- `scripts/verify-subject-hop-wire.mts:20-21` — `alice-home-church.impact` at `alice-home-church.faithnet.ai`, with the
  comment "`.impact` is a name PARENT on faithnet". The old `host-context.ts` comment said `alice-home-church.impact`
  and `alice-home.church` are "both real names on this estate".
- `scripts/verify-ask-confirmation-memory.mts:17` — "alice's live estate … `somali-corridor-team.impact`" (host list has
  `somali-corridor-team-team.faithnet.io` = `somali-corridor-team.team`).
- `tests/e2e-sso/dm-scoped-picker.spec.ts:16` — default scope `russian-team.impact`.
- `tests/e2e-sso/commons-invite-email.spec.ts:108` — co-member `rich-global.impact`.
- `apps/agent-runtime/wrangler.toml:495+` (generated by `sync-agent-hosts.ts` with parents `me,impact`) — 36 hosts. Bare
  labels that are `.me` OR `.impact` and cannot be told apart from the file: `alice bob carol dave david elena nathan
  erie-1001 imbreg jpreg rich-google rich-siwe weld-north-discovery-cir`. Labels ending in a type word that are either
  a typed name or a `.impact` name with that label: `accelerate-team`, `alice-home-church`,
  `evans-somali-house-church`, `fort-morgan-household-church`, `night-prayer-circle`, `thursday-discovery-circle`,
  `womens-discipleship-circle`.
- `apps/home/src/whitelabel/config.ts:301,389,409,460,1226-1240` (comments, now reworded to `.svc`/`.org`) named
  `skills-agent.impact`, `engage-service.impact`, `field-service.impact`, `lbsb.impact` as the identities sibling apps
  sign AS; `apps/home/scripts/provision-service-agent-local.ts:5-6` adds `gather27-workspace.impact`. Those apps
  (skills-a2a, engage-a2a, field-a2a, gather27-a2a) live in other repos.
- `docs/split-status.md:20` — treasury Workers "pinned to `lbsb-treasury.impact`" (ap-demos; left as a record).
- **Existing people.** Any person whose only name is `<label>.impact`: `readClaimedRoots` no longer lists the root
  (`connect-client.ts:334`), `/connect/name-info` gets the name back untouched from `qualifiedAgentName` and the
  naming client throws on it, and their `<label>.<zone>` host resolves only if `<label>.me` exists.

The six live-fixture names in the first five bullets were **left unchanged**: each is bound to a real address or a
live roster, and inventing a typed name for it would be a fabricated fixture. Give me the real names and they are a
six-line edit.

### Call sites changed

JOB 1 — runtime
- `apps/agent-runtime/src/host-context.ts:15-40` — default `me`; new `nameParents(env)` (one parser, drops unknown
  roots with a warning). `:98-110` `AgentHostContext.ambiguous`.
- `apps/agent-runtime/src/index.ts:1819, 2585, 6680, 7237` and `self-hosted-read.ts:42` — the repeated
  `AGENT_NAME_PARENTS ?? … ?? AGENT_NAME_PARENT` expression → `nameParents(env)`.
- `index.ts:9095-9133` `subregistryForTld` — untyped branch removed; takes the label and applies `labelClaimViolation`.
  `:6528, 8560-8563, 8974-8975, 9226-9230, 9325-9330` — callers lose `root.typed ? … : …`; the name is `<label>.<root.tld>`.
- `apps/agent-runtime/src/interactions-do.ts:6050-6052` — a bare recipient label is `<label>.me` (was `.impact`).
- Comments: `index.ts:5744`, `harness-run.ts:3594` (one word each, in files the other engineer is editing).

JOB 1 — Home
- `apps/home/src/lib/domain.ts` — default `me`; `knownRoots`; `NEW_PERSON_TLD = 'me'`; `toAgentName` no longer keeps a
  `.impact` name.
- `apps/home/src/connect-client.ts:312-320` `subregistryForTld` (no `CONTRACTS.permissionlessSubregistry`), `:334`
  `readClaimedRoots`, `:412-432` new `tldOfKind` + `KIND_ROOT`, `personClaimRoot` always `.me`, `childDiscoveryRecords`,
  `createSecureHomePasskey` and the workspace passkey label (`<label>.me`), three "already taken" messages.
- `apps/home/server/connect/name.ts` — default suffix must be claimable; refuses a label the SDK's claim rule refuses
  (400 with the reason; the forced-unique picker skips such a candidate).
- UI: `ManagedAgents.tsx`, `TreasuryChooser.tsx` (suffix shown = `tldOfKind`), `ClaimPublicNameCard.tsx`,
  `ChangeNameCard.tsx`, `AgentRegistryListing.tsx`, `OrgChooser.tsx:221` (`{slug}.org`), `org-chooser-label.ts`,
  `app/move/page.tsx`, `app/invite/[token]/page.tsx:58`, `ui/index.tsx:216`, `lib/studio-view.ts` (copy),
  `apps/home-mcp/src/tools.ts:236`.
- Scripts: `apps/home/scripts/provision-demo-personas-local.ts` (`.me`), `provision-service-agent-local.ts` (`.svc`, now
  declares the type), `apps/agent-runtime/scripts/canonical-a2a-e2e.ts` (`.me` from the deployment record; the
  hardcoded `.impact` subregistry is gone), `sync-agent-hosts.ts:29`, `scripts/place-on-deployment.mts:36`.
- Tests: 21 files moved to typed names. `agent-runtime/test/typed-naming-endpoints.test.ts` and
  `home/src/lib/person-claim-root.test.ts` now assert the ABSENCE of the untyped branch.

JOB 2
- `host-context.ts:157-200` `resolveAgentByLabel` — **done.** A bare label goes through `confirmDnsHost` (every reading
  resolved, not first-hit); `ambiguous` returns no agent and lists the holders, and the three routes answer 404 with
  "held by more than one agent" (`index.ts:1740, 6055`, and `/api/a2a/:handle`). A reserved label (`www api mtls edge`)
  is the generic endpoint. The reader is the deployment's `AgentNamingClient.resolveName` — the registry record
  name → agent. I did NOT add "the name's `a2aEndpoint`/`cardUri` must name this host": on these estates most names
  publish no endpoint (`A2A_SERVES_UNPUBLISHED_NAMES`), so that check would refuse nearly every host. 8 new tests.
- `buildSubregistryRegisterCall` `root` — **done**: `index.ts:6558, 8563, 8975, 9229, 9328`; `connect-client.ts:529,
  1031`; `provision-typed-service-agent.ts:131` and the three scripts above.
- `hostForName` null — `subject-address.ts:45` and `place-on-deployment.mts:54-55` **already handled it** (filter /
  "no host on that zone"); the other six `index.ts` sites all test `!host`. One real gap fixed:
  `apps/home/src/lib/studio-view.ts:705` (`cardUriForName`) fell through to joining the labels and printed
  `foo-org.<zone>` for `foo-org.me` — the colliding host. It returns null now.
- `fetchProfile` (`index.ts:1843`) — **no change, reported.** Nothing in ap-home writes `atl:metadataURI`; the URL is
  whatever the agent set. The runtime passes no `profileFetch` options and a Worker has no `resolveHost` to give. An
  agent whose profile URL is http, redirects, is over 256 KiB, slower than 5 s or not served as JSON now makes
  `fetchProfile` throw `ProfileFetchError`, and `agent-card-studio.ts:525,1244` do not catch it — the Card Studio
  fails to open for that agent (it already did for a hash mismatch).

JOB 3
- `.mcp.json`, `.cursor/mcp.json` — **done.** `bin/ap.mjs` exists in the installed alpha.34, so this works before the bump.
- `apps/home/app/llms.txt/route.ts:24,34,39`, `scripts/verify-devkit-starter.mts:33-34` — **done** (`pnpm exec ap`).
  `verify-devkit-starter.mts:35` asserts `12 rule(s) clean`; the new devkit has 13 rules — it will need `13` once the
  starter is generated at the new pin (not changed: it tests whatever `DEVKIT_PIN` is).
- `agentic.lock.json#definitions` — **not re-pinned** (needs the network). With the new devkit `ap doctor` fails
  `definition-pins`: "5 of 5 pinned definition(s) do not verify … no snapshot". After the pin bump, run once and
  commit `agentic.lock.json` + `.agentic/definitions/`:
  `pnpm exec ap upgrade --pin-definitions https://skills-a2a-production.richardpedersen3.workers.dev agentic-trust/org-steward,agentic-trust/person-steward,agentic-trust/coordinator,agentic-trust/treasury-steward,agentic-trust/household-steward`
  It re-computes each digest locally and refuses a registry whose claimed digest is not its content's. If a digest
  differs from the five recorded today, that is a real definition change since the old pin — review it before committing.
  Until then CI's `pnpm exec ap doctor` step is red.
- `rules-drift` also fails under the new devkit (4 findings): the `service-agent-signing` rule changed in Ring 0
  (`<name>.impact` → `<name>.svc`). `pnpm exec ap doctor --rules --write` after the bump re-projects
  `.cursor/rules/service-agent-signing.mdc`, `AGENTS.md`, `CLAUDE.md` and the lock digest. Not hand-edited.
- Custom doctor modules: **one** — `agentic.lock.json#doctor.archetypeCatalog.module =
  apps/home/src/lib/archetype-catalog.ts`. `ap doctor` at a terminal still runs it (prints the path first); under the
  Developer MCP it is listed under `notRun` and `archetype-catalog` is not judged there. Converting the catalog to
  `.json` would make it data.

### Verified / not verified

`pnpm.overrides` had the other engineer's five links (context, ontology, fabric, harness, delegation); I added
agent-naming, agent-profile, devkit, rebuilt the first two in Ring 0 (dist was older than src), and removed only my
three afterwards. `package.json` now differs from HEAD only by their five lines; `pnpm-lock.yaml` is unchanged.

| | Typecheck (`pnpm -r --no-bail typecheck`) | Tests |
| --- | --- | --- |
| First run with my links (14:20) | 3 errors, all agent-runtime, none in this pass: `consult-rail.ts:149`, `interactions-do.ts:3966` (DATB-3), `harness-run.ts:5331` (`principalFor`). home, home-mcp, vault, edge, shared, estate clean | agent-runtime 1713/1715 — the two failures are `test/harness-principal.test.ts`; home 1105/1105; home-mcp 25/25 |
| Second run (14:22) | 21 errors: the same 3 + 18 × "Expected 4 arguments, but got 3" on `loadPlaybook` — `harness` was rebuilt in Ring 0 between the runs | host-context / typed-naming / subject-address / card-studio: 101/101 |

No duplicate-instance type errors appeared. The RUN-9 session-wire errors in the table at the top did not appear in
either run (the `a2a` package is not linked in the current overrides).

Not verified: anything live; the three provisioning scripts and `canonical-a2a-e2e.ts` (need a chain);
`tests/e2e-*` (Playwright); `check:estate-shape`; whether a `.me` root is provisioned on every chain the Home is
built for (a chain without one now refuses person claims instead of using `.impact`); the full agent-runtime suite
after my last two edits (`index.ts:1740, 6055` message text, `provision-typed-service-agent.ts:131`).

### Pins to bump

| Package | Current pin | Why |
| --- | --- | --- |
| `@agenticprimitives/agent-naming` | `1.0.0-alpha.46` | `confirmDnsHost`, `dnsHostReadings`, `labelClaimViolation`, `root` on the register call; `.impact` refused |
| `@agenticprimitives/agent-profile` | `1.0.0-alpha.46` | NAME-7 fetch guard (no source change here) |
| `@agenticprimitives/devkit` | `0.0.0-alpha.34` (lock says devkit `alpha.33`) | `definition-pins`, read-only MCP |
| `@agenticprimitives/create-app` | not a dependency — `scripts/verify-devkit-starter.mts` resolves it | templates launch the MCP by path |

### Open questions

1. The six live fixture names above — what are they called now?
2. `PERMISSIONLESS_SUBREGISTRY`: drop it from the mint and move both addresses to `retiredTargets`?
3. A person who holds only a `.impact` name: is there a migration (claim `.me`, re-point the primary name), or is that
   population empty?
4. Runtime claim refusals answer 503 (`suffix_required`, `label_not_claimable`) because every caller maps
   `subregistryForTld` errors to 503. A 400 would be more accurate; it is four call sites.
5. `ProfileFetchError` in the Card Studio: fail the page, or treat as "no verifiable profile" and use the computed
   stand-in?
6. `.cursor/rules/service-agent-signing.mdc`, `AGENTS.md`, `CLAUDE.md` still say `<name>.impact` until the rules are
   re-projected. `docs/split-status.md:20`, three specs and CHANGELOGs keep it as history.

---

## 2026-11-10 — second pass — standing, membership, consult, questions

Same worktree, same rules: nothing committed, pushed or deployed; no live call. Ring 0 source is
`spec-445-w0-hardening` (unpublished). A second engineer was retiring the `.impact` root in this tree at the same
time; nothing of theirs was reverted. Line numbers are as of 14:35 and will drift under their edits.

### 1. Stewardship is established positively (RUNC-1 / STEWARD-SHAPE-CONFUSION-1) — done

**The governance-target set, and where it comes from.** New shared module `apps/shared/src/oversight-targets.ts`
(re-exported from `@ap-home/shared`), pure:

| Function | Value |
| --- | --- |
| `oversightGovernanceTargets` (every wire MUST name) | `[AGENT_RELATIONSHIP, AGENT_NAME_REGISTRY]` |
| `oversightAlsoPermittedTargets` (a wire MAY name) | `[PERMISSIONLESS_SUBREGISTRY, …retiredTargets]` |
| `oversightMintTargets` (what the mint writes, in its historical order) | `[AGENT_RELATIONSHIP, AGENT_NAME_REGISTRY, PERMISSIONLESS_SUBREGISTRY]` — the third only when configured |
| `oversightCheckInputs` | the five inputs `chainStewardshipCheck` needs, from the same contracts |

It was derived from the minters, not from the brief: there are exactly two, and both build
`[timestamp(0, until), value(0), allowedTargets]` — `siteGrantCaveats` (`apps/agent-runtime/src/index.ts:8784`) and
`siteCaveats` (`apps/home/src/lib/delegation.ts:53`). Every `stewardshipDelegation` in the repo comes from one of
them (`buildApprovedSiteDelegation`, `issueSiteDelegation`, the runtime's `mintOrgSiteGrant` / genesis). Both now
take their targets from `oversightMintTargets`, so mint and check read one list. The mint's bytes are unchanged
while the subregistry is configured.

Call sites changed:
- `apps/agent-runtime/src/index.ts:2753, 2903, 2996, 5521, 6925, 7105, 11942` — the seven `chainStewardshipCheck`
  calls take `...oversightCheckInputs(oversightContractsFromEnv(env))` (replacing `allowedTargetsEnforcer` +
  the now-ignored `vaultRecordScopeEnforcer`).
- `apps/agent-runtime/src/interactions-do.ts:1774` `hasStewardshipShape` — the local test (which EXCLUDED
  allowedMethods and record scope, and so admitted any third kind) is replaced by the package check through
  `@ap-home/shared/oversight-check` `oversightShapeCheck`; `isSteward` (`:2315`) awaits it, then runs `verifyWire`.
- `apps/home/server/_lib/verify-stewardship.ts:19, 36` — the negative test is replaced by the same
  `oversightShapeCheck`, fed `OVERSIGHT_CONTRACTS` (`apps/home/src/lib/chain.ts:173`); its own `verifyDelegation`
  and revocation read follow, unchanged.
- `apps/shared/package.json` — new dependency `@agenticprimitives/context` and a `./oversight-check` export (kept
  off the root export so the browser bundle that mints does not pull in the context package).

`oversightShapeCheck` is the package's `chainStewardshipCheck` asked with a chain that answers "signed, unrevoked"
— it returns the package's binding + positive-caveat verdict and nothing else, because Ring 0 exports no shape-only
predicate and both callers already have chain verification with behaviour the package's lacks (the DO's memo, the
Home's bounded retry). No other re-implementation was found (`library-tools.ts:560-570` and `card-room-club.ts`
call `deriveStanding` / the injected `verifyStewardship`).

Behaviour change to know: an EXPIRED oversight wire no longer reads as stewardship in the runtime's standing reads
(the package checks the window; before, only the DO and the Home did).

### 2. Membership is two-sided (RUNC-2) — done

- `apps/agent-runtime/src/coordination-bindings.ts:238` — `!belongs(standing)` (was `relation === 'none'`).
- `apps/agent-runtime/src/harness-run.ts:1316` — a routed hop's standing is lifted only for
  `self | steward | member` (`BELONGING_RELATIONS`, `:1306`); was `!== 'none'`.
- `apps/agent-runtime/src/harness-run.ts:5420` — the run's standing (`standingOnce`) records `claimed` as
  `none` with the package's sentence kept in `because`. Reason: `ExecutionBindingV1.standing.relation` in
  `orchestration` has no `claimed`, and everything read from this value (asker context `:5738/5807`, the offer by
  standing `:5944-5951` whose rank table would have treated an unknown relation as "lacks nothing", the regression
  facts) must treat it as no link.
- `apps/agent-runtime/src/harness-run.ts:4643` — the up-front refusal of an authority-bearing act keeps firing for
  `claimed` (before today that asker read as `member` and was refused here).
- `apps/home/src/components/portal/ask/AskFlyout.tsx:1274` — the "Done by … as a …" line names the three relations
  that are standing. `apps/home/src/home/ask.ts:94` — the reply type admits `claimed`.
- Checked and already correct: `index.ts:2758, 2908, 7113, 11947`, `card-room-club.ts:128`,
  `library-tools.ts:560/570` (each tests for a specific relation).

**What the UI shows for `claimed`:** not a member. No copy was added: the "Ask a steward" button (`AskFlyout.tsx:1376`)
shows only for `member`; the refusal text is the package's own (`standingNote`: "your own records link you to X, but
X holds no record of you as a member"). There is no pending-membership state in the UI today.

### 3. Secrets are never askable (REM-2) — confirmed, no code change

- The pairwise derivation reads its secret directly and by exact key: `pairwiseSubjectPort`
  (`apps/agent-runtime/src/subject-hop-credential.ts:20-33`) → `deps.readSubjectRecord(person,
  'identity.pairwise-secret')`. It does not go through `vaultQuestionInvoker`. The grant scope
  (`APP_IDENTITY_SCOPES`, `APP_CREDENTIAL_SCOPES` in `apps/shared/src/index.ts`) stays as it is.
- The only vault-question path is the package's (`index.ts:5426`); the app defines no record bindings and no
  askable-kind list, and no Ask or inventory UI enumerates record kinds.
- No tool reads a record whose key comes from a planner argument.

### 4. Consult eligibility (DATB-3) — done

**The `currentMembers` source, and why.** The organization's own records, read by the organization's own object:
`InteractionsDO.isCurrentMember` (`interactions-do.ts:2015`) applies the two tests the board's admission gate and
`internal.member.recorded` already apply — the spec-382 membership record `org.membership:member:<sa>` re-checked on
chain (`recordedMemberName`), else a current, ERC-1271-proven, non-tombstoned directory listing (`memberName`). These
are the same records the package's `member` relation is derived from. One rule is added and it only narrows: a
membership record stamped `endedAt` (`org.endMembership` — left, or removed by a steward) is not overridden by a
listing that still stands. A record that cannot be read is not a current member. The grant store is never read for
membership.

- `interactions-do.ts:2048` `consultEligible(grant, principal, channel, only?)` — one place that builds the roster,
  the grant holders, `currentMembersAmong` (`:2029`, six proofs at a time; for a restricted topic only its
  participants are proven) and calls fabric's `eligibleConsultMembers` with two separate arrays.
- `:4026` `internal.consult.eligible` uses it. `:4062` `internal.consult.grant` now also returns `eligible` for the
  one member asked (optionally scoped by `channelId`; an unknown topic ⇒ nobody).
- `:1688` `memberName` takes an optional pre-read directory (one read for the whole set).
- `apps/agent-runtime/src/consult-rail.ts:79` `memberConsultStanding` (grant + eligibility, one read); `:153`
  `SubmitConsultArgs.eligible` is required; `:161` `ConsultNotEligibleError`; `:169` `buildConsultRequest` gets
  `memberSA` + `eligible` and a `null` throws before anything is signed or sent.
- `apps/agent-runtime/src/member-consult.ts:85-117` — the invoker reads standing, returns a "not asked" result for a
  grant holder who is not a current member (no org-wire read, no send), and passes `eligible` to `submitConsult`.
  A run that came from a topic passes its `channelId` (it can only narrow).

This matters beyond the topic rail: the harness path (`ask each member…`, or a planner naming a respondent) reached
`submitConsult` on a grant alone, with no eligibility read at all.

### 5. Consult answers (DATB-4) — done at the one place member text enters

This app never concatenated answers into a post: the member's answer is the tool result of
`organization.member.consult`, read by the harness composer, whose text is posted to the topic. So the change is in
that result (`member-consult.ts:126-140`): `answeredBy` is fabric's `consultAnswerItems` item (the id the harness
consulted); `answer` is `neutraliseConsultText(text, CONSULT_ANSWER_PROMPT_CLIP)`; `memberWords` is fabric's
`synthesisOutcomeLines` block, fenced `CONSULT_DATA_OPEN/CLOSE`. A decline reason, the member's gate error and the
member's display name are neutralised too. Cost: the answer appears twice in the composer's input (≤ 1,200 chars).

### 6. Fabric gateway (DATA-3 / DATA-4 / DATB-2)

**Verified:** the mount calls only `verifyAndCache` and `invokeFast` (`interactions-do.ts:1518, 1520`, one caller
chain: `gatewayReadInbox` ← `gateway.inbox.get` and the shadow). Neither takes an `AuthenticatedCaller`. No
authenticator is needed today; with none, the gateway refuses every ingress (`authenticator_not_configured`).

**(a) The seven `putBody` sites** — all within the message's own topic resource:

| Site (`interactions-do.ts`) | Envelope built by | Resource | Verdict |
| --- | --- | --- | --- |
| `:845` (`putTopicBody`, endeavor deps) | `appendBoardPost` in `endeavors.ts:1420` | `topicBodyResource(topicId, id)`, `conversationId = topicId` | ok |
| `:1835` (welcome post) | `appendBoardPost` `:1832` | same | ok |
| `:3710` (assistant / member-agent post) | `appendBoardPost` `:3706` | same | ok |
| `:4215`, `:4251` (`putTopicBody`) | `endeavors.ts:1420` | same | ok |
| `:5215` (`channels.post`) | `appendBoardPost` `:5210` | same | ok |
| `:5342` (`putTopicBody`) | `endeavors.ts:1420` | same | ok |

Every one stores under the resource fabric derived for an envelope this object built in the same call; none passes
through a resource from an inbound envelope. Nothing to fix. No code here calls fabric's `loadBody`.

Seen while checking, not changed (not fabric's `loadBody`, bounded by the DM namespace test and the grant's record
scope): the app's own DM body ops take the resource from the envelope or the request —
`internal.dm.body.put` / `dm.body.put` (`:4569`), `inbox.body.get` / `getMany` (`~:2966-2985`),
`apps/home/server/connect/message-body-store.ts:73`. A sender-chosen `body.resource` naming another of the
recipient's DM bodies is the same class as DATA-22, one namespace wide.

**(b)** Nothing reopens an ended interaction or topic through fabric's stores, and nothing overwrites an ended
record: no store is injected, `openInteraction` is never called, and the Home's `inbox-data.ts:337, 414` moves a
case through the in-memory store's reducer (unchanged in Ring 0).

**(c) The `authenticate` implementation — added, not yet injected.** `apps/agent-runtime/src/gateway-mount.ts:106`
`mountedAuthenticator({ chainId, principal, admitted })`, and `MountedGatewayInput.authenticate` (`:76`) which
`buildMountedGatewayDeps` passes through:

- `principal` — this object's own agent (the address the Durable Object is named by), as CAIP-10. Never a body field.
- `actor` — who presented the request: the verified Home session's subject, or for an in-Worker op the verified
  wire's delegate. Supplied by `admitted()`, which the op closes over AFTER `InteractionsDO` has verified it.
- `tier` — by op, from a table the mount keeps: `communication` for a delivery or a post, `execution-fast` for a
  warm-path read, `execution-orchestrated` for an orchestrated write. Never from the request.
- `admitted` is read at call time and returns null when the request was not admitted; a malformed address, tier or
  chain id is null. The `Request` handed to the port is not read.

Before any ingress op climbs the ladder: (1) `mountedGateway(grant)` (`interactions-do.ts:1463`) takes the op's
admitted caller and passes `authenticate`; (2) the op → tier table goes beside `GATEWAY_ADOPTION`; (3) the mount
should also name the gateway (`PRINCIPAL_SA = eip155:<chain>:<principal>` in the env object handed to the
constructor) so `invokeFast` / `admitCaller` refuse another principal — not done now because it touches the one
live mounted op and the constructor is given `this.env` as it is.

### 7. Party resolution questions (H-12 / RUNC-3) — done, mostly already wired

- All three call sites (`harness-run.ts:4038`, `:4273`, `:6587`) let `InputRequired` reach the loop, which suspends
  with the question — a single-choice question is the same shape as the ambiguity it already carried, so no site
  needed a new branch. Pinned by a test at the app's own entry (`resolveStepArgs`).
- Spec 385 was already wired for any prompt that carries a `scope`: the question's scope is saved on the run
  (`index.ts:5564`), the trusted resume writes `rememberConfirmation` (`:5750`), and `preferredChoice` is read at
  `harness-run.ts:6599` through `preferredChoice()` (which revalidates against the candidates). The new questions
  carry a scope, so a confirmed payee resolves silently next time — pinned end to end in the test below.
- `ResolvedParty.evidence` reaches the reply (`parties` is passed whole, `harness-run.ts:4604-4608`). The Home's
  type has it (`apps/home/src/home/ask.ts:108`) and the party row carries `data-evidence`
  (`AskFlyout.tsx:1440`); the words are already shown — they are the party's `hint`.

Not done: `resolveExecutor` (`:6587`) has no `preferredChoice`, so an executor confirmed once is asked again (safe,
not silent). An executor is not a value argument.

**The two truth cases.** `scripts/ask-truth.mts` is this repo's set, but it runs against the LIVE faithnet estate
with real personas, and I could not call it to establish the fixtures. They are pinned deterministically in
`apps/agent-runtime/test/party-questions-445.test.ts` and should be added to the live set once the estate has:

- *negative* — a persona with no link to any Alice, and `alice.treasury` registered by a stranger. `ask(<persona>,
  'send alice 10 dollars')` → `kind === 'prompt'`, `promptFields` includes `payee`, no `requirementLimits`.
- *positive* — a persona whose `relationships.data` links `alice.me`, who holds a treasury (on faithnet hers is
  `alice2.treasury`). Same sentence → `authority_required` whose `requirementLimits.payee` is that treasury
  (probe: the address `alice2.treasury` resolves to), and is not the holder of `alice.treasury`.

### Tests added (all pass with the five packages linked)

| File | Tests | What |
| --- | --- | --- |
| `apps/agent-runtime/test/oversight-shape.test.ts` | 11 | payment mandate / message grant / data grant / unknown enforcer / expired / unconfigured ≠ stewardship in the standing reads and in `InteractionsDO.isSteward`; the minted wire is; the retired-subregistry cases |
| `apps/home/server/_lib/verify-stewardship.test.ts` | 5 | the same for the Home server, with wires built by `siteCaveats`, `buildPaymentMandateCaveats` |
| `apps/agent-runtime/test/unit/membership-two-sided.test.ts` | 4 | `claimed` refused at `coordination.endeavor.list`, admitted once the org lists them; routed standing lift |
| `apps/agent-runtime/test/unit/secret-records.test.ts` | 6 | the runtime's secret record keys are `role: 'secret'` and not askable |
| `apps/agent-runtime/test/consult-eligibility.test.ts` | 8 | departed member + live grant → not consulted; ended record outranks a listing; fail closed; restricted topic; `submitConsult` refuses before signing |
| `apps/agent-runtime/test/unit/member-consult.test.ts` | +3 | departed member is skipped with no send; topic scope; a forged multi-line answer stays one quoted span |
| `apps/agent-runtime/test/gateway-mount.test.ts` | +5 | `mountedAuthenticator` |
| `apps/agent-runtime/test/party-questions-445.test.ts` | 8 | the two truth cases, the scope, confirm-once, stale memory |

### Typecheck and test delta (five packages linked: context, ontology, fabric, harness, delegation)

Not the same link set as the morning's ten, so the "18" above is not this baseline.

| | agent-runtime typecheck | agent-runtime tests | home |
| --- | --- | --- | --- |
| Before this pass (14:11) | 17 errors: 10 this pass's (7 stewardship, 2 consult, 1 `claimed`) · 1 harness · 6 the naming work in progress | not run | 0 errors |
| After (14:33) | 31 errors: **0 this pass's** · 19 harness (below) · 12 the naming work | 1726 pass / 21 fail — none in a file this pass touched | typecheck 6 errors, all naming; tests 1104 pass / 1 fail (naming) |

No duplicate-instance type errors appeared.

**New Ring 0 breakage found, not adapted (harness was rebuilt at 14:09 and 14:22):**
- `delegationMandateVerifier` requires `uses` — `harness-run.ts:5331`; breaks 2 tests in the morning's
  `harness-principal.test.ts`.
- RUN-14 — `loadPlaybook` requires a fourth argument `isApproved` (who approved this digest) — 18 call sites
  (`index.ts` ×11, `interactions-do.ts:3742, 4001`, `harness-run.ts:5455, 6754`, `a2a-task-do.ts:1570`,
  `engagement-answer.ts:37`, `playbook-aliases.ts:69`); breaks 9 playbook tests. This one needs a decision: what
  is this deployment's source of approval for an `archetype.assignment` digest.

### Could not be verified here

- Anything live. In particular whether EVERY stewardship wire already issued on faithnet / imbnet has exactly the
  three site caveats and names the subregistry currently configured. A wire minted under an older `siteCaveats`, or
  when a different subregistry address was configured, now reads as not stewardship. Worth one read of real
  `relationships.data` rows before this ships.
- The Home's Next build and the runtime's wrangler bundle with the new `@ap-home/shared/oversight-check` subpath
  (typecheck and vitest resolve it; the bundlers were not run).
- The cost of `consultEligible` on a large organization: one vault read and up to two chain proofs per grant holder
  per routed topic turn.
- `ap doctor` (it reads the pins).

### Pins to bump (in the change that lands this)

| Package | Current pin | Files |
| --- | --- | --- |
| `@agenticprimitives/context` | `0.0.0-alpha.28` | `apps/agent-runtime`, **`apps/shared` (new dependency)** |
| `@agenticprimitives/ontology` | `1.0.0-alpha.46` | `apps/agent-runtime`, `apps/home` (+ wherever else it is pinned) |
| `@agenticprimitives/fabric` | `0.0.0-alpha.39` | `package.json`, `apps/agent-runtime`, `apps/home`, `apps/shared` |

`pnpm-lock.yaml` is not tracked in this repository; nothing to carry. My five `link:` overrides were removed from
the root `package.json` (it has no diff) and the tree re-installed at the published pins — where, like the morning's
work, this branch does not typecheck: it imports `belongs`, `consultAnswerItems`, `neutraliseConsultText`,
`GatewayAuthenticator`, the new `eligibleConsultMembers` / `buildConsultRequest` inputs and the `claimed` relation.

### Open questions

1. **Retiring the `.impact` subregistry and existing stewards.** `PERMISSIONLESS_SUBREGISTRY` is that root's
   subregistry, and every wire minted so far names it. The naming engineer kept the variable for this reason
   (`wrangler.toml` comment). If it is ever removed or changed, every existing steward stops reading as one until
   the old address is listed: `OversightContracts.retiredTargets` exists for that and is wired to no
   configuration yet (the test "a wire minted BEFORE the retirement…" shows both halves). Who owns that setting?
2. **Ring 0: a shape-only export.** `oversightShapeCheck` answers the chain itself to get the package's shape
   verdict. Should `context` export `isOversightDelegation(caveats, inputs)`?
3. **Ring 0: `claimed` on a receipt.** `orchestration`'s `ExecutionBindingV1.standing.relation` (and
   `regression.ts` `StandingRelation`) have no `claimed`; here it is recorded `none` with the reason. Add it?
4. **Ring 0: `preferredChoice` is trusted.** `party-resolution.ts` `confirmed()` uses whatever agent the port
   returns without checking it is among the candidates; this app's port revalidates (`preferredChoice()`), another
   app's might not.
5. **Consult: an ended record vs a standing listing.** The board's admission gate checks the listing first, so a
   member whose record ended but whose listing was not cleared is still admitted to the board; consult eligibility
   now refuses them. Should admission follow?
6. **Consult collection.** A member who leaves between the send and the answer is still read (`awaitConsult`).
   Discard the answer, as spec 329 does for a revoked opt-in?
7. **DM body resource** (item 6a, "seen while checking"): derive it from the message id in the app's own ops?
8. **Composer input** — keep both `answer` and the fenced `memberWords`, or only the block?
9. **Live truth cases** — which personas are the fixtures (item 7)?

---

## Third pass — home, vault, home-mcp, edge, scripts (2026-11-10)

Scope: apps/home, apps/vault, apps/home-mcp, apps/edge, apps/holder-prover, apps/shared, root scripts/.
Verified through temporary `link:` overrides to the local packages (now removed). No commit, no live call.

### Done
- **ING-4** — Home's session minting and the verifiers expect `typ: 'agent-session+jwt'`; fedcm test updated.
- **D5** — every `verifyIdToken` passes `expectedNonce`. home-mcp binds `home_nonce` per pending row; bearer paths pass `null`.
- **ING-17** — home-mcp store and DO gain atomic `takeToken` (`token.take` op); Home's KV gains `take` via `getdel`.
- **D7 / vault OAuth** — default scope is `mcp:invoke`; no `vault:*` scope anywhere.
- **ING-18** — vault `stage2Config` supplies `rateLimitSecret` (chain: STAGE2_RATE_LIMIT_SECRET, GATEWAY_ASSERTION_SECRET, A2A_MAC_SECRET, OAUTH_SIGNING_SECRET; none present means limiter off with one warning). apps/edge needs no change: the default refusal is right for a public edge.
- **DATA-8** — `buildReceiptsConfig` is async; the expected signer is the KMS address and the receipt `verifier` equals it (falls back to MCP_AUDIENCE only when no KMS key).
- **DATA-23** — vault `verifyCredential` gets `chainId` (new `CHAIN_ID` env).
- **Placeholder delegates** — vault `server-info` answers 503 `vault_server_key_unconfigured` unless `VAULT_KEY_SERVER_DELEGATE` is a real address; Home onboarding refuses to activate the vault without one; scripts use `realServerKey()` or refuse.
- **REG-5 commit-reveal** — Home `claimName`, `buildClaimCallData` and every caller finish through `finishNameClaim` (commit, wait 12 s, reveal); persona provisioning scripts and `name-personas-on-chain.mts` do the same in two batches.
- **REG-6** — renew comment in `rename-personas-on-chain.mts`; renewal is parent-only.
- **Estate projection** — `rotate-projection-signer.mts` reads `declaredSignerOf`; the two other scripts carry comments.
- **ONT-4** — `chargePayment` passes an `isTreasury` port (`AgentNamingClient.readDerivedType`).
- **COV-18/20** — related-orgs accepts `challengeVersion`; v2 is the default until 2026-12-10, v3 binds `CHAIN_ID`. Related-agent issuer is the parent (RA-2) at both sites.
- **RUNB-4** — a2a-deliver and `verify-folded-wire.mts` send `recipient` + `chainId`.
- **NAME-3** — invitation-check freshness carries `agentId`, `keyEpoch`, and a strict bigint `sequence`.
- **YouVersion** — attempt-bound login: `start` stores the full attempt, `callback` calls `completeLogin` with an atomic store (`AUTH_CODES.take`).
- **Workspace read wire test** — enforcers include `allowedTargets`; checks pass `{target, skill}`.
- **`.impact` fixtures** — the six moved to typed names in scripts and e2e specs; two regexes widened.
- **Coordinator item 1** — `rotationAvailability` accepts contracts generation 3 or 4.
- **Coordinator item 2** — `rotateCredential` takes the kept modules, read with `readKeptModules` (`getInstalledModules(2)` + `isModuleCurrent`) and builds a generation-4 batch that re-affirms them and the delegation manager. Recovery re-affirms nothing.
- **Coordinator item 3** — `home/rotation.ts` `reviewedList` returns `keptModules`; the Security > Sign-in page shows a "Modules that will be kept" section; the step text names the re-affirmation.

### Blocked / not changed
- **apps/holder-prover openac patch** — kept: `patchedDependencies` in root package.json and the Dockerfile `patch -p1` still apply it. The package now vendors the patched `present()`; drop the patch and the Dockerfile step after the SDK pin moves.
- **apps/edge** — no change needed.
- **`allowHex32Keys` (DATA-25)** — vault adds no entries; none needed.
- **Not exercised** (no live calls): the generation-4 rotation path, the commit-reveal flows, the Next and wrangler bundlers.

### Verification (temporary local links)
apps/home 0 type errors, 128 files / 1105 tests; apps/vault 155 tests; apps/home-mcp 25; apps/edge 9; apps/shared typecheck clean.

### Owner actions
1. Set `STAGE2_RATE_LIMIT_SECRET` on the vault (or confirm a fallback secret exists).
2. Set `VAULT_KEY_SERVER_DELEGATE` to the real vault server key; otherwise server-info is 503 and activation refuses.
3. Set `VERIFICATION_RECEIPT_KMS_KEY`; receipts' verifier becomes the KMS address.
4. Add `CHAIN_ID` to the vault env.
5. Deploy Home (minter) before the runtime (verifier) for ING-4.
6. Re-pin `agentic.lock.json` with `pnpm exec ap upgrade --pin-definitions ...` (network, not run).
7. Home's Vercel `NEXT_PUBLIC_AGENT_NAME_PARENT(S)` must match the typed parents.
8. Retire or re-register on chain the six `.impact` fixture names.
9. External clients move to the v3 related-agent challenge before 2026-12-10.
10. Commit-reveal needs the generation-4 subregistry contracts deployed; claims add a second signature and about 12 s.
11. Rotation to kept modules needs contracts generation 4 on the target chain.

### Risks
- Bearer id_tokens that carry a nonce are now refused.
- The home-mcp DO store gains a `token.take` op: deploy the DO with the worker.
- Placeholder delegates are gone; an unconfigured vault now fails loudly.

### Pins to bump
All `@agenticprimitives/*` pins to the release carrying spec 445 (types, a2a, agent-account, agent-naming, agent-resolution, agent-profile, audit, connect, connect-auth, delegation, fabric, harness, key-authorization, mcp-oauth, mcp-protocol, mcp-runtime, ontology, organization, payments, rate-control, registry-kit, related-agents, vault, verifiable-credentials, verification-receipts, privacy-credentials(+openac), edge-runtime, edge-cloudflare). Remove the openac-sdk patch at the same bump.

## 2026-11-10 — third pass — agent-runtime

Scope: `apps/agent-runtime/**` only. Verified with Ring 0 packages linked by temporary `pnpm.overrides` (removed; `package.json` is byte-identical to HEAD). Typecheck: 31 errors before, 0 after. Unit tests: 21 failing before; 3 failing / 1744 passing / 1 skipped after.

### Done
- Durable mandate-use ledger: `mandate-use-ledger.ts` (atomic claim in the ROOT delegator's `A2aTaskDO` storage, route `/internal/mandate-use/claim`), wired into `harness-run.ts` `chainVerifier` (`uses`). No binding / no principal / no answer refuses the step.
- Playbook approval (RUN-14): `playbook-approval.ts` approves only digests in `agentic.lock.json` `definitions`. The `.agentic/definitions/` snapshots do not exist in the repo, so the lock digests are the whole approval set.
- RUN-9 targets: `allowedTargets` + `target` on every session-wire check (a2a-task-do, interactions-do, agent-signing-wire, self-host-wire, library-granted-fetch, standard-a2a, index). Store-time checks use the first named target.
- RUNB-4 bound envelope (`recipient` + `chainId`) in consult-rail, outbound-delivery, canonical-a2a-e2e.
- RUN-11 `asker` on run records; all `intent.context.asker` readers moved to `record.asker`.
- EVAL-13: `/harness/ask` evaluation marker (holds writes, no standing / act-as-me, `allowedProviders` required, refused with `presented`/`appCredential`/`viaHost`); `/evidence` and `/experiment` subpaths; experiment jobs carry `allowedProviders`. Experiment plan ids now use `.` (the `@` and `+` of the old default are refused by the package grammar).
- Model clients: `allowedProviders` (+ `provider`) on every adapter; `ORCHESTRATION_LLM` feeds the allow-list. The gateway client now sends `context.allowedProviders` (gateway-switch test updated).
- Gen-4 naming: `commitThenRevealCall` at all five register sites; claim refusals answer 400 (`typed_roots_misconfigured` stays 503).
- Intent-engagement reducer signature evidence (`engagement-probe.ts`); `verifyRelationshipCredential({chainId})`; `verifyIdToken(..., expectedNonce: null)`; generation type widened to 4.
- Card Studio fails visibly: `ProfileFetchError` -> 502 `profile_unreachable` (no synthesized profile). Idempotency now reserves BEFORE the work (60 s TTL).
- ARD identifier is `urn:air:agenticprimitives.dev:sa:<sa>`, handle in `ap:handle`.
- Outbound: `EXTERNAL_AGENT_TOOL.outbound = { partyArg: 'agent' }` (the loop parks it after untrusted content); card limits/trust ports threaded through external-agent and discovery-inspect.
- Credentialed subject hop sets `cardTrust.relyOnCard` (see decision 3).
- Runtime-member serve: wake carries `Authorization: Bearer AP_RUNTIME_WAKE_SECRET`; the Container gets the secret; Dockerfile `--host 0.0.0.0`; `scripts/verify-runtime-wake.mts` now expects `workspace tool REFUSED`.
- Vault-key route: placeholder `serverKey` fallback replaced by 502 `vault_server_key_unavailable`.
- `assertSessionSecrets` at config load and at the first request of an isolate when the secret is set.
- Coordination: `CommitContribution` payload hash is now the package's `commitmentPayloadHash`; three test fixtures use real hashes.
- Provenance public row: `anchor.at` bucketed to the day (DATA-35).

### Blocked / not done, and why
1. Remaining 3 failing tests (handoff x2, subject-hop x1) are a RING 0 BUG, not a consumer fix: the a2a standard server rebuilds the `Request` after the bounded body read (`new Request(request.url, ...)`), which drops the in-isolate `markInWorker` WeakSet entry, so `config.principal` sees no mark and answers 401 to every in-Worker agent caller (handoff delivery, subject answers). Fix in Ring 0: call `principal` with the original request, or carry the mark. Until then in-Worker `/api/a2a` calls are refused.
2. Service signing wires: the Home mints `allowedTargets = [the service]` and `serviceSigningWireError` demands exactly that; RUN-9 gates require the RECEIVING agent in `allowedTargets`, so such a wire reaches no publisher. `library-granted-fetch` pre-checks against the publisher and will refuse today's wires. One end-to-end test is `it.skip` with this reason. Decision: the Home mints naming the receiver, and "exactly this service" becomes "includes this service".
3. Credentialed hops with `relyOnCard`: no `verifyCardSignature` port is bound to the agent's on-chain key, so an UNPINNED card on a credentialed hop is refused. Owner decision: bind the port, or require `pinnedDigest`. `resolveHost` is not bound (a Worker's fetch cannot reach private ranges).
4. Not done (owner decision or beyond this pass): priced-archetype payment gate (a2a-task-do ~772); pairing checks (runtime-pairing, index ~3130); class-scoped grant envelope at a2a-task-do ~751; B1 `requirement.maxRedemptions` for "declare primary treasury"; `issuedAt` inside `deps.serialize`; decision-step / requester rule; huddle-room-do removed-actor rule; run-export `digestSalt` (needs a new secret); `.agentic/definitions` snapshots. The x402 `buildRedemptionCalldata` change belongs to apps/home.

### Owner actions
- Set `AP_RUNTIME_WAKE_SECRET` on the Worker and the runtime Container; bump Container ARGs `RUNTIME_MEMBER_VERSION` / `ACP_VERSION` together.
- Re-mint session / signing wires naming the receiving agent; re-approve mandates after the ontology manifest digest change; runs parked before deploy cannot resume (`resume_integrity`); runs recorded before deploy have no `record.asker` and read as not-mine.
- Rotate any `SESSION_JWT_SECRETS` key under 32 bytes (boot now refuses it).
- Do not deploy the naming change until generation-4 subregistries are live (commit-then-reveal changes the ABI). The e2e script needs `NAME_COMMIT_KEY` + `RPC_URL`.
- Confirm `ORCHESTRATION_LLM` is set on gateway-only deployments.
- Confirm Home id_tokens carry no nonce (`custody-oidc` passes `expectedNonce: null`, which refuses a token that has one).
- Commit `.agentic/definitions` snapshots, or accept the lock digests as the approval set.

### Pins to bump (once published)
harness, delegation, a2a, orchestration, evaluation (`/evidence`, `/experiment`), model-client, orchestration-openai-compat, orchestration-anthropic, agent-naming, connect, intent-engagement, agent-relationships, agent-account, runtime-member, service-host, estate-projection, context, fabric, coordination.

## 2026-11-10 — final pass (the eight items the agent-runtime pass left)

Verified with temporary `pnpm.overrides` linking every `@agenticprimitives/*` package to the local Ring 0 tree (removed; root `package.json` is byte-identical to HEAD). `apps/agent-runtime`: typecheck 0 errors, 183 files / 1762 tests passing, 0 skipped (the one skip is un-skipped). `apps/home`: typecheck 0 errors, 128 files / 1106 tests passing. No commit, no live call.

### Done
1. **Priced archetypes (RUNB-6)** — no handler on this runtime declares `payment` (archetype handlers carry none; pinned by a test), so no `paymentGate` is wired on purpose; a2a now parks a priced skill that has no gate. Comment at `a2a-task-do.ts`. Pricing an archetype later needs a gate with `verifySettlement` wired first.
2. **Pairing checks (RUNB-12)** — `runtime-pairing.ts` + `interactions-do.ts`: claim and take verify the runtime key's signed proof (`verifyPairingProof`); a code unknown or expired is a miss and the fifth voids every outstanding code of that person (`notePairingMiss`, DO-local ledger); `runtime.pairing.list` returns the six-digit `confirmation` for a claimed code and `RuntimePairingPanel` shows it beside Approve. The Home proxy (`server/connect/runtime-pair.ts`) states `home` (the origin the runtime called; part of what the runtime signed). `@agenticprimitives/runtime-member` added to `apps/agent-runtime` dependencies (imported from the package root; the pairing helpers are not in its `/equip` entry — a Ring 0 follow-up should export them there so the Worker need not load the root).
3. **Class-scoped grant (RUNB-4)** — receiving side needs nothing beyond the package; every sender already binds `recipient` + `chainId`. Documented at `a2a-task-do.ts` `scopeCovers`.
4. **`maxRedemptions` (DLG-3/B1)** — `primaryDeclareRedemptions` (1 + the owner's other chartered treasuries when marking, 1 when clearing; 1 below contracts generation 4) sets `requirement.maxRedemptions` for `treasury.primary.declare`; Home `mintMandate` and `mintApprovedMandate` pass it to `buildDigestBindingCaveat`.
5. **Coordination** — door refuses a step-scoped decision whose approvers include its own requester (the org acting through a steward), in words (400). Decision steps are satisfied only through a decision: the reducer refuses `RecordStepSatisfied` on one and its message reaches callers. Huddle: reducer refuses re-admission of a removed actor; documented at `huddle-room-do.ts` (409 before any provider participant is made). The three placeholder commitment hashes were fixed earlier. `issuedAt` inside `deps.serialize` is still not done (not in this list; see below).
6. **`digestSalt` (RUN-19)** — `firewalledSpans(record, env)` passes `EXPORT_DIGEST_SALT` as `digestSalt` for both exported and served spans; test shows keyed digests differ and are stable.
7. **Service signing wires (RUN-9)** — owner decision applied: ONE wire per receiving agent. Home `issueServiceLibraryReadWire(service, sessionKey, publisher, sign)` names the publisher in `allowedTargets`; the `/workspace-read` contract gains a required `publisher` param; the Access card has a publisher field. Runtime: wires stored under `signing.serviceWire:<publisher>`, status/clear take `target`, `internal.signing.wire` takes `target`, `grantedReadSender` reads the wire for that publisher. The end-to-end test is un-skipped and passes.
8. **Card trust (RUN-16)** — new `card-trust.ts` binds `createOnChainCardVerifier` (verifyHash = UniversalSignatureValidator read; expected agent = the name's on-chain `addr`; binding and keys from the card host's `/.well-known/agent-card-binding.json` and `jwks.json`). `external-agent`: a card reached by NAME and NOT pinned is relied on only when the signature verifies; a pinned card keeps the pin (a supplied verifier would otherwise refuse every pinned card with no binding); a bare card URL is never relied on. `discovery.inspect` shows `signatureVerified` (true / false / null) and says "NOT verified"; it relies on nothing.

### Blocked or still open
- **Org consult/routing wire has the same RUN-9 gap**: `issueOrgConsultRoutingDelegation` names only the org in `allowedTargets`, so it reaches no member or host gate. Needs an owner decision on which targets it names (members and archetype hosts are many, and change). Not changed.
- **`issuedAt` stamped inside `deps.serialize`** (endeavors.ts) — not done; reducer refuses an `issuedAt` behind the last event, so a long-queued command can be refused (fails closed).
- Not exercised: real wrangler bundle of the new root import of `runtime-member`; the card verifier against a real signed card (Ring 0 twins cover it); the Next build.

### Owner actions
- Set `EXPORT_DIGEST_SALT` (a secret, >= 16 chars; keep it stable) on the runtime Worker.
- Services need a new signing wire PER PUBLISHER (re-run /workspace-read with `publisher=`); relying apps (Source Publishing) must send `publisher`. Old single wires reach no publisher and can be revoked.
- Cards of names that publish no `atl:cardDigest` must serve `/.well-known/agent-card-binding.json` + `jwks.json` or they are refused for routing.
- A priced archetype would need a payment gate first (none is priced today).

### Pins to bump (complete list, once published)
types, a2a, agent-account, agent-naming, agent-resolution, agent-profile, agent-relationships, audit, collaboration, connect, connect-auth, context, coordination, delegation, evaluation, fabric, harness, home, intent-engagement, key-authorization, mcp-oauth, mcp-protocol, mcp-runtime, model-client, model-gateway, ontology, orchestration, orchestration-anthropic, orchestration-openai-compat, organization, payments, privacy-credentials (+ -openac), rate-control (+ -cloudflare), registry-kit, related-agents, runtime-member (now also a dependency of apps/agent-runtime), service-host, estate-projection, vault, verifiable-credentials, verification-receipts, edge-runtime, edge-cloudflare. Remove the openac-sdk patch at the same bump.

## 2026-11-10 — org consult routing wire per target + `issuedAt` at the single writer

Verified with temporary root `pnpm.overrides` (removed; root `package.json` byte-identical to HEAD). `apps/agent-runtime`: typecheck 0 errors, 183 files / 1765 tests passing. `apps/home`: typecheck 0 errors, touched tests passing. No commit, no live call.

- **Org consult/routing wire — one wire per receiving agent (RUN-9, owner decision).** Home `issueOrgConsultRoutingDelegation(..., target)` now REQUIRES the member/host it is presented at (never the org itself) and names it in `allowedTargets`; `org-agent.tsx` signs one wire per consulted member and archetype host that has none (`routingStatus` returns `wireTargets` and `wantedTargets`). Runtime: stored under `routing.orgWire:<target>`; `consult.routingEnable` refuses a wire naming zero, several, or only the org; `internal.consult.orgWire` / `internal.signing.wire` take `target`; `orgConsultWire(env, org, target)`; the topic fan-out offers only members the org holds a wire for; archetype dispatch reads the host's wire. Test: a wire minted for member A is returned only for A and refused at B's gate.
- **`issuedAt`** (REM-5): `stampIssuedAt` in `endeavors.ts` replaces any command's `issuedAt` with the server clock inside `deps.serialize`, on every command that reaches the reducer (the spine and the direct validate sites).

### Owner actions
- Re-run routing-enable (Settings → org agent) so the steward signs a routing wire PER consulted member and per archetype host. Old single `routing.orgWire` wires reach no gate and are no longer read; revoke them on chain.
