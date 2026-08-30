// Home → per-agent Card Studio client (spec 347 §9; ADR-0062; W4a). Typed functions for every Studio
// operation the managed agent's A2A service exposes at `POST /a2a/agent-cards/<op>` (Next rewrites `/a2a/*`
// to demo-a2a — the SAME first-party per-agent record transport `lib/vault-client.ts` uses).
//
// WHO SIGNS WHAT (the Home is the control plane, never the authority):
//   • the stewardship DelegationWire (delegator = the managed agent, delegate = the person) is the ONLY
//     credential each call carries; demo-a2a forwards every vault read/write under it and demo-mcp verifies
//     the grant per call — the Home never talks to MCP (ADR-0044);
//   • the card JWS is produced HERE with a WebCrypto P-256 key (`signReleaseLocally`); the server verifies it
//     and stores only the PUBLIC JWK;
//   • the EIP-712 `SmartAgentCardBindingV1` and any registry binding-proof digest are signed by the SA's
//     custodian through the same `signHash` every authority op uses (`signSmartAgentBinding`);
//   • naming / registry publications are executed by the SA with the custodian via `executeCalls`
//     (`executePublicationPlan`) — the server only builds the calls, verifies on chain afterwards, and
//     records the receipt + binding.
// No React, no UI: the Studio surface renders on top of this.

import type { Address, ApprovalRefV1, Hex, ProjectionDiagnosticV1 } from '@agenticprimitives/types';
import type {
  A2AAgentCardDraftV1,
  A2AAgentCardReleaseV1,
  A2AAgentCardResourceV1,
  A2AAgentCardSignatureV1,
  A2AAgentCardV1,
  A2ACardSigningKeyPair,
  CardDraftState,
  CardEnvironment,
  CardReleaseState,
  Sha256,
  SignedSmartAgentCardBindingV1,
  SmartAgentCardBindingV1,
} from '@agenticprimitives/agent-profile/a2a';
import { generateA2ACardSigningKey, signA2ACard, smartAgentCardBindingDigest } from '@agenticprimitives/agent-profile/a2a';
import type {
  ApNamingArtifactV1,
  ApNamingProjectionConfigV1,
  ApRegistryArtifactV1,
  ApRegistryProjectionConfigV1,
  ExternalIdentityBindingV1,
  PlannedContractCallV1,
  ProjectionInputBundleV1,
  ProjectionInstanceV1,
  ProjectionResultV1,
  PublicationPlanV1,
  PublicationReceiptV1,
} from '@agenticprimitives/registry-kit/projection';
import type { VerifySmartAgentCardBindingResult } from '@agenticprimitives/agent-profile/a2a';
import type { ContractCall } from '@agenticprimitives/agent-account';
import type { DelegationWire } from './lib/delegation';
import { executeCalls, type SignHash } from './connect-client';
import { ensureCsrfToken, csrfHeaders } from './csrf';

export type { DelegationWire, SignHash };

// ─── Wire shapes (mirror `apps/demo-a2a/src/agent-card-studio.ts`) ───────────────────────────────────

/** Every mutation carries these (spec 347 §9). `newMutation()` mints the ids. */
export interface StudioMutation {
  idempotencyKey: string;
  expectedRevision?: number;
  reason?: string;
  correlationId: string;
}

export function newMutation(extra: Partial<Omit<StudioMutation, 'idempotencyKey' | 'correlationId'>> & { correlationId?: string } = {}): StudioMutation {
  return { idempotencyKey: crypto.randomUUID(), correlationId: extra.correlationId ?? crypto.randomUUID(), ...(extra.expectedRevision !== undefined ? { expectedRevision: extra.expectedRevision } : {}), ...(extra.reason ? { reason: extra.reason } : {}) };
}

export type JsonPatchOp = { op: 'add' | 'replace'; path: string; value: unknown } | { op: 'remove'; path: string };

export type StudioFamily = 'ap-naming' | 'ap-registry';

export interface A2AWellKnownPublicationReceipt {
  type: 'A2AWellKnownPublicationReceiptV1';
  receiptId: string;
  uri: string;
  releaseId: string;
  contentDigest: Sha256;
  httpEtag?: string;
  cacheControl?: string;
  verifiedAt: string;
  verificationResult: 'valid' | 'invalid' | 'unverified';
  detail?: string;
}

