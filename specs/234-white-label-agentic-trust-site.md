# Spec 234 — White-label Agentic Trust Site + relying-app integration

Status: PLANNED 2026-05-28. Architect-of-record for the product shape in the
"Agentic Trust Site + Relying App Integration" diagram (2026-05-28): a
**white-label central trust site** with configurable onboarding + delegated
access for domain-specific relying apps. Composes the existing SSO/identity wave
(specs 224/229/230/231/232) — introduces **no new package capability**, only
**app-level composition + a white-label config model**.

## 1. Purpose

One reusable **control plane** — the Central Agentic Trust Site — that any
**vertical white-label** (first: a **faith** org / Impact Portal) deploys with its
own branding, onboarding, enabled trust services, and domains, and that any number
of **relying apps** integrate with via standard OIDC + scoped delegation. The same
site is the user's **white-label Personal Trust Home** (manage connected apps,
review audit, manage credentials/devices).

**The white-label is DATA, not forked code** (ADR-0021): the generic core
(`packages/*` + the app's generic layer) is vertical-agnostic; a deployment is an
**app-level config object**. A new vertical = a new config, not a new library.

## 2. Actors (diagram, left → right)

- **Relying Applications** (left): Faith App / Impact Portal (**`demo-org`**),
  Community Platform, Service/Tool App. Each is a separate origin that signs users
  in via the trust site (OIDC, spec 230) and acts on their behalf via a **scoped
  ERC-7710 delegation** (ADR-0019) — never custody.
- **Central Agentic Trust Site** (center) = **`demo-sso-next`**. Three layers (§3).
- **White-label Personal Trust Home** (right) = the same `demo-sso-next`, signed-in
  view: the Person/Org/Agent owner manages connected apps, credentials/devices
  (spec 233), audit history, and profile.

## 3. The three layers of the Central Site

1. **Experience Layer** — the white-labeled UI: branding/theme, onboarding flow,
   consent screens, the Personal Trust Home. Driven entirely by the white-label
   **config** (§5). Faith branding/copy lives here, never in packages.
2. **Core Trust Services** — the GENERIC engine, from `packages/*`: sign-in +
   convergence + session/`id_token` (`connect` + `connect-auth`), name resolution
   (`agent-naming`), profile (`agent-profile`), relationships (`agent-relationships`),
   delegation issuance/redeem (`delegation`), account/custody (`agent-account` /
   `account-custody`), audit trail. These take config as INPUT; they hold no
   vertical knowledge.
2b. **A2A surface** — the agent's machine endpoint (spec 231) on its A2A domain.
3. **Platform Configuration** — the white-label config: domains, branding,
   onboarding steps, **which Core Trust Services are enabled**, the **registered
   relying apps** + their allowed delegation templates/caveats. App-level (§5).

## 4. Generic vs white-label split (ADR-0021)

| Generic (packages/* + the app's generic layer) | White-label / vertical (app config + Experience Layer) |
| --- | --- |
| agent accounts, custody, delegation, naming (`.agent` TLD), profile, ontology | branding (name, logo, colors), copy/microcopy, faith content |
| connect/SSO token + convergence + issuance gates | which onboarding steps + credential methods are offered |
| MCP/A2A runtime contracts; audit primitives | which Core Trust Services + relying apps are enabled |
| host-AGNOSTIC logic | concrete domains (`impact-agent.me/.io`, `demo.agent`) — `src/lib/domain.ts` |

Enforced by `pnpm check:no-domain-in-packages` (hostnames + `demo.agent` + faith
vocab) + `check:forbidden-terms`; the rest is doctrine + per-package CLAUDE.md.

## 5. White-label config model (app-level, build-time) — the new artifact

A single typed config object in `apps/demo-sso-next` (e.g.
`src/whitelabel/config.ts`), the ONE place a deployment's identity lives.
Build-time now; a runtime/on-chain adapter is a future phase (deliberately not
built — user, 2026-05-28). Shape (sketch, to refine in build):

```ts
interface WhiteLabelConfig {
  id: string;                         // 'faith-impact'
  brand: { name; tagline; logoUrl; colors; favicon };
  copy: Record<string, string>;       // microcopy/onboarding text (faith wording here)
  domains: { connect; a2a; nameParent }; // → drives src/lib/domain.ts (no hardcode elsewhere)
  onboarding: { steps: OnboardingStep[]; credentialMethods: ('passkey'|'wallet'|'google')[] };
  trustServices: { audit; relationships; orgCreation; … }; // enable/disable
  relyingApps: { clientId; redirectUris; delegationTemplate; caveats }[]; // the OIDC client registry, configured
}
```

The Experience Layer + the OIDC client registry (currently
`src/lib/oidc-clients.ts`) + `src/lib/domain.ts` all **read from this config**
instead of hardcoding. Packages receive only the resolved values.

## 6. Relying-app integration (already built — this spec names it)

Per spec 230 (OIDC) + ADR-0019 (scoped delegation): a relying app (`demo-org`)
redirects to the user's Personal Trust Home (`<handle>.impact-agent.me`), the user
consents (passkey or wallet — both custodians), the site mints an `id_token`
(verified vs `/jwks`) + a **scoped, caveated `person→site-delegate` delegation**
sidecar. The app holds login-grade identity + delegated authority, never custody.
Each registered relying app's `delegationTemplate` + caveats come from §5 config.

## 7. Mapping to current code

- `apps/demo-sso-next` = the Central Site + Personal Trust Home. Add `src/whitelabel/`
  (the config + schema); refactor `domain.ts` + `oidc-clients.ts` + the Experience
  Layer to read it.
- `apps/demo-org` = the Faith App / Impact Portal relying app.
- `apps/demo-a2a` = the A2A surface backend (Cloudflare).
- `packages/*` = Core Trust Services — stay generic (ADR-0021).

## 8. Reference: patterns to port

- **agentic-trust `apps/admin` + `apps/atp-agent`** (the user's faith stack) — the
  white-label admin + the configured-by-vertical app shape; A2A already ported (spec 231).
- **smart-agent** — generic trust primitives (already the package source-of-truth).
- Composes specs **224** (Connect/SSO), **229** (personal central auth), **230**
  (OIDC OP), **231** (A2A subdomain), **232** (Vercel hosting). No new package capability.

## 9. Phase plan

- **W1 — Config model:** define `WhiteLabelConfig` + the `faith-impact` config in
  `apps/demo-sso-next/src/whitelabel/`; route `domain.ts` + `oidc-clients.ts`
  through it (no behavior change — same values, now config-sourced).
- **W2 — Experience Layer:** brand/theme + onboarding + copy read from config
  (faith branding becomes data); the Personal Trust Home view (manage apps /
  devices / audit) assembled from enabled Core Trust Services.
- **W3 — Relying-app registry from config:** `relyingApps` (clientId/redirect/
  delegation template/caveats) sourced from the config; `demo-org` registered as
  `faith-impact`'s app.
- **W4 — (future) runtime/on-chain white-label config** + a second vertical to
  prove genericity.

## 10. Out of scope

- Runtime/remote white-label config (W4; build-time only now).
- Any vertical content in `packages/*` (ADR-0021 — hard error).
- New custody/delegation primitives (reuse the existing wave).
