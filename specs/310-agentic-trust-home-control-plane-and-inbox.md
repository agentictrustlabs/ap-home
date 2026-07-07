# Spec 310 — Agentic Trust Home: portable control-plane contract + agentic inbox

**Status:** Draft v0 · **Architect-of-record:** this spec
**Scope:** codify **Home** — today implemented as `demo-sso-next` (the "Impact Home" at `impact-agent.me`)
— as a *portable Ring-0 control-plane contract*, and make Home the canonical review/approval surface for
the messaging + interactions primitives in [spec 309](309-messaging-and-interactions.md). Adds one narrow
package, `@agenticprimitives/home`, that owns **manifests, surface descriptors, projections, and action
cards only** — never the Home app. `demo-sso-next` remains the reference Home *implementation*.
**Companion:** [spec 309](309-messaging-and-interactions.md) (messaging/interactions primitives the Home
renders).

**Builds on:**
[100](100-package-boundary-doctrine.md) ·
[220](220-agent-identity-bootstrap.md) (deploy → name → custody → facets) ·
[231](231-personal-subdomain-endpoint.md) (personal subdomain = SSO + A2A endpoint, a *surface* for the agent) ·
[234](234-white-label-agentic-trust-site.md) (the white-label Trust Site + Personal Trust Home this extends) ·
[261](261-ap1-public-profile-schema.md) / [262](262-ap2-agent-capability-descriptor.md) (public profile + capability descriptor) ·
[275](275-multi-agent-management.md) (create/name/manage the agent tree from the Home) ·
[288](288-agentic-edge-admission-and-surface-catalog.md) (surface descriptors; admission ≠ authority) ·
[294](294-unified-connection-custodian.md) (custodian backs all authority) ·
[295](295-relying-connect-client.md) (relying-app connect) ·
[298](298-impact-home-person-connect-onboarding.md) (the Impact Home onboarding journey — an app-level flow) ·
[309](309-messaging-and-interactions.md) (inbox/interactions).
**ADRs:** [0010](../docs/architecture/decisions/0010-smart-agent-canonical-identifier.md) (SA is the identity;
Home is a *facet*) · [0021](../docs/architecture/decisions/0021-generic-packages-vs-white-label-apps.md)
(generic packages vs white-label apps) ·
[0037](../docs/architecture/decisions/0037-primitives-pure-repo-external-integration-and-ux-layers.md)
(Ring-0 primitives vs external UX/integration) ·
[0043](../docs/architecture/decisions/0043-edge-owns-admission-never-authority.md).

## 0. Executive summary

Home is the single place a person, organization, or service agent goes to **see and control what agents,
apps, credentials, vaults, delegations, and requests are acting in their name.** Today that surface exists
only as an app (`demo-sso-next`, spec 234/275/298): it hosts credential ceremonies, signs delegations,
claims names, and manages the agent tree. As we add messaging, interactions, approvals, credential
delivery, connected-app management, and an agentic inbox (spec 309), there is now enough *stable,
cross-product* shape to extract a small **portable contract layer** — without dragging the app into Ring 0.

**The split (the whole point of this spec):**

- **`@agenticprimitives/home`** (new, narrow package) owns **portable contracts only**: `HomeManifestV1`,
  `HomeEndpointSetV1`, `HomeSurfaceDescriptorV1`, `HomeContextV1`, `ManagedAgentEntryV1`,
  `ConnectedAppGrantV1`, `HomeInboxBindingV1`, `HomeInboxSummaryV1`, `HomeActionCardV1`, and
  `HomeControlEventV1`. Schemas + validators + deterministic projections. No routes, no React, no branding,
  no hostnames.
- **`demo-sso-next`** stays the **reference Home app**: Next.js routes, components, white-label config,
  cookies/sessions, OIDC placement, provider secrets, DB adapters, notification integrations, and any LLM
  inbox triage. Per ADR-0021/0037 all of that is app-layer.

**The doctrine that makes this safe:** **Home is a facet, not the identity.** The canonical Smart Agent
address (ADR-0010) remains the anchor; a Home is a *resolvable control-plane facet* of that address — so an
agent can have a default Home, a self-hosted Home, an org-managed Home, a recovery Home, or a rotated Home
endpoint, and the identity never couples to `impact-agent.me`, Vercel, or Next.js. Spec 231 already points
here (the personal subdomain is a *surface for* the agent, not the identity); this spec gives that surface a
schema.

## 1. Reference: smart-agent patterns to port

