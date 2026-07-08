# demo-sso-next — Claude guide

The white-label central **Agentic Trust Site + Personal Trust Home** (spec 234) — the OIDC home/broker
the relying apps (demo-jp, demo-gs, demo-org) connect to. Next.js app served at `impact-agent.me`
(per-handle homes at `<label>.impact-agent.me`, spec 232). It owns the credential ceremonies, name
claiming, and the delegations it signs on the member's behalf.

## Deploy (HARD RULE — read first)
- **demo-sso-next deploys ONLY via GitHub → Vercel.** A push/merge to `master` auto-deploys it. There
  is NO manual deploy step and NO CLI deploy.
- **NEVER deploy it with `wrangler`, `vercel` CLI, or `scripts/deploy-cloudflare.ts`.** That script
  deploys the Cloudflare half (demo-mcp, demo-a2a, demo-web*, Pages apps) ONLY; it references
  `DEMO_SSO_URL` purely as a CORS/origin entry, never as a deploy target. demo-jp/gs/org also deploy
  separately (Cloudflare Pages); this app is the one Vercel target.
- **Consequence for cross-app changes:** when the home and a Cloudflare app change together (e.g. spec
  270 the home signs a leaf the relying app consumes), the home goes live via the GitHub→Vercel deploy
  on its own cadence. Do NOT roll back the Cloudflare side because the home is mid-deploy — just let the
  GitHub deploy land, then re-verify. (Lesson from the spec-270 DEL-001 activation: the home's leaf-
  signing is a Vercel deploy; rolling demo-jp back was needless churn — the fix was the home redeploying.)
- To force a redeploy: push an empty/no-op commit to `master`, or trigger a redeploy in the Vercel
  dashboard. Confirm the new deployment is live before testing a flow that depends on home-side changes.

## Where to look
| Working on | Read |
| --- | --- |
| OIDC broker / token / grant | `server/connect/*.ts` (`name.ts`, `grant.ts`, `token.ts`, `nonce.ts`) |
| The onboarding journey (passkey/wallet/Google) | `src/components/onboarding/*` + `src/home/onboarding.ts` |
| Delegations the home signs (site + DEL-001 leaf) | `src/lib/delegation.ts` (spec 270 v4) |
| Connect a service SA (treasury/discovery) to its A2A+MCP hosts | `src/lib/connect-treasury.ts` (spec 283/284 ceremony: bind endpoint records → mint scoped host delegation → publish skills; pure+injectable, UI page TBD) |
| Name label / TLD handling | `src/home/types.ts` (`homeLabel`) + `src/lib/domain.ts` (`AGENT_NAME_PARENT = 'impact'`) |
| White-label config | `src/whitelabel/config.ts` (spec 234) |
| Home manifest publish/serve (spec 310 W2) | `src/home/manifest.ts` (compose + digest) + `server/connect/home-manifest.ts` (fail-closed publish gates) + `app/.well-known/agentic-home/route.ts` (serve; 404 when unpublished) |
| Agentic inbox (spec 310 W3 / 309 W6) | `src/home/inbox-data.ts` (KV adapter over messaging/interactions stores, audited fail-closed) + `server/connect/inbox{,-deliver}.ts` + `app/(portal)/inbox/page.tsx` + `docs/{home-inbox,messaging-interactions}/guide.md` |
| Control-plane projections + timeline (spec 310 W4) | `src/home/control-plane.ts` (delegation→`ConnectedAppGrantV1`, tree→`ManagedAgentEntryV1`) + `server/connect/control-events.ts` (audit-first `HomeControlEventV1`) + `app/(portal)/activity/page.tsx` |
| Mandate issuance on approve (spec 310 W5) | `src/home/mandate.ts` (scoped delegation + signed `InteractionMandateV1`) + `applyApproveWithMandate` in `src/home/inbox-data.ts` (ERC-1271 over re-derived digest, fail-closed) |
| Synthesis inbox + community messaging (spec 312) | `app/(portal)/inbox/page.tsx` (triage band, conversation rows, context chips, signature chips, composer) + `sendFromInbox` (`action:'send'`, name-resolved) + `?contextKind=` related-messages read + `server/connect/directory.ts` / `src/home/directory.ts` / `DirectoryListingCard` (opt-in self-signed listings, ERC-1271-verified — ADR-0025) |

## Hard rules (this app)
- **Name labels: the label is the FIRST dot-segment** (`homeLabel`), parent-agnostic. Do NOT strip a
  fixed suffix — `<label>.impact` got flattened to `<label>impact.impact` once (the `.demo.agent` bug).
- **The home holds NO session private key.** The relying app generates the session keypair; the home
  receives only the public `session_key` and SIGNS the DEL-001 leaf for it (spec 270 v4, no cross-origin
  key transport).
- White-label / faith vocabulary lives in `src/whitelabel/` + app config — never leaks to packages.

## Validate
`pnpm --filter @agenticprimitives-demo/sso-next typecheck` (no `pnpm check:demo-sso-next`).
