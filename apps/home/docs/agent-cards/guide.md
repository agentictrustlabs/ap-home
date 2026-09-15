# Agent Card & Projection Studio — Home guide (spec 347 W4a, service side)

The Studio lets a steward author, release, sign and publish a managed agent's **A2A Agent Card**, then project a
released card into the **AP Naming** records and the **AP Registry** entry — with every record in the agent's own
vault, every side effect approval-gated, and every signature made by the party that holds the key. This guide
covers the service contract the UI is built on (`apps/agent-runtime/src/agent-card-studio.ts`) and the typed Home
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

## Using the Studio (flow of 2026-08-30)

Open **Card & Projections** on an org or service you steward. Tabs, in order — each one a complete job, each showing its own status in the strip:

1. **Describe your agent.** The description is filled in from the agent's profile, names and running service.
   `Edit description` if something should differ. It is checked automatically whenever you save; the step's
   status says *Ready to publish ✓* or *N things to fix* with a `Show me` that opens the editor at the problem.
2. **Make it live.** One `Publish` button runs the whole chain — *Checking the description… → Freezing this
   version… → Signing it… → Publishing… → Confirming it's live…* — and stops only where a decision or a
   different person is needed: an optional one-time custodian signature (*Sign with custodian* / *Skip for
   now*), or *Waiting for someone with approval rights* when roles are split. It ends at *Live ✓* with `Open`.
   Publishing does not list the agent anywhere; it makes the description available at its address.
3. **One tab per place it can be listed** (*Your name record*, *<Brand> directory*) — *Your name record*, *<Brand> directory* — with one
   `List it` / `Update listing` button that prepares the listing, asks your custodian to sign once, writes the
   record and confirms it. Anything that will not carry over is one sentence above the button; everything
   technical is under `Details`.

`History` shows every version with its audit detail (and *Retire* / *Withdraw* for a live one). `Advanced ▾`
opens the inspector: the exact JSON, what the public endpoint is serving right now, provenance, checks.