`/home/barb/smart-agent` (branch `003-intent-marketplace-proposal`) has a single "member dashboard" that
combines identity, org/agent creation, co-owner invites, and a notification bell
(`docs/specs/invite-and-messaging.md`). We port the *control-plane composition* — one place that surfaces
your agents, your connected relationships, and your pending requests — and the notification-bell + unread
model. **Deliberate divergence:** smart-agent's dashboard is a monolithic app bound to its own DB and
`userId` model; we extract only the *portable contracts* (manifest/surface/projection/action-card) into
Ring 0 and keep the app (routes, DB, branding) out, per ADR-0021/0037. smart-agent's identity is an EOA +
app account; ours is the canonical SA address, and Home is a facet of it (ADR-0010), not the account.

## 2. The Home model — five surfaces, portable contracts only

Home is five things to a user; the package owns only the *portable contract* for each:

| # | Surface (product) | Portable contract (`home` package) | Authority/data owner (existing packages) |
| --- | --- | --- | --- |
| 1 | Identity entrypoint (sign-in, SSO, FedCM, agent context) | `HomeContextV1` (which SA is active + held badges) | `connect`, `connect-auth`, `fedcm-idp`, `agent-account` |
| 2 | Connected-app control plane (which apps hold which grants) | `ConnectedAppGrantV1` projection | `delegation` (the grants), `audit` |
| 3 | Managed-agent console (person/org/treasury/service tree) | `ManagedAgentEntryV1` projection | `agent-account`, `agent-naming`, `related-agents` (spec 275) |
| 4 | Vault / credential / delegation review | `HomeActionCardV1` (review cards) | `vault`, `entitlements`, `key-authorization`, `verifiable-credentials`, `delegation` |
| 5 | Agentic inbox + approval queue | `HomeInboxBindingV1` + `HomeInboxSummaryV1` | `messaging`, `interactions` (spec 309) |

Home does **not** replace `messaging`/`interactions` — it is their default human/org/service-agent review
surface. It does not own authority — every "approve/deny/issue/revoke" routes through the existing packages.

## 3. `@agenticprimitives/home` — package contract

**Owns:** portable schemas + validators + deterministic projections for the five surfaces; nothing else.

```ts
export interface HomeManifestV1 {
  type: 'ap.home.manifest.v1';
  homeId: string;
  owner: CanonicalAgentAddress;              // ADR-0010 — the identity this Home is a facet of
  operator?: CanonicalAgentAddress;          // who runs the Home (may differ from owner)
  status: 'active' | 'rotating' | 'deprecated' | 'suspended';
  endpoints: HomeEndpointSetV1;              // sso / a2a / inbox / outbox / well-known (surfaces, not identity)
  surfaces: HomeSurfaceDescriptorV1[];       // which of the 5 surfaces this Home serves + their capability level
  capabilities: HomeCapabilityCardV1;        // supported message/interaction kinds, crypto + delivery profiles, card uiProfiles
  inbox?: HomeInboxBindingV1;
  cryptoProfiles?: HomeCryptoProfileDescriptorV1[];
  policyRefs?: PolicyRefV1[];
  validFrom: string; validUntil?: string;
  proof: ProofRefV1;                         // signed by the owner SA (or operator under delegation)
}

export interface HomeInboxBindingV1 {
  owner: CanonicalAgentAddress;
  inboxEndpoint?: EndpointRef; outboxEndpoint?: EndpointRef;   // ActivityPub-style inbox/outbox shape
  messageStoreRef?: StoreRef; interactionStoreRef?: StoreRef; projectionStoreRef?: StoreRef;
  supportedMessageKinds: string[];            // from `messaging`
  supportedInteractionKinds: string[];        // from `interactions`
  supportedCryptoProfiles: string[]; supportedDeliveryProfiles: string[];
}

export interface ManagedAgentEntryV1 {
  agent: CanonicalAgentAddress;
  agentType: 'person' | 'organization' | 'service' | 'treasury' | 'vault' | 'device';
  relationship: 'self' | 'owned_by_subject' | 'administered_by_subject'
              | 'delegated_to_subject' | 'represented_by_subject' | 'service_for_subject';
  controlGrade: 'view' | 'operate' | 'admin' | 'custody' | 'root';
  status: 'active' | 'pending' | 'disabled' | 'revoked';
  supportedActions: HomeActionDescriptorV1[];
}

export interface ConnectedAppGrantV1 {
  app: AppRef; grantRef: AuthorityRef;        // references a `delegation` token — not a new authority
  scope: string[]; grantedAt: string; expiresAt?: string;
  status: 'active' | 'expired' | 'revoked';
}

export interface HomeActionCardV1 {
  type: 'ap.home.action-card.v1';
  cardId: string; interactionId: string; messageId?: string;
  cardKind: 'access_request' | 'entitlement_request' | 'credential_review' | 'tool_approval'
          | 'delegation_review' | 'policy_exception' | 'revocation_notice' | 'needs_information';
  title: string; summary?: string;
  dataRefs: DataRef[]; risk?: ActionRiskMetadataRef;
  allowedActions: HomeActionDescriptorV1[];
  uiProfile: 'agenticprimitives-card-v1' | 'a2ui' | 'open-json-ui' | 'mcp-ui-resource';
  schemaRef?: string; proof: ProofRefV1;
}

export interface HomeControlEventV1 {           // control-plane audit projection
  type: 'ap.home.control-event.v1';
  homeId: string; actor: CanonicalAgentAddress;
  eventType: 'grant-issued' | 'grant-revoked' | 'agent-added' | 'agent-disabled'
           | 'credential-issued' | 'credential-received' | 'inbox-decision' | 'home-rotated';
  at: string; refs: (AuthorityRef | VaultRef)[]; auditRef: AuditRef;
}
```

