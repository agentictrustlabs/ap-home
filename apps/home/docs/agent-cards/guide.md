# Agent Card & Projection Studio — Home guide (spec 347 W4a, service side)

The Studio lets a steward author, release, sign and publish a managed agent's **A2A Agent Card**, then project a
released card into the **AP Naming** records and the **AP Registry** entry — with every record in the agent's own
vault, every side effect approval-gated, and every signature made by the party that holds the key. This guide
covers the service contract the UI is built on (`apps/demo-a2a/src/agent-card-studio.ts`) and the typed Home
client (`src/studio-client.ts`). Spec of record: [spec 347](../../../../specs/347-a2a-agent-card-and-projection-studio.md) ·
[ADR-0062](../../../../docs/architecture/decisions/0062-agent-card-projection-publication-binding.md).

## The transport

`studio-client.ts` posts `{ delegation, requester, args }` to `POST /a2a/agent-cards/<op>`; Next rewrites `/a2a/*`
to demo-a2a. This is the **same first-party per-agent record path** the Home already uses for a managed agent's
vault (`lib/vault-client.ts` → `/a2a/mcp/vault/*`), chosen over the A2A `message/send` skill path because the Home
talks to its managed agents through delegation-bound routes today and the Studio ops are request/response, not
tasks. The Home never touches MCP (ADR-0044; `pnpm check:no-direct-mcp-in-web` stays green): demo-a2a forwards
every vault read/write under the presented delegation through `callMcpToolWithProof`, and demo-mcp verifies the
grant per call.

The `delegation` is the **stewardship wire** (`ManagedAgent.stewardshipDelegation`: delegator = the managed agent,
delegate = the person). It is the only credential a call carries. The server derives:

| Who presents the wire | Relationship | Scopes |
| --- | --- | --- |
| a person / org SA (`atl:agentType` root ≠ service) | `steward` (or `self` when delegate = delegator) | every `AGENT_CARD_SCOPES` + `agent.projection.publish:ap-naming/ap-registry` |
| a Service Agent (root = service) — the Agent Metadata Steward | `steward` | `STEWARD_DEFAULT_SCOPES` only: read · draft · validate · preview. Never approve / sign / publish / verify bindings / transact |

`SEPARATION_OF_DUTIES=strict` (demo-a2a var, default off) additionally refuses `release.approve` from the draft's last
editor and `projection.approve` from the plan's author. They remain distinct scopes and distinct audit rows either way.

## Who signs what

| Step | Signer | Key / credential | Verified by |
| --- | --- | --- | --- |
| card JWS (`release.sign`) | the Home, in the browser | a WebCrypto **ES256 (P-256)** pair (`newCardSigningKey` → `signReleaseLocally`); only the **public JWK** is sent | demo-a2a re-derives the RFC 8785 bytes and verifies the JWS with the supplied JWK (kid = RFC 7638 thumbprint). The key is stored as `agent-cards:<card>:signing-key:<kid>` (public only) |
| Smart Agent binding (`SmartAgentCardBindingV1`, optional) | the SA's **custodian** | the same `signHash` every authority op uses (`signSmartAgentBinding`) | ERC-1271 `isValidSignature` on the SA, digests pinned to the release |
| naming / registry publication | the SA, gasless userOp | `executeCalls(sa, signHash, calls)` (`executePublicationPlan`) | demo-a2a re-reads the chain with `readContract` and compares with the artifact — one mechanism, no log scans |
| registry binding proof (ap-registry) | the SA's custodian | `signHash(signatureRequests[i].digest)` | carried in the receipt; ERC-1271-verifiable by any AP verifier |
| approvals | the approver principal | none — an `ApprovalRefV1` names the exact digest (`unsignedContentDigest` / `planDigest`) and idempotency key | `transition(... 'approved')` / `assertApprovalCoversPlan`, fail-closed |

The **server never holds a private key or the custodian**. The only server-side effect that is not a vault write
is the `RELEASED_CARDS` KV put (below).

