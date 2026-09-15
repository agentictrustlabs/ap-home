# Split status — what stands between this repository and the cut

Spec 399 §5 (migration mechanics) and §6 W2. Update it as each line closes; delete it at the cut.

## Done at extraction

- **§5.1 history-preserving extraction** from a fresh clone of Ring 0 (the commit is named in `git log`): the eight
  Home apps, the estate fixtures, the Home ops scripts (399 §2.2 list + every `verify-*` / `measure-*` / `trace-*`
  gate, the live-gates ledger and runner, `ask-truth` and its scenarios, the census), the product docs, spec 398.
- **§3.6 template** on top (`create-app --template product-repo`).
- **Names**: directories and package names are product names; Worker names / DO classes / migration tags unchanged
  (`DEPLOYER.md`). **One estate** (2026-09-12): the treasury Workers (pinned to `lbsb-treasury.impact`), the Base
  Sepolia `production` envs and faithnet's `[env.faithnet]` / `[env.faithnet-b]` blocks are not carried; each Worker
  gets its own `[env.production]` (`derive-ap-home-env.py`, `ap-home-estate.json`).
- **§5.2 dependencies**: every `workspace:*` is the exact published version of the extraction commit's coherent
  set; the scripts' imports are `@agenticprimitives/<p>` (subpath exports where the source was a subpath).

## Green at extraction (against npm alone, alpha.23)

`pnpm install` under strict peers · `pnpm -r typecheck` 8/8 · `pnpm test` 1,562 across the apps · `pnpm census` ·
`ap doctor --rules` no-op. `ap doctor` reported ONE red at extraction, inherited: `no-hmac-home-bridge` at 46/42 — closed in Ring 0 `108d3570`
(see item 1 below); this extraction predates it. Three others were
resolved in Ring 0 the same night (`d2644f5c`): org-steward's recorded digest; the Home MCP's raw delegate key as an
accepted-risk finding (`home-mcp-raw-delegate-key` — KMS signer + client re-registration scheduled); the cross-subject
gate recognising an ACT's `routedSubjectFor` beside a READ's `subjectOfRead`.

## Open — in order

1. ~~The bridge ratchet (spec 341)~~ — DONE in Ring 0 `108d3570` (2026-09-11): the Work family's execution parity.
   The screen hands each act to the Ask as a supplied plan (`src/home/ask-command.ts`); `coordination.step.satisfy`,
   `coordination.commitment.withdraw`, `coordination.commitment.reallocate` are capabilities with SKILL.md contracts
   (`~/skills`, registered live; Missio Nexus, dave-s-table.org and the demo team re-pinned); the four `/connect/work`
   actions are deleted — **42/42**. Runtime deployed, Home deployed, `verify-milestone` green live. What remains on the
   ratchet is `org-membership.ts:132` and `channels.ts:284` — the ceiling is 42 and the tree is at 42; the next
   conversion lowers it. Re-extract ap-home to pick this up.
2. ~~`APP_*_SCOPES` twin across apps~~ — DONE 2026-09-13: `apps/shared` (`@ap-home/shared`, a workspace package of
   this product — vertical namespaces belong in an app module, never a package, ADR-0021) is the ONE list both the
   Home's enable ceremony and the runtime's genesis planes append (`INTERACTIONS_APP_SCOPES`); the Home re-exports the
   three names, Next transpiles the module, `genesis-planes.test.ts` guards the fold only.
3. ~~`deploy-cloudflare.ts` / `gen-dev-vars.ts`~~ — DONE 2026-09-12: the Base Sepolia deploy script, `check-production-deploy.ts`
   and `provision-skills-sandbox.mts` are not carried; `gen-dev-vars.ts` writes only this repository's apps and reads
   deployments from the published contracts package; `set-cloudflare-secrets.sh` defaults to `production` and takes
   `RPC_URL` from the environment.