**Imports:** `types` (+ referenced *types* from `messaging`/`interactions`/`delegation` where a shared ref
is unavoidable — see Open Question 1). **Must NOT** import `a2a`, `mcp-runtime`, `agent-account`
runtime, Next.js, React, or anything Cloudflare/Vercel. The package is schema + validation + projection
logic that runs anywhere.

**Does NOT own (stays in `demo-sso-next` / apps):** Next.js App Router pages, React components, white-label
branding + tenant copy, `impact-agent.me`/`.io` assumptions, Vercel/deployment topology, cookie/session
implementation, OIDC provider secrets, DB/KV/R2 adapters, SMTP/Graph/Slack/Matrix clients, LLM
summarization/triage, push/email/SMS delivery, analytics, billing/admin SaaS features. (ADR-0021: packages
carry no branding/vertical/deployment specifics.)

## 4. Home is the right home for the agentic inbox

The inbox in spec 309 is more than mail — messages, access/entitlement requests, tool approvals,
human/agent interrupts, credential deliveries, revocation notices, service-agent notifications, A2A
handoffs, vault-release requests, connected-app consent. That is exactly the Home's job: the durable review
surface for everything acting in the owner's name. So:

- `messaging` owns durable envelopes/receipts/folders/cursors/delivery.
- `interactions` owns requests/approvals/interrupts/resumes/mandates/credential-delivery.
- `home` **declares** (via `HomeInboxBindingV1` + `HomeInboxSummaryV1`) that this agent's Home can render
  and act on those surfaces, and provides the deterministic *summary projection* (unread counts per
  surface, pending-approval count, needs-info count) the app renders.

### 4.1 Safe declarative cards, not remote code

`HomeActionCardV1` lets a sender *propose* a rich approval/request card (via `uiProfile`: our native card,
or A2UI/OpenUI/MCP-UI descriptors); the Home *chooses how to render* with trusted native components. The
primitive never allows arbitrary remote UI code as the default — it defines the declarative schema and the
allowed-actions contract, and the app owns rendering + safety (MCP-UI iframe-sandbox pattern if a remote
profile is ever enabled).

### 4.2 Task-scoped mandates issued from the Home

The most valuable "smart" capability: from the inbox/approval surface a person or org issues a signed
`InteractionMandateV1` (spec 309 §6.2) — "yes, this agent may request this resource, for this purpose,
under these constraints, until this expiry, with this audit trail." **Mapping stays honest:** the mandate is
a `delegation` token scoped by `ap-scope-vocabulary` (spec 308) + a `verification-receipt` (spec 303) of the
consent; the Home is the *issuance UX*, the authority is the existing delegation primitive.

## 5. What goes where (boundary table)

| Capability | Primitive owner | Home role |
| --- | --- | --- |
| Sign-in / SSO / FedCM / OIDC broker | `connect`, `connect-auth`, `fedcm-idp` | hosts the ceremony |
| Canonical identity | `agent-account`, `contracts` | selects + displays active agent context (`HomeContextV1`) |
| Names / profiles / relationships | `agent-naming`, `agent-profile`, `related-agents` | shows identity/profile/managed agents |
| Delegation | `delegation` | initiates/revokes via UI; records `HomeControlEventV1` |
| Entitlements | `entitlements` | shows requests/decisions; package remains authority |
| Vault authorization | `vault`, `key-authorization` | reviews vault-release requests |
| Messages | `messaging` | renders inbox projections |
| Interactions | `interactions` | renders approvals/interrupts/decisions/resumes |
| Credentials | `verifiable-credentials`, `privacy-credentials` | receive/review/present credential flows |
| A2A | `a2a` | advertises endpoints; shows agent notifications |
| Audit / receipts / records | `audit`, `verification-receipts`, `relationship-record`, `witness` | emits + displays control-plane evidence |
| Home manifest / context / cards / projections | **`home`** | owns portable control-plane contracts only |

## 6. Security invariants

1. Home is a facet, not the identity — the SA address never changes when a Home is added/rotated/deprecated;
   delegations issued by the SA survive Home rotation (ADR-0010/0011).
