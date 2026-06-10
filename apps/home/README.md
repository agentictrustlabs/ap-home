# demo-sso-next

**Your trust home: one origin that holds the ceremonies, signs the delegations, and hands out nothing else.**

This Next.js app is the white-label **Agentic Trust Site + Personal Trust Home** ([spec 234](../../specs/234-white-label-agentic-trust-site.md), [spec 232](../../specs/232-demo-sso-vercel-nextjs-migration.md)) — the central home that the relying apps in this repo ([`demo-jp`](../demo-jp), [`demo-gs`](../demo-gs), [`demo-org`](../demo-org)) connect to. It is the production-shaped successor to [`demo-sso`](../demo-sso): the OIDC broker, the credential ceremonies, the name claiming, and the delegations the home signs on a member's behalf all live here, behind one origin.

## The chain it proves

> Onboarding (passkey / wallet / Google) at the home origin → person Smart Agent with a claimed name → OIDC broker issues `aud`-bound sessions to relying apps → the home signs scoped delegation leaves for relying-app session keys — without ever holding the session private key.

Two properties carry the weight:

- **The home holds no session private key.** The relying app generates its session keypair locally; the home receives only the public key and signs the delegation leaf for it (spec 270 v4). No cross-origin key transport, ever.
- **White-label by construction.** Branding, vocabulary, and deployment specifics live in `src/whitelabel/` and app config — the generic substrate underneath stays vertical-agnostic ([ADR-0021](../../docs/architecture/decisions/0021-generic-packages-vs-white-label-apps.md)). This deployment is branded **Impact** and served at `impact-agent.me`, with per-handle homes at `<label>.impact-agent.me`.

The surface: OIDC broker routes (`/connect/*`, `/token`, `/jwks`, `/oidc/*`), FedCM identity-provider endpoints, the member portal, and per-agent profile pages.

## Packages composed

- [`@agenticprimitives/connect`](../../packages/connect) / [`connect-auth`](../../packages/connect-auth) — broker, sessions, passkey/SIWE/OIDC ceremonies
- [`@agenticprimitives/agent-account`](../../packages/agent-account) / [`agent-naming`](../../packages/agent-naming) / [`agent-profile`](../../packages/agent-profile) / [`agent-relationships`](../../packages/agent-relationships) / [`related-agents`](../../packages/related-agents) — the identity facets the home manages
- [`@agenticprimitives/delegation`](../../packages/delegation) — the site + session-leaf delegations the home signs
- [`@agenticprimitives/identity-directory`](../../packages/identity-directory) (+ [`adapters`](../../packages/identity-directory-adapters)) — resolution
- [`@agenticprimitives/fedcm-idp`](../../packages/fedcm-idp) — browser-native FedCM identity provider
- [`@agenticprimitives/verifiable-credentials`](../../packages/verifiable-credentials) / [`contracts`](../../packages/contracts) / [`types`](../../packages/types)

## Run it

```bash
pnpm --filter @agenticprimitives-demo/sso-next dev   # next dev on http://localhost:5373
```

Environment (broker key, RPC, redirect allowlist, optional Google OIDC) follows `.env.example`; key generation reuses `../demo-sso/scripts/gen-broker-key.mjs`. Full setup: [DEPLOY.md](./DEPLOY.md).

**Deploy:** this app ships exclusively via GitHub → Vercel — a merge to `master` auto-deploys it. There is no CLI or wrangler deploy path; the Cloudflare deploy script in this repo deliberately excludes it.

## Status

Reference implementation, not a product. Runs live against Base Sepolia as the identity home for the relying-app demos. Production launch of the substrate is gated on the public checklist in the [root README](../../README.md); every security finding is tracked live in [`docs/audits/findings.yaml`](../../docs/audits/findings.yaml).

Validate: `pnpm --filter @agenticprimitives-demo/sso-next typecheck`.