export interface CardMeta {
  v: 1;
  createdBy: Address;
  lastEditor: Address;
  lastEditedAt: string;
  releaseIds: string[];
  nextReleaseNumber: number;
  servedReleaseId?: string;
}

export interface CardListEntry {
  resource: A2AAgentCardResourceV1;
  draftState: CardDraftState | null;
  draftRevision: number | null;
  latestRelease: { releaseId: string; state: CardReleaseState; releaseNumber: number; unsignedContentDigest: Sha256; signedContentDigest: Sha256 | null } | null;
  servedReleaseId: string | null;
}

export interface CardDetail {
  resource: A2AAgentCardResourceV1;
  draft: A2AAgentCardDraftV1 | null;
  releases: A2AAgentCardReleaseV1[];
  meta: CardMeta;
}

export interface ValidationReport {
  diagnostics: ProjectionDiagnosticV1[];
  errors: number;
  state: CardDraftState;
  revision: number;
}

export interface ImportReport {
  draft: A2AAgentCardDraftV1;
  diagnostics: ProjectionDiagnosticV1[];
  unknownFields: Record<string, unknown>;
  signatureVerification: { ok: boolean; verified: string[]; failures: Array<{ kid: string; reason: string }> } | null;
  sourceDigest: Sha256;
}

export interface StoredProjection {
  instance: ProjectionInstanceV1;
  family: StudioFamily;
  selectedCard: { cardResourceId: string; releaseId: string } | null;
  planIds: string[];
  receiptIds: string[];
}

export interface ProjectionPreview<A = ApNamingArtifactV1 | ApRegistryArtifactV1> {
  instance: ProjectionInstanceV1;
  result: ProjectionResultV1<A>;
  bundle: ProjectionInputBundleV1;
  artifactRecord: string;
}

/** What `planProjectionPublication` returns: the approvable plan + what the custodian must execute. */
export interface PlannedPublication {
  plan: PublicationPlanV1;
  contractCalls: PlannedContractCallV1[];
  signatureRequests: Array<{ purpose: string; digest: Hex }>;
}

export interface RecordedPublication {
  receipt: PublicationReceiptV1;
  binding: ExternalIdentityBindingV1;
  instance: ProjectionInstanceV1;
}

export class StudioCallError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly body: Record<string, unknown>) {
    super(message);
    this.name = 'StudioCallError';
  }
  /** 409 `stale_revision` — the draft moved; reload and retry with the current revision. */
  get currentRevision(): number | undefined {
    return typeof this.body.currentRevision === 'number' ? this.body.currentRevision : undefined;
  }
}

// ─── Transport ───────────────────────────────────────────────────────────────────────────────────────

