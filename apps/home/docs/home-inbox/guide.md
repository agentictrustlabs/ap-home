# Home — agentic control plane + inbox — demo guide

How this app implements [spec 310](../../../../specs/310-agentic-trust-home-control-plane-and-inbox.md):
the portable Home contracts from `@agenticprimitives/home`, published and rendered by `demo-sso-next`
(the reference Home app, spec 234).

## Manifest (W2)

- **Compose:** `src/home/manifest.ts` builds the `HomeManifestV1` draft from `src/lib/domain.ts` (the one
  module allowed to know hostnames — ADR-0021): SSO origin, A2A endpoint, well-known URL, the five
  surfaces, capability card, inbox binding. It also computes the canonical keccak digest the owner signs.
- **Sign + publish:** the You page's Home-manifest card signs the digest with the session's ROOT
  credential (passkey / wallet / Google-KMS — the same signer paths delegations use) and POSTs to
  `/connect/home-manifest`.
- **Fail-closed gates** (`server/connect/home-manifest.ts`), in order: `validateHomeManifest` (schema),
  session ⇔ owner, label ⇔ owner via on-chain `reverseResolve`, ERC-1271 over the server-re-derived digest.
- **Serve:** `/.well-known/agentic-home` on the personal subdomain returns the stored manifest verbatim;
  unpublished or apex ⇒ 404 — never an unsigned draft (ADR-0013). Consumers gate with `isManifestCurrent`;
  **serving ≠ trust**.

## Inbox surface (W3)

- `GET /connect/inbox` returns items, folder summaries, the deterministic `projectHomeInboxSummary`
  (unread / pending approvals / needs-info counts), open cases, sender-proposed cards, and bodies.
- `app/(portal)/inbox/page.tsx` renders the pending-approvals queue and folders with native components.
  A sender-proposed card's `allowedActions` drive the buttons; unknown actions never resolve
  (`resolveCardAction` ⇒ null ⇒ reject).
- Every decision routes through the audited interactions store; the Home **renders authority, never
  mints it** — approve is a lifecycle fact, issuance belongs to the authority packages.

## Control plane (W4)

- `src/home/control-plane.ts` maps issued delegations → `ConnectedAppGrantV1` (status/expiry parsed from
  the delegation's own TimestampEnforcer caveat; `grantRef` = the canonical EIP-712 delegation hash) and
  the spec 275 managed-agent tree → `ManagedAgentEntryV1`. Projections render authority; the on-chain
  record stays canonical.
- `HomeControlEventV1` rows land on `/connect/control-events` **audit-first**: an `AuditEvent` is appended
  to the same KV audit log the inbox admitters use, and the timeline row carries its id as `auditRef` —
  no audit row, no timeline row. Emitters: delegation revoke, agent creation, inbox decisions
  (approve/deny/ask-info/revoke), manifest publication.
- The Activity page renders the timeline + the portable managed-agents projection.

## Mandate issuance (W5)

- Approving an `access-request` issues two signed artifacts under the ROOT credential
  (`src/home/mandate.ts`): a scoped **delegation** person SA → requester (timestamp + value-0 caveats —
  the actual authority, revocable from Your delegations) and the **`InteractionMandateV1`** referencing it
  by hash, with `apscope:` terms (spec 308) for actions/resource/purpose.
- Server gates, fail-closed and in order (`applyApproveWithMandate`): structure → principal = session SA →
  signature precheck → ERC-1271 over the **re-derived** digest → actingAgent = case requester → audited
  approve transition carrying the delegation hash as the case `AuthorityRef`. Any failure ⇒ no transition,
  no stored mandate.
- A `credential-issued` control event lands on the timeline; issued mandates render inline in the inbox.

## Doctrine checklist for other Home implementations

1. A Home is a **facet** — the SA address and its delegations survive Home rotation (ADR-0010/0011).
2. Publish only owner/operator-signed manifests; short validity windows; `rotating` status during moves.
3. Endpoints are surfaces subject to edge admission (ADR-0043) — reachable ≠ authorized.
4. No branding/vertical/deployment content in the `home` package; that all lives in the app.