## The flow, in prose

1. **Create** (`createCard`) — the draft is *inherited*, never typed by hand: `inheritCardBase` over the agent's LIVE
   card (`buildA2aAgentCard` — interfaces, capabilities, mounted skills), the anchored canonical profile (or a
   computed stand-in when unanchored), the primary name, and the public capability claims (`atl:skills` labels).
   Every field carries a `FieldBindingV1` (`inherit | computed`).
2. **Curate** (`patchDraft`) — JSON Patch over the draft; each touched pointer becomes an `override` binding that
   remembers the digest of the value it replaced. `expectedRevision` is mandatory; a stale one is a **409**
   (`StudioCallError.currentRevision` tells the UI where the draft is). One mutation = one revision. `importCard`
   swaps the draft for an external document as a *proposal* (every field `manual` from `import`; the exact bytes
   are kept under `agent-cards:<card>:import:<digest>`).
3. **Validate** (`validateCard`) — `validateA2ACard` against the live card's interfaces / capabilities / skills.
   `createRelease` refuses a draft with errors (422 with the diagnostics).
4. **Release** (`createRelease`) — the draft is frozen into `agent-cards:<card>:release:<id>` (append-only:
   `unsignedContentDigest` never changes; the draft forks with `basedOnReleaseId`).
5. **Approve** (`requestReleaseApproval` → `approveRelease`) — state `approvalPending → approved`, an
   `ApprovalRefV1` under `approvals:<id>`.
6. **Sign** (`signReleaseLocally` + optionally `buildSmartAgentBinding` / `signSmartAgentBinding` → `signRelease`) —
   state `signed`; `signedContentDigest` = sha256 of the JCS of the signed card.
7. **Publish** (`publishRelease`) — demo-a2a writes `released-card:<sa>` `{ digest, releaseId, bytes }` into
   `RELEASED_CARDS`, where `bytes` is the JCS of the signed card, so the well-known route serves them byte-for-byte
   with `x-ap-card-digest`. It then **re-fetches** `https://<host>/.well-known/agent-card.json` and compares both the
   served bytes' digest and the header with `signedContentDigest`: `valid` → the release is `published` and the
   previous published release is `superseded`; `invalid` / `unverified` → the receipt says so and the release
   stays `signed` (re-run `verifyReleasePublication` later). `deprecateRelease` / `revokeRelease` drop the cache entry.
8. **Project** (`configureProjection` with `family` + the released card → `previewProjection`) — a sealed
   `ProjectionInputBundleV1` (canonical agent, profile ref, selected release digest + publication URI, names,
   public claims, existing bindings) runs through the PURE `apNamingProjector` / `apRegistryProjector`; the
   artifact, its eight digests and its **loss report** are stored under `projections:<instance>:artifact:<digest>`.
9. **Plan** (`planProjectionPublication`) — `buildAp{Naming,Registry}PublicationPlan`; the server returns the
   `PublicationPlanV1` **plus** `contractCalls` (for ap-naming: `agent-naming` `buildRecordCalls` over the
   name's resolver — `addr`, `agentKind`, `displayName`, `a2aEndpoint`, `metadataUri/Hash`, `atl:cardDigest`,
   `atl:cardUri`) and `signatureRequests` (ap-registry: the binding-proof digest).
10. **Approve** (`requestProjectionApproval` → `approveProjectionPublication`) — an `ApprovalRefV1` naming the
    `planDigest` and the plan's idempotency key.
11. **Execute + record** (`executePublicationPlan` / `executeNamingPlan`) — the Home signs any requested digests,
    batches the calls into ONE userOp on the SA, then calls `recordProjectionPublication`; the server re-checks
    the approval (`assertApprovalCoversPlan`), verifies **on chain** and writes `PublicationReceiptV1`
    (`verification.result: valid | invalid`) + `ExternalIdentityBindingV1` (`active` / `pendingVerification`).
    `verifyBinding` re-reads the chain later (drift → `stale`).

## Where the records live (ADR-0055)