2. A Home manifest is signed by the owner SA (or an operator under an explicit delegation); an unsigned or
   expired manifest is not trusted.
3. Home renders authority, never mints it — every approve/deny/issue/revoke routes through
   `delegation`/`entitlements`/`account-custody`/`key-authorization`; the `home` package contains no
   authority logic.
4. Action cards are declarative; no arbitrary remote UI executes by default; `allowedActions` bound the card.
5. Control-plane events are durable-audit-backed (spec 291) and fail closed for privileged outcomes.
6. No white-label/vertical/deployment content in the `home` package (ADR-0021); enforced by
   `check:no-domain-in-packages` + `check:forbidden-terms`.
7. Endpoints in the manifest are *surfaces* subject to edge admission (ADR-0043); a Home endpoint being
   reachable is not authorization.

## 7. Required repo changes

- **This PR (spec-first):** `specs/310-...` (this file); cross-link from
  [spec 234](234-white-label-agentic-trust-site.md) ("`demo-sso-next` is the reference Home *app*; portable
  Home contracts live in spec 310 / `@agenticprimitives/home`") and from
  [spec 309 §6.2/§10](309-messaging-and-interactions.md); add a **Home / Agentic Control Plane + Inbox** row
  to `docs/architecture/cross-cutting-capabilities.md`; add a `package-consumer-map.md` row ("Build a Trust
  Home / agentic inbox / connected-app control plane → `home`"); add a `task-routing.md` row.
- **Implementation waves (later, not this PR):** `packages/home/` (schemas + validators + projections);
  then `demo-sso-next` publishes a `HomeManifestV1`, adds an inbox page, pending-requests page, connected-apps
  projection, managed-agents projection (extending spec 275's Manage Agents), and an audit/control-plane
  timeline.

## 8. Implementation waves

- **W1 — `home` contracts.** Schemas + validators for manifest/context/surface/inbox-binding/action-card/
  managed-agent/connected-app-grant/control-event + deterministic `HomeInboxSummary` projection. Unit tests:
  manifest signature validation, projection determinism, action-card allowed-actions enforcement.
- **W2 — Home publishes its manifest.** `demo-sso-next` serves `HomeManifestV1` (profile data / well-known
  route / A2A AgentCard metadata — app chooses; the primitive defines only the schema).
- **W3 — Inbox surface in Home.** Wire spec 309's messaging/interactions into a Home inbox page + pending
  approvals; render `HomeActionCardV1` with native components.
- **W4 — Connected apps + managed agents.** Projections over `delegation` grants (connected apps) and spec
  275's agent tree (managed agents), with revoke actions emitting `HomeControlEventV1`.
- **W5 — Mandates + control-plane timeline.** Issue `InteractionMandateV1` from the approval surface;
  render the audit/receipt/relationship-record timeline.

## 9. Acceptance criteria

1. `@agenticprimitives/home` exports validated portable contracts with zero routes/UI/branding and passes
   `check:no-domain-in-packages`, `check:forbidden-terms`, `check:package-boundaries`.
2. A signed `HomeManifestV1` resolves an owner SA to its Home surfaces; an unsigned/expired manifest is
   rejected.
3. The Home renders an inbox summary + pending approvals from `messaging`/`interactions` projections without
   the `home` package importing `a2a`/`mcp-runtime` or any app framework.
4. Approve/deny/issue/revoke from the Home route through the existing authority packages and emit durable
   audit + a `HomeControlEventV1`.
5. A person can issue an `InteractionMandateV1` (a scoped delegation + consent receipt) from the Home.
6. Rotating an agent's Home leaves the SA address and its prior delegations intact.

## 10. Open questions

1. Does `home` reference `messaging`/`interactions`/`delegation` *types* directly, or should the shared refs
   (`CanonicalAgentAddress`, `AuthorityRef`, `VaultRef`, `MessageId`, `InteractionId`) move to `types` so
   `home` stays reference-only? (Leaning: promote shared refs to `types`.)
2. Where does the `HomeManifestV1` canonically publish — `agent-profile` record, a `.well-known` route, the
   A2A AgentCard, or a DID service entry? (The primitive defines the schema; the resolution surface is
   app/spec-231 territory — likely all-of, with one canonical source per deployment, ADR-0013.)
3. Is `home` one package or does the inbox-summary projection belong in `interactions`? (Leaning: keep the
   *control-plane* projection in `home`, the *inbox* projection in `messaging`/`interactions`.)
4. Should `ConnectedAppGrantV1` reuse the spec-306 relationship-record edges rather than a separate
   projection?
5. Multi-Home per identity (default/self-hosted/org/recovery): does the manifest need a `homeRole` + a
   precedence rule, or is that resolver-side config?