async function studioCall<T>(op: string, d: DelegationWire, args: Record<string, unknown>): Promise<T> {
  await ensureCsrfToken();
  const r = await fetch(`/a2a/agent-cards/${op}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json', ...csrfHeaders() },
    body: JSON.stringify({ delegation: d, requester: d.delegate, args }),
  });
  const j = (await r.json().catch(() => null)) as Record<string, unknown> | null;
  if (!r.ok || !j || j.ok !== true) {
    const code = (j?.error as string | undefined) ?? 'studio_failed';
    throw new StudioCallError(r.status, code, (j?.detail as string | undefined) ?? `${op} failed (HTTP ${r.status})`, j ?? {});
  }
  return j as T;
}

// ─── Cards ───────────────────────────────────────────────────────────────────────────────────────────

export async function listCards(d: DelegationWire): Promise<CardListEntry[]> {
  return (await studioCall<{ cards: CardListEntry[] }>('card.list', d, {})).cards;
}

export async function getCard(d: DelegationWire, cardResourceId: string): Promise<CardDetail> {
  return studioCall<CardDetail>('card.get', d, { cardResourceId });
}

export interface CreateCardInput {
  environment?: CardEnvironment;
  primary?: boolean;
  displayName?: string;
  cardResourceId?: string;
}

/** Seeds the draft from the live card + profile + names + public claims (`inheritCardBase`). */
export async function createCard(d: DelegationWire, input: CreateCardInput, m: StudioMutation): Promise<{ resource: A2AAgentCardResourceV1; draft: A2AAgentCardDraftV1; inheritedFrom: { primaryName: string | null; snapshotDigest: Sha256 } }> {
  return studioCall('card.create', d, { ...input, mutation: m });
}

/** JSON Patch (add/replace/remove) over the draft; `m.expectedRevision` is REQUIRED (409 `stale_revision` otherwise). */
export async function patchDraft(d: DelegationWire, cardResourceId: string, patch: JsonPatchOp[], m: StudioMutation & { expectedRevision: number }, ifMatch?: string): Promise<{ draft: A2AAgentCardDraftV1 }> {
  return studioCall('card.patchDraft', d, { cardResourceId, patch, ...(ifMatch ? { ifMatch } : {}), mutation: m });
}

/** Import an external A2A card document (bytes kept as evidence; becomes the draft as a proposal). */
export async function importCard(d: DelegationWire, cardResourceId: string, input: { source: string; uri?: string }, m: StudioMutation): Promise<ImportReport> {
  return studioCall('card.import', d, { cardResourceId, ...input, mutation: m });
}

export async function validateCard(d: DelegationWire, cardResourceId: string): Promise<ValidationReport> {
  return studioCall('card.validate', d, { cardResourceId });
}

export async function createRelease(d: DelegationWire, cardResourceId: string, m: StudioMutation): Promise<{ release: A2AAgentCardReleaseV1; draft: A2AAgentCardDraftV1 }> {
  return studioCall('card.createRelease', d, { cardResourceId, mutation: m });
}

// ─── Releases ────────────────────────────────────────────────────────────────────────────────────────

export async function requestReleaseApproval(d: DelegationWire, cardResourceId: string, releaseId: string, m: StudioMutation): Promise<{ release: A2AAgentCardReleaseV1 }> {
  return studioCall('release.requestApproval', d, { cardResourceId, releaseId, mutation: m });
}

/** Records an `ApprovalRefV1` naming the release's `unsignedContentDigest`; approver = the delegate. */
export async function approveRelease(d: DelegationWire, cardResourceId: string, releaseId: string, m: StudioMutation, expiresAt?: string): Promise<{ release: A2AAgentCardReleaseV1; approval: ApprovalRefV1 }> {
  return studioCall('release.approve', d, { cardResourceId, releaseId, ...(expiresAt ? { expiresAt } : {}), mutation: m });
}

export interface ReleaseSignature {
  signedCard: A2AAgentCardV1;
  signature: A2AAgentCardSignatureV1;
  /** PUBLIC JWK of the signing key; its RFC 7638 thumbprint must equal the JWS `kid`. */
  signerJwk: JsonWebKey;
  smartAgentBinding?: SignedSmartAgentCardBindingV1;
}

/** Generate a card-signing key (ES256, WebCrypto). Keep the pair for the session; only the public JWK leaves. */
export async function newCardSigningKey(): Promise<A2ACardSigningKeyPair> {
  return generateA2ACardSigningKey('ES256');
}

/** Produce the JWS over the release's canonical bytes HERE (the server verifies; it never holds the key). */
export async function signReleaseLocally(release: A2AAgentCardReleaseV1, key: A2ACardSigningKeyPair): Promise<Omit<ReleaseSignature, 'smartAgentBinding'>> {
  const base = release.signedCard ?? release.unsignedCard;
  const r = await signA2ACard(base, { privateKey: key.privateKey, kid: key.kid, alg: key.alg });
  return { signedCard: r.card, signature: r.signature, signerJwk: key.publicJwk };
}

/** The EIP-712 message the SA signs for this release (spec 347 §4.2). `signedCardDigest` = sha256 of the JCS of the signed card. */
export function buildSmartAgentBinding(input: { chainId: number; sa: Address; release: A2AAgentCardReleaseV1; signedCardDigest: Sha256; cardUri: string; kid: string; validFrom?: number; validUntil?: number }): SmartAgentCardBindingV1 {
  return {
    canonicalAgentId: `eip155:${input.chainId}:${input.sa}`,
    cardResourceId: input.release.cardResourceId,
    cardReleaseId: input.release.releaseId,
    cardUri: input.cardUri,
    unsignedCardDigest: input.release.unsignedContentDigest,
    signedCardDigest: input.signedCardDigest,
    signerKeyThumbprint: input.kid,
    validFrom: input.validFrom ?? 0,
    validUntil: input.validUntil ?? 0,
  };
}

/** The custodian signs the binding digest for the SA (ERC-1271-validatable) — same `signHash` as every authority op. */
export async function signSmartAgentBinding(sa: Address, chainId: number, signHash: SignHash, binding: SmartAgentCardBindingV1): Promise<SignedSmartAgentCardBindingV1> {
  const digest = smartAgentCardBindingDigest(binding, chainId, sa);
  const signature = await signHash(digest);
  return { binding, chainId, verifyingContract: sa, signature };
}

/** Attach a client-produced JWS (+ optional SA binding). 422 `signature_invalid` / `binding_invalid` when verification fails. */
export async function signRelease(d: DelegationWire, cardResourceId: string, releaseId: string, sig: ReleaseSignature, m: StudioMutation): Promise<{ release: A2AAgentCardReleaseV1; kid: string; binding: { ok: true; digest: Hex } | null }> {
  return studioCall('release.sign', d, { cardResourceId, releaseId, ...sig, mutation: m });
}

/** Write the released bytes into the serving-plane cache, then re-fetch `/.well-known/agent-card.json` and compare digests. */
export async function publishRelease(d: DelegationWire, cardResourceId: string, releaseId: string, m: StudioMutation): Promise<{ release: A2AAgentCardReleaseV1; receipt: A2AWellKnownPublicationReceipt }> {
  return studioCall('release.publish', d, { cardResourceId, releaseId, mutation: m });
}

/** Re-run the well-known verification (moves `signed` → `published` once the served digest matches). */
export async function verifyReleasePublication(d: DelegationWire, cardResourceId: string, releaseId: string): Promise<{ release: A2AAgentCardReleaseV1; receipt: A2AWellKnownPublicationReceipt }> {
  return studioCall('release.verifyPublication', d, { cardResourceId, releaseId });
}

export async function deprecateRelease(d: DelegationWire, cardResourceId: string, releaseId: string, m: StudioMutation): Promise<{ release: A2AAgentCardReleaseV1 }> {
  return studioCall('release.deprecate', d, { cardResourceId, releaseId, mutation: m });
}

/** `m.reason` is REQUIRED; the revocation records reason, authority (the delegate), date and successor. */
export async function revokeRelease(d: DelegationWire, cardResourceId: string, releaseId: string, m: StudioMutation & { reason: string }, successor?: string): Promise<{ release: A2AAgentCardReleaseV1 }> {
  return studioCall('release.revoke', d, { cardResourceId, releaseId, ...(successor ? { successor } : {}), mutation: m });
}

// ─── Projections ─────────────────────────────────────────────────────────────────────────────────────

export async function listProjections(d: DelegationWire): Promise<StoredProjection[]> {
  return (await studioCall<{ projections: StoredProjection[] }>('projection.list', d, {})).projections;
}

export interface ConfigureProjectionInput {
  family: StudioFamily;
  /** `ap-naming`: chainId/registry are filled server-side; `ap-registry`: `registry` + `registryId` required. */
  configuration?: Partial<ApNamingProjectionConfigV1> | Partial<ApRegistryProjectionConfigV1>;
  /** The RELEASED card the projection consumes (signed or published — never a draft). */
  cardResourceId?: string;
  selectedReleaseId?: string;
}

export async function configureProjection(d: DelegationWire, input: ConfigureProjectionInput, m: StudioMutation): Promise<{ instance: ProjectionInstanceV1; family: StudioFamily; selectedCard: { cardResourceId: string; releaseId: string } | null }> {
  return studioCall('projection.configure', d, { ...input, mutation: m });
}

/** Run the PURE projector over a freshly sealed input bundle; stores the artifact (append-only) and returns it with its loss report. */
export async function previewProjection<A = ApNamingArtifactV1 | ApRegistryArtifactV1>(d: DelegationWire, instanceId: string): Promise<ProjectionPreview<A>> {
  return studioCall('projection.preview', d, { instanceId });
}

export async function planProjectionPublication(d: DelegationWire, instanceId: string, m: StudioMutation, opts: { artifactDigest?: Sha256; dryRun?: boolean; mode?: 'register' | 'renew'; planTtlSeconds?: number } = {}): Promise<PlannedPublication> {
  return studioCall('projection.planPublication', d, { instanceId, ...opts, mutation: m });
}

export async function requestProjectionApproval(d: DelegationWire, instanceId: string, planId: string, m: StudioMutation): Promise<{ instance: ProjectionInstanceV1 }> {
  return studioCall('projection.requestApproval', d, { instanceId, planId, mutation: m });
}

/** Records an `ApprovalRefV1` naming the exact `planDigest` + idempotency key; approver = the delegate. */
export async function approveProjectionPublication(d: DelegationWire, instanceId: string, planId: string, m: StudioMutation, expiresAt?: string): Promise<{ approval: ApprovalRefV1; plan: PublicationPlanV1 }> {
  return studioCall('projection.approve', d, { instanceId, planId, ...(expiresAt ? { expiresAt } : {}), mutation: m });
}

export interface RecordPublicationInput {
  planId: string;
  approvalId: string;
  transactions: Array<{ chainId?: number; hash: Hex; blockNumber?: string }>;
  /** SA signatures over `signatureRequests[].digest` (ap-registry binding proof), when the plan asked for them. */
  signatures?: Array<{ digest: Hex; signature: Hex }>;
}

/** Report the executed transactions; the server re-checks the approval, verifies on chain (`readContract`), records receipt + binding. */
export async function recordProjectionPublication(d: DelegationWire, instanceId: string, input: RecordPublicationInput, m: StudioMutation): Promise<RecordedPublication> {
  return studioCall('projection.recordPublication', d, { instanceId, ...input, mutation: m });
}

// ─── Bindings ────────────────────────────────────────────────────────────────────────────────────────

export async function listBindings(d: DelegationWire): Promise<ExternalIdentityBindingV1[]> {
  return (await studioCall<{ bindings: ExternalIdentityBindingV1[] }>('binding.list', d, {})).bindings;
}

export async function verifyBinding(d: DelegationWire, bindingId: string): Promise<{ binding: ExternalIdentityBindingV1; verdict: { ok: boolean; detail: string | null; observed: unknown } }> {
  return studioCall('binding.verify', d, { bindingId });
}

// ─── Execution with the custodian ────────────────────────────────────────────────────────────────────

/** A planned call (JSON-safe) → the `ContractCall` the SA executes. */
export function toContractCalls(calls: PlannedContractCallV1[]): ContractCall[] {
  return calls.map((c) => ({ to: c.to, value: BigInt(c.value), data: c.data }));
}

export interface ExecutedPublication extends RecordedPublication {
  txHash?: Hex;
  signatures: Array<{ digest: Hex; signature: Hex }>;
}

/**
 * Execute an APPROVED plan with the custodian and record it: sign any requested digests (`signHash`), batch the
 * contract calls into ONE gasless userOp on `sa` (`executeCalls`), then `projection.recordPublication`. The
 * plan's `approvalId` must already exist (`approveProjectionPublication`); the server refuses anything else.
 */
export async function executePublicationPlan(
  sa: Address,
  signHash: SignHash,
  d: DelegationWire,
  instanceId: string,
  planned: PlannedPublication,
  approvalId: string,
  m: StudioMutation,
): Promise<ExecutedPublication> {
  if (sa.toLowerCase() !== d.delegator.toLowerCase()) throw new Error('executePublicationPlan: the SA must be the managed agent (the delegation\'s delegator)');
  if (planned.plan.dryRun) throw new Error('executePublicationPlan: a dry-run plan is never executed');
  const signatures: Array<{ digest: Hex; signature: Hex }> = [];
  for (const req of planned.signatureRequests) signatures.push({ digest: req.digest, signature: await signHash(req.digest) });
  const calls = toContractCalls(planned.contractCalls);
  const wr = await executeCalls(sa, signHash, calls);
  if (!wr.ok) throw new Error(`publication execute failed: ${wr.error}`);
  const chainId = planned.contractCalls[0]?.chainId;
  const recorded = await recordProjectionPublication(d, instanceId, {
    planId: planned.plan.planId,
    approvalId,
    transactions: wr.txHash ? [{ ...(chainId !== undefined ? { chainId } : {}), hash: wr.txHash }] : [],
    ...(signatures.length ? { signatures } : {}),
  }, m);
  return { ...recorded, ...(wr.txHash ? { txHash: wr.txHash } : {}), signatures };
}

/** AP Naming shorthand: execute the name-record writes and record the publication. */
export async function executeNamingPlan(sa: Address, signHash: SignHash, d: DelegationWire, instanceId: string, planned: PlannedPublication, approvalId: string, m: StudioMutation): Promise<ExecutedPublication> {
  if (planned.plan.target.family !== 'ap-naming') throw new Error(`executeNamingPlan: plan targets ${planned.plan.target.family}, not ap-naming`);
  return executePublicationPlan(sa, signHash, d, instanceId, planned, approvalId, m);
}

export type { VerifySmartAgentCardBindingResult };