All in the **managed agent's vault**, delegation-scoped — `agent-cards:index`, `agent-cards:<card>:{draft,meta,
release:<id>,signing-key:<kid>,import:<digest>,publication:<receipt>}`, `agent-cards:idem:<key>` (idempotency
replay), `projections:index`, `projections:<instance>{,:artifact:<digest>,:plan:<id>,:receipt:<id>}`,
`bindings:index`, `bindings:<id>`, `approvals:<id>`. Releases, artifacts, plans, receipts, publications and
approvals are **append-only** (a write with different content is a 409); drafts are optimistic-concurrent.

**The KV cache is a rebuild, not a bereavement.** `RELEASED_CARDS` holds only what `release.publish` copies out of the
vault. Wiping it makes the well-known route serve the live card again; `publishRelease` (or
`verifyReleasePublication` after a re-publish) restores it. Nothing the Home cannot regenerate lives there.

## Audit

Every op writes an `audit` row through demo-a2a's sink (console + D1 when bound) with the spec's
`STUDIO_AUDIT_ACTIONS` name and the `StudioAuditContextV1` fields flattened into `context` (canonical id, object,
actor, authority ref, input/result digests, target, correlation id, receipt / tx refs, privacy class). Scope refusals
are `outcome: denied` rows under the op name; publication failures are `outcome: error`.

## Limits (this wave)

- **Families**: `ap-naming` and `ap-registry` only; every external target (OASF / ERC-8004 / HCS / ANS) is a
  sibling-repo adapter (ADR-0037) and `configureProjection` refuses it (400 `unsupported_family`).
- **Profile digest**: when the agent has no anchored profile a computed stand-in is used; `canonicalProfile.digest`
  is the sha256 of the JCS snapshot the Studio consumed (what the naming projector writes into `metadataHash`),
  not the keccak `profileContentHash` on the SA-keyed profile resolver — reconcile in a later wave.
- **Public claims** come from the on-chain `atl:skills` labels (public by construction); vault-held
  `SkillClaimCredential`s are not read yet (`selectPublicSkillClaims` is the hook when they are).
- **Well-known re-fetch** runs from inside the Worker against its own public host. KV is eventually consistent
  and a same-account fetch can hit a loopback refusal (memory: CF-1042); both surface as `invalid` /
  `unverified` receipts, never as a silent `published`. `verifyReleasePublication` re-runs the check.
- **Names**: one name per agent (the reverse-resolved primary); the host is projected from it
  (`hostForName` — `<label>.<base>` for person roots, `<label>.<tld>.<base>` for typed suffixes).
- **Caller class** is read from the delegate's on-chain `atl:agentType` / `atl:agentKind`; an untyped SA is treated
  as a human principal (service agents are typed at creation).
- **Runtime validation** (`Test interfaces`) has no operation: reachability/handshake checks are an app-side
  SSRF-safe port (spec 347 §4.4) that this wave does not ship, so `evidenceNeeded` diagnostics explain what is
  missing instead of offering a button that cannot act.
- **Restoring an inherited value** has no operation either: `agent-profile`'s `acceptInherited` exists but no
  Studio op reaches it, so the editor's `Restore inherited` control says why it cannot act rather than doing
  something else (a `remove` patch is an override to `undefined`, not a restore).
- **Steward proposals** have no operation: a service-agent caller writes into the draft under
  `STEWARD_DEFAULT_SCOPES`; there is no proposal queue to read, accept or reject.

## Using the Studio (W4b)

The screens live under **Home › {org|service workspace} › Manage › Card & Projections**
(`src/components/studio/*`, nav ids `org-card` / `service-card`). A card belongs to the **agent**, so both
workspace kinds render the same sections from `CardStudio.tsx` — there is no org copy and service copy.

### Routes

| Route | What it is |
| --- | --- |
| `/org/<sa>/card` · `/service/<sa>/card` | The cards list. Empty → **Create from profile** (`card.create`, every inheritable field bound `inherit`), or *Import an existing A2A card instead* |
| `…/card/<cardResourceId>` | **Agent Card** — the three-pane editor |
| `…/card/<cardResourceId>/projections` | **Projections** — configure · preview · plan · approve · execute |
| `…/card/<cardResourceId>/names` | **Names & Bindings** — ownership / resolution / canonical identity / current card publication / registry binding, as five separate rows |
| `…/card/<cardResourceId>/releases` | **Releases & Audit** — the stepper plus every release this card has had |

Deep-link params are read once on mount and cleared from the URL: `?pointer=<jsonPointer>` (open the owning
section and focus the field), `?diagnostic=<code>`, `?stale=1`, `?release=<id>`, `?instance=<id>`,
`?import=1`.

### The editor

Sections, fields and inspector panels are rendered **directly from `A2A_CARD_EDITOR_MANIFEST`** — a manifest
change ships without a component edit. Each row shows the manifest's label and help, a provenance badge
(`inherited` / `overridden` / `manual` / `computed` / `verified` / `stale` / `conflict`), and a source popover.
Optional booleans are a three-way **radio group** (Unset · No · Yes) because `unset` and explicit `false` are
different documents. Interfaces are ordered — first is preferred — and reorder by `Alt+↑`/`Alt+↓` as well as
by the visible Move up / Move down buttons. Skills are a curation list: only what is listed appears publicly.

Editing is optimistic and every mutation carries `expectedRevision`. A 409 `stale_revision` shows *"This
draft changed while you were editing"* with **Review their changes** / **Overwrite with mine** — never a
silent last-write-wins.

### The stepper, and what each signature is

`Validate → Create release → Request approval → Approve → Sign → Publish → Verify`. A step the viewer cannot
perform shows *"Waiting on someone with … access"* instead of a button (the scope picture is rendered from
`dutiesOf`; the service re-checks and refuses with 403 `scope_not_held`). Creating a release shows the
release **diff** as its confirmation.

Signing is two decisions by two different keys, so it stays two steps:

1. **Card signature** — a WebCrypto ES256 key generated in your browser signs the RFC 8785 canonical bytes
   (`newCardSigningKey` + `signReleaseLocally`). Any A2A client can check it; only the public JWK is sent.
2. **Smart Agent binding** — your SA's custodian signs the EIP-712 `SmartAgentCardBindingV1`
   (`buildSmartAgentBinding` + `signSmartAgentBinding`), verified on read through ERC-1271. Only AP-aware
   verifiers need it.

`release.sign` attaches a JWS and (optionally) the binding in **one** call and refuses a call carrying no new
signature, so the binding cannot be bolted onto an already-signed release. The panel therefore *prepares* the
JWS in the browser under ①, and the step you finish with submits: **Attach without binding** (card signature
alone) or **Bind to Smart Agent** (both, one call). Nothing is collapsed and no second signature is minted
behind your back.

`Publish` stays busy through the well-known re-fetch (`Publishing…` → `Verifying…`) and only claims
*"Live and verified"* when the served digest matches; otherwise it says the publish landed but the check
hasn't confirmed yet.

### What "Execute with your custodian" does

On the Projections tab: `Preview` runs the pure projector (no side effects) and shows the artifact's **loss
report** in plain language. `Plan publication` builds the `PublicationPlanV1`; the plan review discloses the
operations, the estimated cost, the ceiling, whose credential, and how long the plan is valid — before any
approval exists. After **Request approval** → **Approve this plan**, `Execute with your custodian` signs any
requested digests with your SA's custodian, batches the plan's contract calls into ONE gasless userOp
(`executePublicationPlan` / `executeNamingPlan`), and reports the transactions so the service can verify them
on chain and record the receipt + binding. That is the moment a device confirmation appears; the button's
step labels say so (`Preparing transaction…` → `Waiting for your confirmation…` → `Publishing…` →
`Verifying…`).

A remote change is never overwritten from here — it becomes a proposal to review, because the remote might be
right and the canonical side stale.
