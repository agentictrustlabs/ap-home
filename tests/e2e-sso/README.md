# The Home's E2E suite (Playwright, live deployment, mock SIWE wallet)

End-to-end tests that drive the **live** Home (`https://www.faithnet.me`, override with `SSO_BASE_URL`) with a
**generated SIWE wallet injected as `window.ethereum`** — no MetaMask, no real user. Each run mints a fresh
smart-account agent against the estate's own chain and paymaster.

## Why it is here

Moved from `ap-demos/tests/e2e-sso` on 2026-10-13, for two reasons that compounded:

1. **It lived in a repository that could not run it.** ap-demos declares no root `@playwright/test` — only one
   inside `apps/demo-resolution`, for that app's own tests. This repository already had the runner
   (`@playwright/test` at the root) and no suite at all.
2. **Its subject moved.** 18 of the specs already named `www.faithnet.me` outright, while the config's
   `baseURL` still defaulted to `https://www.impact-agent.me` — the Home of the Base Sepolia / Impact estate,
   retired the same day (ap-demos `DEPLOYER.md`). The default pointed at a deployment nothing can rebuild.

Fifteen specs that tested the retired estate's relying apps and smoke paths did not come along
(`all-apps-smoke`, `b4-connect-smoke`, `commons-alice-dm`, `commons-demo-sso`, `commons-inbox`,
`demo-gs-connect-smoke`, `flows`, `gco-existing-org`, `oidc-connect`, `passkey-first-signin`,
`quick-connect`, `relying-apps-connect`, `sibling-apps-smoke`, `uupg-discussions`,
`verifiable-content-flows`). They are in ap-demos' history if a relying-app suite is ever wanted again.

## What the move had to fix

A test suite can be coupled to a deployment in ways that a passing run never reveals, because it was passing
against the deployment it was coupled to:

- **A brand in an assertion.** `expect(home.origin).toContain('impact-agent')` appeared in four specs. The
  suite serves one estate at a time, so the expected domain is now derived from `SSO_BASE_URL`
  (`estate.ts` → `estateDomain()`); hardcoding a brand is what tied these to the retired estate.
- **A path into a deleted app.** `home-full-coverage.spec.ts` reads the Home's nav module to prove the route
  list covers it — from `apps/demo-sso-next/src/components/portal/nav.ts`, which no longer exists. It now
  reads `apps/home/src/components/portal/nav.ts`. That check exists to catch a coverage list that has drifted
  from the nav; pointed at a missing file it would have failed loudly, which is the better of the two outcomes
  but still the wrong file.
- **Redaction regexes that no longer matched.** Six specs strip the estate's hostname out of logged URLs to
  leave the path. Written for `*.impact-agent.me`, they silently stopped redacting anything on faithnet, so
  the logs they exist to keep readable printed full URLs instead.

## Run

```
SSO_BASE_URL=https://www.faithnet.me npx playwright test -c tests/e2e-sso            # all of it
SSO_BASE_URL=https://www.faithnet.me npx playwright test -c tests/e2e-sso ask-       # one family
```

These hit production and mint real agents. They are not part of `pnpm test`.