4. ~~**The estate**~~ — DEPLOYED 2026-09-12 from this repository as ITS OWN deployment (not a shadow of faithnet's):
   `home-rpc`, `home-vault` (D1 `home-vault`), `home-runtime`, `home-edge`, `home-mcp` on `home-*.faithnet.io`; the Home on
   Vercel; vault server id `home-vault`; six people of its own (`docs/runbooks/home-vercel.md` §3). `docs/runbooks/estate.md`.
   Still faithnet's, by decision or by necessity: the `faithnet.io` zone (no product zone yet), the AKCS caller identity
   (the operator's to bind — the ONE trust item), discovery (the public KB). Email rail unconfigured.
5. **CI**: `ci.yml` (typecheck · test · doctor · rules). `live-gates-nightly.yml` runs `scripts/live-gates.json` against
   the estate's Home nightly (the seven-night clock; `A2A_URL` / `MCP_URL` repository vars name the runtime and vault
   for `ap conform`). Ring 0's `ask-truth-nightly.yml` is copied here once the runner takes the scenarios as data.
6. ~~**Examples**~~ — NOT carried (2026-09-12): the eight relying-app demos are Base Sepolia / impact-agent applications;
   faithchain's relying apps live in their own repositories (`gather27`, `engage`, `~/skills`). They stay in Ring 0
   until their own disposition (399 §2.1 †).
7. **Product specs** (399 §2.4) — CARRIED since 2026-09-13: the 24 specs whose surface halves move with the Home
   (234 · 299 · 310 · 312 · 313 · 315 · 318 · 334 · 344 · 348 · 352 · 361 · 367 · 370 · 375 · 378 · 381 · 382 ·
   385 · 391 · 393 · 394 · 397 · 398) ride in whole under `specs/` at extraction, beside `apps/home/docs` (the Home's
   docs, moved with the app). Additive: Ring 0 keeps them until the cut PR splits the straddlers at the heading and
   turns Ring 0's copies into pointers (`specs/INDEX.md`).
8. **Seven green nights** on the estate (`live-gates`, `ask-truth`, `ap conform a2a`, `pnpm census`), then one cut PR
   per app in Ring 0 — `agent-runtime` + `vault` + `home` cut together (399 §6 W2).
   **The gates are roster-agnostic since 2026-09-13**: every ledger gate reads WHO plays each role from
   `scripts/fixture.mts` (the ledger's `fixture` key → `scripts/fixture.estate.json`, exported as `FIXTURE_JSON`); 65 of
   72 had faithnet's names in their text and could never run here. **First estate nightly 2026-09-13 (run 34740074489): 24 green**
   (route, provenance-hop, run-export, durable-run, grant-revocation, endeavor-decision, offer-allocate,
   standing-instruction(+room), public-provenance, receipt-recompute, run-bill, home-mcp + browser-path + authority +
   revoke + room, cancel, golden-journey, routine-pause, recipe), 3 skipped by name, the rest fixed the same day (the
   preflight helper not carried; a coordinator team refusing a routed invite; the instructions twin vs a primary
   payer) — except `home-mcp-stream` (item 10). **The estate's fixture stands**: `soup-kitchen.org`
   (mara steward; theo, priya members on both halves), `food-bank.org`, `volunteer-rota.team` + `volunteer-drivers.team`
   (the ambiguous word), `mara.treasury` / `mara2.treasury` (100 demo USDC each), `samuel.treasury` — chartered by
   `scripts/provision-estate-fixtures.mts` (Ring 0) through each person's own Ask, mandates signed at this Home;
   idempotent, re-run after any change. Still `null` here, and the gates that need them SKIP by name (waiting, never
   green): `specialist` (a runtime service the steward's playbook hands payments to — verify-handoff /
   verify-authority-chain), `ministry` (a content-catalog agent in the public registry — the home-mcp discovery /
   routed / people gates). Chartering those is the next step toward seven green; the cross-Home gates (`CROSS=1`)
   need a second deployment and stay faithnet's.
9. **Faithnet's future — DECIDED 2026-09-13 (user): Faithnet stays the development deployment for weeks.** Ring 0 keeps
   deploying `www.faithnet.me` and its Workers exactly as today; nothing moves dev work off it. The estate keeps its
   nightly clock in parallel as the product repo's proof, and the cut PR (399 W2) is DEFERRED — not scheduled, not
   blocked on anything but the decision to take it. Focus meanwhile: the capability gap with Buzz.xyz and the other
   agentic platforms (spec 359's assessment, `docs/architecture/agentic-framework-competitive-analysis.md`).
10. **Per-agent hosts** (`<label>.home-a2a.faithnet.io`): a wildcard DNS record + a route on `home-runtime` would give the
   estate what `*.faithnet.ai` gives faithnet; until then agents are reached by their records through the edge (the rule
   anyway) and only home-mcp's `ap://person/agent-card` resource wants the host — which is why `verify-home-mcp-stream`
   is RED here (the card at `mara.home-a2a.faithnet.io` answers 530) until the wildcard exists: a real gap, left red on purpose.
11. **The Home's registered relying apps** (`apps/home/src/whitelabel/config.ts`) still list faithnet's — skills, gather,
   engage — by their live URLs; the estate has no relying apps of its own yet. Register the estate's when they exist;
   `home-mcp` is already env-driven (`NEXT_PUBLIC_HOME_MCP_ORIGIN` / `_DELEGATE`).

## Invariants that must survive (399 §8)

- Ring 0 is never edited by this repository's existence; until the cut PR, product work that needs a primitive
  lands it in Ring 0 as a package API and consumes it here — never as an app-resident copy.
- No DO binding, DO class or migration tag changes, in either repository, ever. The estate's Worker names were chosen
  once (2026-09-12) and do not change either.
- The vault stays the record; nothing here moves a durable private record into DO storage (ADR-0055).
