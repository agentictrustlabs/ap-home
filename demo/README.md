# Demo people

One roster, managed here. **Testnet only (Base Sepolia).**

```ts
import { DEMO_PERSONAS, privateKeyFor, ORG_CUSTODIANS } from '../demo/personas';
```

- `personas.json` — the data. Name, Smart Agent, custodied orgs, and the custodian EOA key.
- `personas.ts` — types and helpers.

## The keys are in the repo deliberately

Every app that needed them was copying them into its own gitignored `.dev.vars` — five copies that
drift. One file is easier and no less safe. **Never fund these on mainnet and never give one
authority over anything real:** anyone who can read this repo can sign as any of them.

This differs from `tests/e2e-sso/demo-user.ts`, which derives its key from a public seed so no
literal exists. That is still right for a key nobody needs to look up. These are a fixed cast with
Smart Agents and organizations already deployed against them — the keys cannot be re-derived, so they
have to be recorded. `.gitleaks.toml` allowlists this directory for that reason.

## Runtime still goes through the Home

| Need | Use |
| --- | --- |
| Which personas exist, at runtime | `GET /connect/demo-personas?client_id=<app>` |
| Sign one in | `POST /connect/demo-signin` |
| Sign a digest as one, without a browser | this file |

## Who is here

| handle | name | custodies | key |
| --- | --- | --- | --- |
| alice | Alice Okoro | Missio Nexus | ✅ |
| bob | Bob Tanaka | Reach Laos | ✅ |
| carol | Carol Mbeki | UUPG+ Alliance | ✅ |
| dave | Dave Silva | — | ✅ |
| elena | Elena Voss | — | ✅ |
| nathan | Nathan | Accelerate | ✅ |
| david | David | Accelerate | ✅ |

All seven are signable. Nathan's and David's came from
`uupg/apps/tracker/seed/demo-accounts.json`, which also carries the **Accelerate** org they share.

## Known gap — and the one that already works

`alice`, `bob` and `carol` custody an organization but are **not stewards** of it, so Home's vault
gate refuses them (403 "not a steward of this organization") and `/connect/related-orgs` returns
`[]`.

**Accelerate is the counter-example, and the fix is visible in it:** the tracker seed carries a
`stewardship` wire for that org, which is exactly what the other three lack. Whatever produced it is
what needs running for Missio Nexus, Reach Laos and UUPG+ Alliance.

Fix and acceptance criteria: `docs/upstream/mint-demo-stewardship.md` in the engage repo.
