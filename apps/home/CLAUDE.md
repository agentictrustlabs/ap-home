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
| Agentic inbox (spec 310 W3 / 309 W6 / **316 §11a**) | `src/home/inbox-data.ts` (messaging/interactions stores, audited fail-closed) — **VAULT-RESIDENT**: `server/lib/inbox-store.ts` `makeInboxKv(env,owner)` stores each owner's `inbox.data` in their MCP vault over the standing inbox-delivery grant (no Home KV inbox doc, fail-closed when unprovisioned). Delivery admits into the vault directly — the a2a `messaging.deliver` skill (demo-a2a) or the Home as recipient-authorized custodian (`sendFromInbox`, per-owner `inboxKvFor`). `server/connect/inbox{,-deliver}.ts` + `app/(portal)/inbox/page.tsx` + `docs/{home-inbox,messaging-interactions}/guide.md` |
| Control-plane projections + timeline (spec 310 W4) | `src/home/control-plane.ts` (delegation→`ConnectedAppGrantV1`, tree→`ManagedAgentEntryV1`) + `server/connect/control-events.ts` (audit-first `HomeControlEventV1`) + `app/(portal)/activity/page.tsx` |
| Mandate issuance on approve (spec 310 W5) | `src/home/mandate.ts` (scoped delegation + signed `InteractionMandateV1`) + `applyApproveWithMandate` in `src/home/inbox-data.ts` (ERC-1271 over re-derived digest, fail-closed) |
| Synthesis inbox + community messaging (spec 312) | `sendFromInbox`/`replyInConversation` (`action:'send'`/`'reply'`, name-resolved) + `?contextKind=` related-messages read + `server/connect/directory.ts` / `src/home/directory.ts` / `DirectoryListingCard` (opt-in self-signed listings, ERC-1271-verified against the SUBJECT SA — ADR-0025) |
| Workspace switcher (spec 315 / ADR-0046) | `src/lib/workspace.ts` (URL-derived scope: person / `/org/<sa>/…` / `/service/<sa>`) + `src/lib/agent-class.ts` (kind → Person/Org/Service class, service role, authority lineage) + `src/components/portal/AgentSwitcher.tsx` (topbar dropdown grouped by class: you, Organizations you steward, Services you manage — each service shows its custody lineage `you → [org →] role`; connected apps stay in the person nav) + scoped `buildNav` in `nav.ts` + workspace pages `app/(portal)/org/[org]/{overview,data,treasury}` + `app/(portal)/service/[agent]` (role-dispatched panel) |
| Interactions IA (spec 313 v2 + §2.1 DMs) | ONE unified `app/(portal)/messages/page.tsx` → `MessagesView` — **Slack-style DMs: rail bucketed by COUNTERPARTY** (`view.directMessages` = fabric `summarizeDirectMessages`, last message + "You:" + date), requests pinned, **scoped To: picker** (`chat/RecipientPicker.tsx` + `src/lib/recipient-directory.ts`: Names = KB list-all/filter · Organizations/Workspaces = `/connect/directory` listings ∪ `/connect/received-delegations` invite-redeemed members — a UNION, incl. NAMELESS members by `localName`/`displayName`, addressed by SA; e2e `tests/e2e-sso/dm-scoped-picker.spec.ts`) with NO subject; a send names the recipient and demo-a2a derives the deterministic pair id (`directConversationId`). `/inbox` `/chats` `/find` redirect here. `src/home/use-inbox.ts` (shared view, 5s metadata-only polling, `loadThread` per conversation, `loadPreviews` by message id, names map) + `server/connect/channels.ts` (community boards, membership = current directory listing, audit-before-commit) — nav group in `src/components/portal/nav.ts` |
| Visibility / invitations (spec 338 §20, W6) | `app/(portal)/visibility/page.tsx` + `src/components/portal/visibility/*` (posture presets, issued-invitations panel, recipient inspector) + **`src/lib/invitation-check.ts`** — the verification logic lives THERE (pure + tested), not in the component. Presets/validation come from `@agenticprimitives/agent-resolution`, so the UI cannot drift from the protocol. Signature + endpoint-control render as `unchecked` (they need an on-chain read), never as a pass; the pane always ends with `AUTHORIZATION_NOT_GRANTED` — finding an agent is not permission to use it. Issuing + revoking are REAL (W6-b) and **delegated issuance is wired** (W6-c): `src/home/discovery-authority.ts` mints an appointment — an ordinary caveated delegation scoped to `agent.discovery.grant.issue` — that a keyholder signs once so another party can issue for that agent afterwards. `DiscoveryAuthorityPanel` mints it; `InvitationsPanel` accepts a pasted one. **Named `discovery-authority`, NOT `stewardship`** — `src/home/stewardship.ts` already means "things the member helps oversee". Client-side bundle validation is a COURTESY (`validateDiscoveryAuthorityBundle`, 20 tests); the resolver re-hashes and re-verifies on-chain regardless. |
| Org lifecycle — activate / deactivate / delete (spec 342) | `src/lib/org-lifecycle.ts` (PURE: statuses + the `working`/`roster`/`any` visibility rule + the parent cascade — tested) + `src/home/org-lifecycle.ts` (read/write: vault record FIRST, projection second) + `OrgSettingsSection` in `src/components/portal/settings/org-manage.tsx` + `/org/<sa>/settings`. **The RECORD is `org.lifecycle` in the ORG's vault** over the stewardship delegation (that delegation IS the authorization — no second permission flag); the `status` on the related-org link is a rebuildable PROJECTION so a roster needn't do a vault read per row. **Absent means active.** Filtering happens at the READ boundary (`listMyOrgs` / `listManagedAgents` / `useManagedAgents` default to `working`), so a new screen hides deleted orgs without knowing the spec — pass `'roster'` for the organizations list, `'any'` for anything addressed by an org's SA. Delegation surfaces are deliberately NOT filtered: deactivating revokes nothing, and hiding a live grant would remove the only place to revoke it. |
| **Security section (spec 422)** — the third sidebar pane; EVERY feature here is ALSO an Ask capability (`src/home/security-ceremonies.ts` = the one implementation the buttons and the Ask share; runtime `demo-a2a/src/security-tools.ts`) (`securityPane`, `PaneId 'security'`), `/security` overview + `/security/sign-in` | `src/home/credentials.ts` (chain ⊕ vault labels join — the chain decides, the vault labels; `security.credentials` / `security.channels` records) + `src/lib/security-grade.ts` (grade = the SERVER's, never the sign-in word) + the one policy table `canPerformSecurityAct` (`@agenticprimitives/connect`); channels unlink by KV tombstone (`server/connect/{email,phone}-unlink.ts`). **No bare remove**: retire = rotation (gen 3) or recovery; granted delegations moved to `/grants`, the Google new-home panel to `/profile` |
| KB search + naming properties (spec 314) | `src/lib/agent-search.ts` (partial match via discovery MCP → GraphDB, ONE mechanism — no chain fallback) + `src/lib/name-properties.ts` (`readNameRecords`/`writeNameProperties`: encodeRecords pre-sign + on-chain ontology validation, batched userOp, fires reindex) + Properties panel in `app/(portal)/naming/page.tsx` |

## Hard rules (this app)
- **Name labels: the label is the FIRST dot-segment** (`homeLabel`), parent-agnostic. Do NOT strip a
  fixed suffix — `<label>.impact` got flattened to `<label>impact.impact` once (the `.demo.agent` bug).
- **The home holds NO session private key.** The relying app generates the session keypair; the home
  receives only the public `session_key` and SIGNS the DEL-001 leaf for it (spec 270 v4, no cross-origin
  key transport).
- White-label / faith vocabulary lives in `src/whitelabel/` + app config — never leaks to packages.

## Validate
```bash
pnpm --filter @agenticprimitives-demo/sso-next typecheck
pnpm --filter @agenticprimitives-demo/sso-next test   # added W6 — the app HAD a vitest.config.ts and
                                                      # test files but no `test` script or vitest dep,
                                                      # so its suites never ran. They do now.
```
(There is still no `pnpm check:demo-sso-next` aggregate.)
