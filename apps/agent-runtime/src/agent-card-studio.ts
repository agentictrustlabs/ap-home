// A2A Agent Card & Projection Studio — the SERVICE side (spec 347 §3/§4/§6/§8/§9, ADR-0062; W4a).
//
// This module is the per-agent Studio operation surface. It owns NOTHING durable: every record it touches is
// a vault record in the managed agent's own vault (`agent-cards:*` / `projections:*` / `bindings:*` /
// `approvals:*`, ADR-0055), read and written through the SAME delegation-scoped MCP seam the Home already uses
// for per-agent records (`/mcp/vault/*` → `callMcpToolWithProof` → demo-mcp `get/set/list_vault_record`).
// The `RELEASED_CARDS` KV entry the well-known route serves is a serving-plane CACHE of a release that lives
// in the vault — wiping it is a rebuild (`release.publish` again), never a bereavement.
//
// Doctrine this module enforces, and where:
//   • the Home never touches MCP — it calls `/agent-cards/<op>` here; the vault seam is injected (`StudioVault`);
//   • the server never holds the custodian — publication plans RETURN the `{to,value,data}` calls and the Home
//     executes them with the custodian (`executeCalls`), then reports back (`projection.recordPublication`),
//     where the server verifies on chain with `readContract` only (one mechanism, ADR-0013, no log scans);
//   • signing is client-side — `release.sign` VERIFIES a client-produced ES256 JWS (+ optional EIP-712
//     `SmartAgentCardBindingV1` via ERC-1271) and never sees a private key;
//   • approvals name exact digests (`ApprovalRefV1`) and are checked fail-closed (`assertApprovalCoversPlan`);
//   • releases / artifacts / plans / receipts are append-only (a write to an existing key with different
//     content is refused); drafts are optimistic-concurrent (`revision` + `etag`, 409 on stale);
//   • scopes come from the caller's relationship + class (a service-agent caller gets the Agent Metadata
//     Steward's default scopes and can never approve / sign / publish / transact); `SEPARATION_OF_DUTIES=strict`
//     refuses an approver who was the draft's last editor;
//   • every operation emits its `STUDIO_AUDIT_ACTIONS` row with the `StudioAuditContextV1` fields.
//
// Everything effectful is a PORT (`StudioDeps`) so the whole surface is unit-testable with fakes.

import type { Address, ApprovalRefV1, CanonicalAgentId, DerivedAgentType, Hex } from '@agenticprimitives/types';
import { jcsCanonicalize, rootClassForDerivedType } from '@agenticprimitives/types';
import type { CanonicalAgentProfileV1 } from '@agenticprimitives/agent-profile';
import {
  A2ACardLifecycleError,
  A2ACardValidationError,
  applyOverride,
  attachSignature,
  attachSmartAgentBinding,
  cardContentDigest,
  createRelease,
  draftEtag,
  draftFromBase,
  forkDraft,
  importA2ACard,
  inheritCardBase,
  isProjectionReady,
  jcsDigest,
  jwkThumbprint,
  revoke as revokeRelease,
  sha256Digest,
  transition,
  validateA2ACard,
  verifyA2ACardSignatures,
  verifySmartAgentCardBinding,
  type A2AAgentCardDraftV1,
  type A2AAgentCardReleaseV1,
  type A2AAgentCardResourceV1,
  type A2AAgentCardSignatureV1,
  type A2AAgentCardV1,
  type A2AAgentExtensionV1,
  type A2AAgentInterfaceV1,
  type CardEnvironment,
  type Erc1271Verifier,
  type FieldBindingV1,
  type Sha256,
  type SignedSmartAgentCardBindingV1,
} from '@agenticprimitives/agent-profile/a2a';
import {
  AP_NAMING_PROJECTION_DEFINITION,
  AP_REGISTRY_PROJECTION_DEFINITION,
  PlanNotApprovedError,
  ProjectionLifecycleError,
  apNamingProjector,
  apRegistryProjector,
  assertApprovalCoversPlan,
  buildApNamingPublicationPlan,
  buildApRegistryPublicationPlan,
  configurationDigest,
  definitionDigest,
  sealInputBundle,
  transitionBinding,
  transitionProjection,
  type AgentNameBindingV1,
  type ApNamingArtifactV1,
  type ApNamingProjectionConfigV1,
  type ApRegistryArtifactV1,
  type ApRegistryProjectionConfigV1,
  type ExternalIdentityBindingV1,
  type PlannedContractCallV1,
  type ProjectionDefinitionV1,
  type ProjectionInputBundleV1,
  type ProjectionInstanceV1,
  type ProjectionResultV1,
  type PublicSkillClaimV1,
  type PublicationPlanV1,
  type PublicationReceiptV1,
  type PublisherContext,
} from '@agenticprimitives/registry-kit/projection';
import { sha256ToBytes32, urnToBytes32, type RegistryEntryId, type RegistryId } from '@agenticprimitives/registry-kit';
import { buildRecordCalls, type AgentNameRecords } from '@agenticprimitives/agent-naming';
import {
  AGENT_CARD_SCOPES,
  STEWARD_DEFAULT_SCOPES,
  projectionPublishScope,
  type StudioAuditAction,
  type StudioAuditContextV1,
  type StudioScope,
} from '@agenticprimitives/home';
import { buildEvent, type AuditSink } from '@agenticprimitives/audit';

// ─── Ports ───────────────────────────────────────────────────────────────────────────────────────────

/** The managed agent's vault, already scoped by the delegation the caller presented (demo-mcp enforces it). */
export interface StudioVault {
  get<T = unknown>(recordType: string): Promise<T | null>;
  /** Batch multi-get (VL-W2 `get_vault_records`) — ONE round-trip for many records of the SAME owner.
   *  A fan-out of `get` was N cross-worker hops, each re-resolving the vault key; this resolves it once.
   *  Missing records come back `null`, exactly as `get` reports them — absence is an answer, not an error. */
  getMany(recordTypes: readonly string[]): Promise<Record<string, unknown | null>>;
  set(recordType: string, data: unknown): Promise<void>;
  list(): Promise<Array<{ record_type: string; updated_at?: string }>>;
}

/** The `RELEASED_CARDS` KV serving-plane cache (spec 347 §8.1). `null` when the deployment has no binding. */
export interface StudioReleasedCards {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface RegistryEntryOnChain {
  subjectAgent: Address;
  cardHash: Hex;
  bindingProofHash: Hex;
  /** `AgentRegistryBase.EntryStatus`: 0 None · 1 Active · 2 Suspended · 3 Revoked. */
  status: number;
  expiresAt: number;
}

/** Everything the Studio reads from the world — injected, so nothing here fetches or reads a chain itself. */
export interface StudioSources {
  /** The LIVE card `serveAgentCard` would build for this agent (ADR-0059 — the live-truth surface). */
  liveCard(agent: Address): Promise<Record<string, unknown>>;
  /** The anchored canonical profile (`AgentIdentityClient.fetchProfile`), `null` when unanchored. */
  profile(agent: Address): Promise<{ profile: CanonicalAgentProfileV1; uri?: string } | null>;
  /** Names bound to the agent, primary first (one entry per name). */
  names(agent: Address): Promise<AgentNameBindingV1[]>;
  /** SA-keyed `atl:agentType` (or the root `atl:agentKind` when only that is declared); `null` = undeclared. */
  derivedType(agent: Address): Promise<DerivedAgentType | null>;
  /** Capability claims ALREADY selected for public disclosure (spec 347 §5). */
  publicSkillClaims(agent: Address): Promise<PublicSkillClaimV1[]>;
  /** Name-node records as currently on chain (`AgentNamingClient.getRecords`). */
  nameRecords(name: string): Promise<AgentNameRecords>;
  /** `AgentNameRegistry.resolver(node)`; `null` when unset. */
  nameResolver(node: Hex): Promise<Address | null>;
  /** `AgentRegistryBase.getEntry`; `null` when the entry does not exist. */
  registryEntry(args: { registry: Address; registryId: Hex; entryId: Hex }): Promise<RegistryEntryOnChain | null>;
  erc1271: Erc1271Verifier;
  /** Where this agent's public card is served (`https://<host>/.well-known/agent-card.json`); `null` when nameless. */
  cardUri(agent: Address): Promise<string | null>;
  /** Egress for the well-known re-fetch (SSRF-safe at the wiring). */
  fetch(url: string): Promise<Response>;
  /** What `fetch` above actually is, recorded on every receipt. Omitted = a real network fetch. */
  observedVia?: 'network' | 'serving-handler';
  /** Which class of principal presented the delegation. A Service Agent is the Agent Metadata Steward. */
  principalKind(address: Address): Promise<'human' | 'service-agent'>;
}

export interface StudioEnv {
  chainId: number;
  /** The AgentNameRegistry the AP Naming projection targets by default. */
  namingRegistry: Address;
  separationOfDuties: 'strict' | 'off';
}

export interface StudioDeps {
  vault: StudioVault;
  releasedCards: StudioReleasedCards | null;
  sources: StudioSources;
  audit: AuditSink;
  env: StudioEnv;
  now?: () => string;
  newId?: () => string;
}

/** Who is calling, for which agent. `principal` is the delegation's delegate; `agent` its delegator. */
export interface StudioCaller {
  principal: Address;
  agent: Address;
}

// ─── Wire shapes ─────────────────────────────────────────────────────────────────────────────────────

/** Every mutation carries these (spec 347 §9). */
export interface StudioMutationV1 {
  idempotencyKey: string;
  expectedRevision?: number;
  reason?: string;
  correlationId: string;
}

export type JsonPatchOp = { op: 'add' | 'replace'; path: string; value: unknown } | { op: 'remove'; path: string };

/** spec 347 §8.1 — the A2A well-known publication receipt. App-level shape (no Ring-0 owner yet). */
export interface A2AWellKnownPublicationReceiptV1 {
  type: 'A2AWellKnownPublicationReceiptV1';
  receiptId: string;
  uri: string;
  releaseId: string;
  contentDigest: Sha256;
  httpEtag?: string;
  cacheControl?: string;
  verifiedAt: string;
  /** How the served bytes were observed. `serving-handler` = the serving Worker answered its own request
   *  in-process (covers host binding and released-vs-live, NOT DNS or edge routing — Cloudflare refuses a
   *  Worker subrequest to a hostname the same account serves); `network` = a real HTTPS fetch. The two are
   *  different evidence, so the receipt says which one it is. */
  observedVia?: 'network' | 'serving-handler';
  verificationResult: 'valid' | 'invalid' | 'unverified';
  /** Why `invalid` / `unverified` (served digest, HTTP status, egress error) — evidence, never a retry hint. */
  detail?: string;
}

export interface CardMetaV1 {
  v: 1;
  createdBy: Address;
  lastEditor: Address;
  lastEditedAt: string;
  releaseIds: string[];
  nextReleaseNumber: number;
  /** Release whose bytes the well-known route currently serves from the cache, if any. */
  servedReleaseId?: string;
}

export interface StoredProjectionV1 {
  instance: ProjectionInstanceV1;
  family: 'ap-naming' | 'ap-registry';
  /** The released card this projection consumes (spec 347 §3 — never a draft). */
  selectedCard?: { cardResourceId: string; releaseId: string };
  planIds: string[];
  receiptIds: string[];
}

export interface StoredPlanV1 {
  plan: PublicationPlanV1;
  /** The `{to,value,data}` calls the Home executes with the custodian; derived from the plan, never edited. */
  contractCalls: PlannedContractCallV1[];
  /** Digests the SA must sign (ERC-1271) beside the calls, when the target needs a signature. */
  signatureRequests: Array<{ purpose: string; digest: Hex }>;
  artifactRecord: string;
  approvalId?: string;
  createdBy: Address;
}

export interface StoredApprovalV1 {
  approval: ApprovalRefV1;
  subject: { kind: 'card-release' | 'projection-publication'; objectId: string; agent: CanonicalAgentId };
  approverPrincipal: Address;
}

export type StudioOp =
  | 'card.list' | 'card.create' | 'card.get' | 'card.page' | 'card.patchDraft' | 'card.import' | 'card.validate' | 'card.createRelease' | 'card.wellKnown'
  | 'release.requestApproval' | 'release.approve' | 'release.sign' | 'release.publish' | 'release.verifyPublication'
  | 'release.deprecate' | 'release.revoke'
  | 'projection.list' | 'projection.configure' | 'projection.preview' | 'projection.planPublication'
  | 'projection.requestApproval' | 'projection.approve' | 'projection.recordPublication'
  | 'binding.list' | 'binding.verify';

export const STUDIO_OPS: readonly StudioOp[] = [
  'card.list', 'card.create', 'card.get', 'card.page', 'card.patchDraft', 'card.import', 'card.validate', 'card.createRelease', 'card.wellKnown',
  'release.requestApproval', 'release.approve', 'release.sign', 'release.publish', 'release.verifyPublication',
  'release.deprecate', 'release.revoke',
  'projection.list', 'projection.configure', 'projection.preview', 'projection.planPublication',
  'projection.requestApproval', 'projection.approve', 'projection.recordPublication',
  'binding.list', 'binding.verify',
];

export function isStudioOp(s: string): s is StudioOp {
  return (STUDIO_OPS as readonly string[]).includes(s);
}

/** Which entitlement each op exercises (spec 347 §9). Publishing a projection is scoped per family at call time. */
const OP_SCOPE: Record<Exclude<StudioOp, 'projection.recordPublication'>, StudioScope | readonly StudioScope[]> = {
  'card.list': 'agent.card.read',
  'card.get': 'agent.card.read',
  // A composite read holds the scopes of EVERY part it returns — never the weakest of them.
  'card.page': ['agent.card.read', 'agent.projection.read'],
  'card.create': 'agent.card.draft',
  'card.patchDraft': 'agent.card.draft',
  'card.import': 'agent.card.import',
  'card.validate': 'agent.card.validate',
  'card.createRelease': 'agent.card.draft',
  'card.wellKnown': 'agent.card.read',
  'release.requestApproval': 'agent.card.draft',
  'release.approve': 'agent.card.approve',
  'release.sign': 'agent.card.sign',
  'release.publish': 'agent.card.publish',
  'release.verifyPublication': 'agent.card.publish',
  'release.deprecate': 'agent.card.publish',
  'release.revoke': 'agent.card.publish',
  'projection.list': 'agent.projection.read',
  'projection.configure': 'agent.projection.preview',
  'projection.preview': 'agent.projection.preview',
  'projection.planPublication': 'agent.projection.preview',
  'projection.requestApproval': 'agent.projection.preview',
  'projection.approve': 'agent.projection.approve',
  'binding.list': 'agent.projection.read',
  'binding.verify': 'agent.binding.verify',
};

export class StudioError extends Error {
  constructor(readonly status: number, readonly code: string, message?: string, readonly extra?: Record<string, unknown>) {
    super(message ?? code);
    this.name = 'StudioError';
  }
}

export interface StudioResult {
  status: number;
  body: Record<string, unknown>;
}

// ─── Record keys (vault recordTypes) ─────────────────────────────────────────────────────────────────

export const STUDIO_KEYS = {
  cardIndex: () => 'agent-cards:index',
  draft: (card: string) => `agent-cards:${card}:draft`,
  meta: (card: string) => `agent-cards:${card}:meta`,
  release: (card: string, release: string) => `agent-cards:${card}:release:${release}`,
  signingKey: (card: string, kid: string) => `agent-cards:${card}:signing-key:${kid}`,
  importEvidence: (card: string, digest: string) => `agent-cards:${card}:import:${digest.replace(/^sha256:/, '')}`,
  publication: (card: string, receiptId: string) => `agent-cards:${card}:publication:${receiptId}`,
  idempotency: (key: string) => `agent-cards:idem:${key}`,
  projectionIndex: () => 'projections:index',
  projection: (id: string) => `projections:${id}`,
  artifact: (id: string, digest: string) => `projections:${id}:artifact:${digest.replace(/^sha256:/, '')}`,
  plan: (id: string, planId: string) => `projections:${id}:plan:${planId.replace(/^urn:ap:publication-plan:/, '')}`,
  receipt: (id: string, receiptId: string) => `projections:${id}:receipt:${receiptId}`,
  bindingIndex: () => 'bindings:index',
  binding: (id: string) => `bindings:${id}`,
  approval: (id: string) => `approvals:${id}`,
} as const;

/** KV key for the released-card cache — MUST equal `releasedCardKey` in index.ts (a test pins it). */
export function studioReleasedCardKey(agent: string): string {
  return `released-card:${agent.toLowerCase()}`;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────────────────────────────

const utf8 = new TextEncoder();

function caip10(chainId: number, agent: Address): CanonicalAgentId {
  return `eip155:${chainId}:${agent}` as CanonicalAgentId;
}

function shortDigest(d: string): string {
  return d.replace(/^sha256:/, '').slice(0, 32);
}

function str(v: unknown, field: string): string {
  if (typeof v !== 'string' || v.length === 0) throw new StudioError(400, 'bad_input', `${field} must be a non-empty string`);
  return v;
}

function optStr(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function parseMutation(args: Record<string, unknown>): StudioMutationV1 {
  const m = (args.mutation ?? null) as Partial<StudioMutationV1> | null;
  if (!m || typeof m !== 'object') throw new StudioError(400, 'bad_input', 'mutation { idempotencyKey, correlationId } is required');
  const out: StudioMutationV1 = { idempotencyKey: str(m.idempotencyKey, 'mutation.idempotencyKey'), correlationId: str(m.correlationId, 'mutation.correlationId') };
  if (m.expectedRevision !== undefined) {
    if (!Number.isInteger(m.expectedRevision) || (m.expectedRevision as number) < 0) throw new StudioError(400, 'bad_input', 'mutation.expectedRevision must be a non-negative integer');
    out.expectedRevision = m.expectedRevision as number;
  }
  if (m.reason !== undefined) out.reason = String(m.reason);
  return out;
}

/** Deterministic, JSON-safe id for append-only records. */
function idFrom(...parts: unknown[]): string {
  return shortDigest(jcsDigest(parts));
}

function bytes32Hex(v: string, field: string): Hex {
  if (!/^0x[0-9a-fA-F]{64}$/.test(v)) throw new StudioError(400, 'bad_input', `${field} must be a bytes32 hex`);
  return v as Hex;
}

// ─── The Studio ──────────────────────────────────────────────────────────────────────────────────────

export class AgentCardStudio {
  private readonly now: () => string;
  private readonly newId: () => string;
  constructor(private readonly deps: StudioDeps) {
    this.now = deps.now ?? (() => new Date().toISOString());
    this.newId = deps.newId ?? (() => crypto.randomUUID());
  }

  // ── scopes ──

  /** Scopes the caller holds for this agent. Class is read on chain (one mechanism); relationship is the wire. */
  async scopesFor(caller: StudioCaller): Promise<{ scopes: StudioScope[]; kind: 'human' | 'service-agent'; relationship: 'self' | 'steward' }> {
    const relationship = caller.principal.toLowerCase() === caller.agent.toLowerCase() ? 'self' : 'steward';
    const kind = await this.deps.sources.principalKind(caller.principal);
    if (kind === 'service-agent') return { scopes: [...STEWARD_DEFAULT_SCOPES], kind, relationship };
    return { scopes: [...AGENT_CARD_SCOPES, projectionPublishScope('ap-naming'), projectionPublishScope('ap-registry')], kind, relationship };
  }

  /** Run one operation. Authorization → idempotency replay → the op → audit. Errors map to HTTP statuses. */
  async run(caller: StudioCaller, op: string, args: Record<string, unknown>): Promise<StudioResult> {
    if (!isStudioOp(op)) return { status: 404, body: { ok: false, error: 'unknown_op', detail: `no Studio op "${op}"` } };
    try {
      const auth = await this.scopesFor(caller);
      const requiredSpec = op === 'projection.recordPublication' ? projectionPublishScope(await this.familyOf(str(args.instanceId, 'instanceId'))) : OP_SCOPE[op];
      const requiredAll: readonly StudioScope[] = Array.isArray(requiredSpec) ? requiredSpec : [requiredSpec as StudioScope];
      const missing = requiredAll.filter((sc) => !auth.scopes.includes(sc));
      const required = missing[0] ?? requiredAll[0]!;
      if (missing.length > 0) {
        await this.audit(op, caller, auth.kind, 'denied', { canonicalAgentId: caip10(this.deps.env.chainId, caller.agent), objectId: String(args.cardResourceId ?? args.instanceId ?? args.bindingId ?? ''), actor: caller.principal, correlationId: String((args.mutation as { correlationId?: string } | undefined)?.correlationId ?? 'none'), privacyClass: 'never-public' }, `scope ${required} not held (${auth.kind}, ${auth.relationship})`);
        throw new StudioError(403, 'scope_not_held', `${op} requires ${required}; a ${auth.kind} ${auth.relationship} does not hold it`);
      }
      const body = await this.dispatch(caller, auth.kind, op, args);
      return { status: 200, body: { ok: true, ...body } };
    } catch (e) {
      return { status: statusOf(e), body: errorBody(e) };
    }
  }

  private async familyOf(instanceId: string): Promise<string> {
    const stored = await this.deps.vault.get<StoredProjectionV1>(STUDIO_KEYS.projection(instanceId));
    if (!stored) throw new StudioError(404, 'projection_not_found');
    return stored.family;
  }

  private async dispatch(caller: StudioCaller, kind: 'human' | 'service-agent', op: StudioOp, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    switch (op) {
      case 'card.list': return this.cardList();
      case 'card.get': return this.cardGet(str(args.cardResourceId, 'cardResourceId'));
      case 'card.page': return this.cardPage(str(args.cardResourceId, 'cardResourceId'));
      case 'card.create': return this.mutation(op, args, (m) => this.cardCreate(caller, kind, args, m));
      case 'card.patchDraft': return this.mutation(op, args, (m) => this.cardPatchDraft(caller, kind, args, m));
      case 'card.import': return this.mutation(op, args, (m) => this.cardImport(caller, kind, args, m));
      case 'card.validate': return this.cardValidate(caller, kind, args);
      case 'card.createRelease': return this.mutation(op, args, (m) => this.cardCreateRelease(caller, kind, args, m));
      case 'card.wellKnown': return this.cardWellKnown(caller);
      case 'release.requestApproval': return this.mutation(op, args, (m) => this.releaseTransition(caller, kind, args, m, 'approvalPending'));
      case 'release.approve': return this.mutation(op, args, (m) => this.releaseApprove(caller, kind, args, m));
      case 'release.sign': return this.mutation(op, args, (m) => this.releaseSign(caller, kind, args, m));
      case 'release.publish': return this.mutation(op, args, (m) => this.releasePublish(caller, kind, args, m));
      case 'release.verifyPublication': return this.releaseVerifyPublication(caller, kind, args);
      case 'release.deprecate': return this.mutation(op, args, (m) => this.releaseTransition(caller, kind, args, m, 'deprecated'));
      case 'release.revoke': return this.mutation(op, args, (m) => this.releaseRevoke(caller, kind, args, m));
      case 'projection.list': return this.projectionList();
      case 'projection.configure': return this.mutation(op, args, (m) => this.projectionConfigure(caller, kind, args, m));
      case 'projection.preview': return this.projectionPreview(caller, kind, args);
      case 'projection.planPublication': return this.mutation(op, args, (m) => this.projectionPlan(caller, kind, args, m));
      case 'projection.requestApproval': return this.mutation(op, args, (m) => this.projectionRequestApproval(caller, kind, args, m));
      case 'projection.approve': return this.mutation(op, args, (m) => this.projectionApprove(caller, kind, args, m));
      case 'projection.recordPublication': return this.mutation(op, args, (m) => this.projectionRecordPublication(caller, kind, args, m));
      case 'binding.list': return this.bindingList();
      case 'binding.verify': return this.bindingVerify(caller, kind, args);
      default: throw new StudioError(404, 'unknown_op');
    }
  }

  // ── idempotency ──

  private async mutation(op: StudioOp, args: Record<string, unknown>, fn: (m: StudioMutationV1) => Promise<Record<string, unknown>>): Promise<Record<string, unknown>> {
    const m = parseMutation(args);
    const key = STUDIO_KEYS.idempotency(m.idempotencyKey);
    const prior = await this.deps.vault.get<{ op: string; response: Record<string, unknown> }>(key);
    if (prior) {
      if (prior.op !== op) throw new StudioError(409, 'idempotency_key_reused', `idempotency key already used by ${prior.op}`);
      return { ...prior.response, replayed: true };
    }
    const response = await fn(m);
    await this.deps.vault.set(key, { op, response, at: this.now() });
    return response;
  }

  // ── append-only guard ──

  /** Write once. A re-write with the SAME identity (default: the whole content) is a no-op; a different one is refused. */
  private async appendOnly(recordType: string, data: unknown, identity: (v: unknown) => string = (v) => jcsDigest(v)): Promise<void> {
    const existing = await this.deps.vault.get(recordType);
    if (existing !== null && identity(existing) !== identity(data)) {
      throw new StudioError(409, 'append_only', `${recordType} already exists with different content`);
    }
    if (existing === null) await this.deps.vault.set(recordType, data);
  }

  // ── audit ──

  private async audit(action: StudioAuditAction | StudioOp | 'agent.projection.approved', caller: StudioCaller, kind: 'human' | 'service-agent', outcome: 'success' | 'denied' | 'error', ctx: StudioAuditContextV1, reason?: string): Promise<void> {
    const flat: Record<string, string | number | boolean | null> = {};
    for (const [k, v] of Object.entries(ctx)) flat[k] = v === undefined ? null : (v as string);
    await this.deps.audit.write(buildEvent({
      action,
      outcome,
      correlationId: ctx.correlationId,
      actor: { type: kind === 'service-agent' ? 'service' : 'user', id: caller.principal },
      subject: { type: action.startsWith('agent.projection') ? 'projection' : action.startsWith('agent.binding') ? 'external-binding' : 'agent-card', id: ctx.objectId },
      chainId: this.deps.env.chainId,
      ...(ctx.txRef && /^0x[0-9a-fA-F]+$/.test(ctx.txRef) ? { digest: ctx.txRef as Hex } : {}),
      ...(reason ? { reason } : {}),
      context: flat,
    }));
  }

  private ctx(caller: StudioCaller, objectId: string, correlationId: string, extra: Partial<StudioAuditContextV1> = {}): StudioAuditContextV1 {
    return { canonicalAgentId: caip10(this.deps.env.chainId, caller.agent), objectId, actor: caller.principal, correlationId, privacyClass: 'audience', ...extra };
  }

  // ── inherited base (spec 347 §4.3) ──

  private async inheritedBase(agent: Address, now: string): Promise<ReturnType<typeof inheritCardBase> & { live: Record<string, unknown>; primaryName?: string }> {
    const [live, prof, names, claims] = await Promise.all([
      this.deps.sources.liveCard(agent),
      this.deps.sources.profile(agent),
      this.deps.sources.names(agent),
      this.deps.sources.publicSkillClaims(agent),
    ]);
    const primary = names.find((n) => n.role === 'primary') ?? names[0];
    const profile = prof?.profile ?? synthesizedProfile(primary?.name, live);
    const interfaces = Array.isArray(live.supportedInterfaces) ? (live.supportedInterfaces as A2AAgentInterfaceV1[]) : [];
    const a2aUrl = interfaces[0]?.url;
    if (!a2aUrl) throw new StudioError(409, 'live_card_has_no_interface', 'the live card advertises no A2A interface; cannot inherit');
    const caps = (live.capabilities ?? {}) as Record<string, unknown>;
    const provider = live.provider as { organization: string; url: string } | undefined;
    const skills = Array.isArray(live.skills) ? (live.skills as Array<{ id: string; name: string; description?: string }>) : [];
    const base = inheritCardBase({
      profile,
      ...(primary ? { names: { primary: primary.name, all: names.map((n) => n.name) } } : {}),
      surfaceCards: { public: skills.map((s) => ({ id: s.id, name: s.name, ...(s.description ? { description: s.description } : {}) })) },
      surfaceInterfaces: interfaces.map((i) => ({ url: i.url, protocolBinding: i.protocolBinding, ...(i.protocolVersion ? { protocolVersion: i.protocolVersion } : {}), ...(i.tenant ? { tenant: i.tenant } : {}) })),
      runtimeCapabilities: {
        streaming: caps.streaming === true,
        pushNotifications: caps.pushNotifications === true,
        stateTransitionHistory: caps.stateTransitionHistory === true,
        ...(Array.isArray(caps.extensions) ? { extensions: caps.extensions as A2AAgentExtensionV1[] } : {}),
      },
      publicSkillCandidates: claims.map((c) => ({ id: c.skillId, name: c.name, description: c.description ?? c.name, tags: c.tags })),
      deployment: {
        host: originOf(a2aUrl) ?? undefined,
        a2aUrl,
        protocolBinding: interfaces[0]?.protocolBinding,
        ...(provider ? { provider } : {}),
        ...(typeof live.documentationUrl === 'string' ? { documentationUrl: live.documentationUrl } : {}),
      },
      agentVersion: typeof live.version === 'string' ? live.version : undefined,
      protocolVersion: typeof live.protocolVersion === 'string' ? live.protocolVersion : '1.0',
      mediaModes: {
        ...(Array.isArray(live.defaultInputModes) ? { input: live.defaultInputModes as string[] } : {}),
        ...(Array.isArray(live.defaultOutputModes) ? { output: live.defaultOutputModes as string[] } : {}),
      },
      now,
    });
    return { ...base, live, ...(primary ? { primaryName: primary.name } : {}) };
  }

  private validationOptions(resource: A2AAgentCardResourceV1, draft: Pick<A2AAgentCardDraftV1, 'fieldBindings' | 'extendedCardPolicies'>, live: Record<string, unknown>) {
    const interfaces = Array.isArray(live.supportedInterfaces) ? (live.supportedInterfaces as A2AAgentInterfaceV1[]) : [];
    const caps = (live.capabilities ?? {}) as Record<string, unknown>;
    const skills = Array.isArray(live.skills) ? (live.skills as Array<{ id: string; name?: string; description?: string }>) : [];
    return {
      environment: resource.environment,
      surfaceInterfaces: interfaces.map((i) => ({ url: i.url, protocolBinding: i.protocolBinding })),
      runtimeCapabilities: { streaming: caps.streaming === true, pushNotifications: caps.pushNotifications === true, stateTransitionHistory: caps.stateTransitionHistory === true },
      catalogSkills: skills.map((s) => ({ id: s.id, ...(s.name ? { name: s.name } : {}), ...(s.description ? { description: s.description } : {}) })),
      fieldBindings: draft.fieldBindings,
      extendedCardPolicyConfigured: draft.extendedCardPolicies.length > 0,
    };
  }

  // ── cards ──

  /** Typed batch read in key order; `null` for anything the vault does not hold. */
  private async getMany<T>(keys: readonly string[]): Promise<Array<T | null>> {
    if (keys.length === 0) return [];
    const got = await this.deps.vault.getMany(keys);
    return keys.map((k) => (got[k] ?? null) as T | null);
  }

  private async loadIndex(): Promise<A2AAgentCardResourceV1[]> {
    const idx = await this.deps.vault.get<{ v: 1; resources: A2AAgentCardResourceV1[] }>(STUDIO_KEYS.cardIndex());
    return idx?.resources ?? [];
  }

  private async saveIndex(resources: A2AAgentCardResourceV1[]): Promise<void> {
    await this.deps.vault.set(STUDIO_KEYS.cardIndex(), { v: 1, resources });
  }

  private async loadResource(cardResourceId: string): Promise<{ resources: A2AAgentCardResourceV1[]; resource: A2AAgentCardResourceV1; meta: CardMetaV1 }> {
    const resources = await this.loadIndex();
    const resource = resources.find((r) => r.cardResourceId === cardResourceId);
    if (!resource) throw new StudioError(404, 'card_not_found');
    const meta = await this.deps.vault.get<CardMetaV1>(STUDIO_KEYS.meta(cardResourceId));
    if (!meta) throw new StudioError(500, 'card_meta_missing', `agent-cards:${cardResourceId}:meta is missing`);
    return { resources, resource, meta };
  }

  private async loadRelease(cardResourceId: string, releaseId: string): Promise<A2AAgentCardReleaseV1> {
    const r = await this.deps.vault.get<A2AAgentCardReleaseV1>(STUDIO_KEYS.release(cardResourceId, releaseId));
    if (!r) throw new StudioError(404, 'release_not_found');
    return r;
  }

  private async saveRelease(release: A2AAgentCardReleaseV1): Promise<void> {
    // Append-only in CONTENT: the released card bytes and digest never change; only lifecycle fields advance.
    const key = STUDIO_KEYS.release(release.cardResourceId, release.releaseId);
    const existing = await this.deps.vault.get<A2AAgentCardReleaseV1>(key);
    if (existing && (existing.unsignedContentDigest !== release.unsignedContentDigest || existing.releaseNumber !== release.releaseNumber)) {
      throw new StudioError(409, 'append_only', 'a release\'s content digest is immutable');
    }
    await this.deps.vault.set(key, release);
  }

  private async touchResource(resources: A2AAgentCardResourceV1[], resource: A2AAgentCardResourceV1, patch: Partial<A2AAgentCardResourceV1>): Promise<A2AAgentCardResourceV1> {
    const next = { ...resource, ...patch, updatedAt: this.now() };
    await this.saveIndex(resources.map((r) => (r.cardResourceId === resource.cardResourceId ? next : r)));
    return next;
  }

  private async cardList(): Promise<Record<string, unknown>> {
    const resources = await this.loadIndex();
    // ONE batch for every card's draft + meta + latest release (was 3 hops PER card, serially fanned out).
    const keys = resources.flatMap((r) => [
      STUDIO_KEYS.draft(r.cardResourceId),
      STUDIO_KEYS.meta(r.cardResourceId),
      ...(r.latestReleaseId ? [STUDIO_KEYS.release(r.cardResourceId, r.latestReleaseId)] : []),
    ]);
    const got = await this.deps.vault.getMany(keys);
    const cards = resources.map((resource) => {
      const draft = (got[STUDIO_KEYS.draft(resource.cardResourceId)] ?? null) as A2AAgentCardDraftV1 | null;
      const meta = (got[STUDIO_KEYS.meta(resource.cardResourceId)] ?? null) as CardMetaV1 | null;
      const latest = resource.latestReleaseId
        ? ((got[STUDIO_KEYS.release(resource.cardResourceId, resource.latestReleaseId)] ?? null) as A2AAgentCardReleaseV1 | null)
        : null;
      return {
        resource,
        draftState: draft?.state ?? null,
        draftRevision: draft?.revision ?? null,
        latestRelease: latest ? { releaseId: latest.releaseId, state: latest.state, releaseNumber: latest.releaseNumber, unsignedContentDigest: latest.unsignedContentDigest, signedContentDigest: latest.signedContentDigest ?? null } : null,
        servedReleaseId: meta?.servedReleaseId ?? null,
      };
    });
    return { cards };
  }

  private async cardGet(cardResourceId: string): Promise<Record<string, unknown>> {
    // Both keys are known before the first read, so the index and the meta ride in ONE batch.
    const [idx, metaRaw] = await this.getMany<{ v: 1; resources: A2AAgentCardResourceV1[] } | CardMetaV1>([
      STUDIO_KEYS.cardIndex(),
      STUDIO_KEYS.meta(cardResourceId),
    ]);
    const resource = ((idx as { resources?: A2AAgentCardResourceV1[] } | null)?.resources ?? []).find((r) => r.cardResourceId === cardResourceId);
    if (!resource) throw new StudioError(404, 'card_not_found');
    const meta = metaRaw as CardMetaV1 | null;
    if (!meta) throw new StudioError(500, 'card_meta_missing', `agent-cards:${cardResourceId}:meta is missing`);
    // ONE batch for the draft AND every release: this page's slowest read was N+2 sequential vault hops.
    const [draft, ...rest] = await this.getMany<A2AAgentCardDraftV1 | A2AAgentCardReleaseV1>([
      STUDIO_KEYS.draft(cardResourceId),
      ...meta.releaseIds.map((id) => STUDIO_KEYS.release(cardResourceId, id)),
    ]);
    const releases = rest.filter((r): r is A2AAgentCardReleaseV1 => !!r);
    return { resource, draft: (draft as A2AAgentCardDraftV1 | null) ?? null, releases, meta };
  }

  /** Everything ONE card screen shows, in TWO vault hops.
   *
   *  The screen used to be three ops — card.get + projection.list + binding.list — and each op is its own
   *  request, its own delegation mint (a KMS signature) and its own pair of vault hops. That is three
   *  authorizations for one screen, and the page waited on the slowest of them.
   *
   *  Every key here is knowable in two rounds: the three indexes and the card's meta are known before the
   *  first read; everything else is named by what those return. So this is not a special case bolted on —
   *  it is the same reads, ordered by what they depend on.
   *
   *  It is NOT a weaker door: `card.page` requires the scopes of all three parts (OP_SCOPE above), and
   *  demo-mcp still gates every record against the delegation. A caller holding only one of the scopes is
   *  refused here and must ask for the part it may have. */
  private async cardPage(cardResourceId: string): Promise<Record<string, unknown>> {
    const [idx, metaRaw, projIdx, bindIdx] = await this.getMany<unknown>([
      STUDIO_KEYS.cardIndex(),
      STUDIO_KEYS.meta(cardResourceId),
      STUDIO_KEYS.projectionIndex(),
      STUDIO_KEYS.bindingIndex(),
    ]);
    const resource = ((idx as { resources?: A2AAgentCardResourceV1[] } | null)?.resources ?? []).find((r) => r.cardResourceId === cardResourceId);
    if (!resource) throw new StudioError(404, 'card_not_found');
    const meta = metaRaw as CardMetaV1 | null;
    if (!meta) throw new StudioError(500, 'card_meta_missing', `agent-cards:${cardResourceId}:meta is missing`);
    const instanceIds = (projIdx as { instanceIds?: string[] } | null)?.instanceIds ?? [];
    const bindingIds = (bindIdx as { bindingIds?: string[] } | null)?.bindingIds ?? [];

    const releaseKeys = meta.releaseIds.map((id) => STUDIO_KEYS.release(cardResourceId, id));
    const projectionKeys = instanceIds.map((id) => STUDIO_KEYS.projection(id));
    const bindingKeys = bindingIds.map((id) => STUDIO_KEYS.binding(id));
    const got = await this.deps.vault.getMany([STUDIO_KEYS.draft(cardResourceId), ...releaseKeys, ...projectionKeys, ...bindingKeys]);

    const releases = releaseKeys.map((k) => got[k]).filter((r): r is A2AAgentCardReleaseV1 => !!r);
    const projections = projectionKeys.map((k) => got[k]).filter((p): p is StoredProjectionV1 => !!p);
    const bindings = bindingKeys.map((k) => got[k]).filter((b): b is ExternalIdentityBindingV1 => !!b);
    return {
      resource,
      draft: (got[STUDIO_KEYS.draft(cardResourceId)] ?? null) as A2AAgentCardDraftV1 | null,
      releases,
      meta,
      projections: projections.map((p) => ({ instance: p.instance, family: p.family, selectedCard: p.selectedCard ?? null, planIds: p.planIds, receiptIds: p.receiptIds })),
      bindings,
    };
  }

  private async cardCreate(caller: StudioCaller, kind: 'human' | 'service-agent', args: Record<string, unknown>, m: StudioMutationV1): Promise<Record<string, unknown>> {
    const environment = (optStr(args.environment) ?? 'production') as CardEnvironment;
    if (!['production', 'staging', 'development'].includes(environment)) throw new StudioError(400, 'bad_input', 'environment must be production|staging|development');
    const now = this.now();
    const resources = await this.loadIndex();
    const primary = args.primary === undefined ? !resources.some((r) => r.primary && r.environment === 'production') : args.primary === true;
    if (primary && environment === 'production' && resources.some((r) => r.primary && r.environment === 'production')) {
      throw new StudioError(409, 'primary_exists', 'one production deployment designates ONE primary public card (spec 347 §3)');
    }
    const cardResourceId = optStr(args.cardResourceId) ?? `card-${idFrom(caller.agent, m.idempotencyKey, now).slice(0, 16)}`;
    if (resources.some((r) => r.cardResourceId === cardResourceId)) throw new StudioError(409, 'card_exists');
    const base = await this.inheritedBase(caller.agent, now);
    const draft = draftFromBase(base, { cardResourceId, now });
    const resource: A2AAgentCardResourceV1 = {
      cardResourceId,
      canonicalAgentId: caip10(this.deps.env.chainId, caller.agent),
      ...(optStr(args.displayName) ? { displayName: optStr(args.displayName) } : {}),
      environment,
      primary,
      currentDraftRevision: draft.revision,
      createdAt: now,
      updatedAt: now,
    };
    const meta: CardMetaV1 = { v: 1, createdBy: caller.principal, lastEditor: caller.principal, lastEditedAt: now, releaseIds: [], nextReleaseNumber: 1 };
    await this.deps.vault.set(STUDIO_KEYS.draft(cardResourceId), draft);
    await this.deps.vault.set(STUDIO_KEYS.meta(cardResourceId), meta);
    await this.saveIndex([...resources, resource]);
    await this.audit('agent.card.created', caller, kind, 'success', this.ctx(caller, cardResourceId, m.correlationId, { resultDigest: base.snapshotDigest }));
    return { resource, draft, inheritedFrom: { primaryName: base.primaryName ?? null, snapshotDigest: base.snapshotDigest } };
  }

  private async loadDraft(cardResourceId: string, expectedRevision: number | undefined): Promise<A2AAgentCardDraftV1> {
    const draft = await this.deps.vault.get<A2AAgentCardDraftV1>(STUDIO_KEYS.draft(cardResourceId));
    if (!draft) throw new StudioError(404, 'draft_not_found');
    if (expectedRevision !== undefined && expectedRevision !== draft.revision) {
      throw new StudioError(409, 'stale_revision', `expected revision ${expectedRevision}, draft is at ${draft.revision}`, { currentRevision: draft.revision, etag: draft.etag });
    }
    return draft;
  }

  private async saveDraft(caller: StudioCaller, resources: A2AAgentCardResourceV1[], resource: A2AAgentCardResourceV1, meta: CardMetaV1, draft: A2AAgentCardDraftV1): Promise<void> {
    await this.deps.vault.set(STUDIO_KEYS.draft(draft.cardResourceId), draft);
    await this.deps.vault.set(STUDIO_KEYS.meta(draft.cardResourceId), { ...meta, lastEditor: caller.principal, lastEditedAt: draft.updatedAt });
    await this.touchResource(resources, resource, { currentDraftRevision: draft.revision });
  }

  private async cardPatchDraft(caller: StudioCaller, kind: 'human' | 'service-agent', args: Record<string, unknown>, m: StudioMutationV1): Promise<Record<string, unknown>> {
    const cardResourceId = str(args.cardResourceId, 'cardResourceId');
    if (m.expectedRevision === undefined) throw new StudioError(400, 'bad_input', 'card.patchDraft requires mutation.expectedRevision');
    const ops = args.patch;
    if (!Array.isArray(ops) || ops.length === 0) throw new StudioError(400, 'bad_input', 'patch must be a non-empty JSON Patch array');
    const { resources, resource, meta } = await this.loadResource(cardResourceId);
    const draft = await this.loadDraft(cardResourceId, m.expectedRevision);
    if (optStr(args.ifMatch) && optStr(args.ifMatch) !== draft.etag) throw new StudioError(409, 'stale_etag', 'ifMatch does not match the draft etag', { etag: draft.etag });
    const now = this.now();
    let next = draft;
    for (const raw of ops as JsonPatchOp[]) {
      if (!raw || typeof raw.path !== 'string' || !raw.path.startsWith('/')) throw new StudioError(400, 'bad_input', 'each patch op needs an absolute JSON pointer path');
      if (raw.path === '/signatures' || raw.path.startsWith('/signatures/')) throw new StudioError(400, 'bad_input', 'signatures are never edited; they are attached at release.sign');
      if (raw.op === 'remove') next = applyOverride(next, raw.path, undefined, { now, source: { kind: 'user', ref: caller.principal } });
      else if (raw.op === 'add' || raw.op === 'replace') next = applyOverride(next, raw.path, (raw as { value: unknown }).value, { now, source: { kind: 'user', ref: caller.principal } });
      else throw new StudioError(400, 'bad_input', `unsupported patch op ${String((raw as { op: unknown }).op)} (add|replace|remove)`);
    }
    // One mutation = one revision, however many ops it carried.
    next = { ...next, revision: draft.revision + 1 };
    next = { ...next, etag: draftEtag(next) };
    await this.saveDraft(caller, resources, resource, meta, next);
    await this.audit('agent.card.draft.updated', caller, kind, 'success', this.ctx(caller, cardResourceId, m.correlationId, { inputDigest: jcsDigest(ops), resultDigest: cardContentDigest(next.card) }));
    return { draft: next };
  }

  private async cardImport(caller: StudioCaller, kind: 'human' | 'service-agent', args: Record<string, unknown>, m: StudioMutationV1): Promise<Record<string, unknown>> {
    const cardResourceId = str(args.cardResourceId, 'cardResourceId');
    const source = str(args.source, 'source');
    const { resources, resource, meta } = await this.loadResource(cardResourceId);
    const draft = await this.loadDraft(cardResourceId, m.expectedRevision);
    const now = this.now();
    const result = await importA2ACard(source, { ...(optStr(args.uri) ? { uri: optStr(args.uri) } : {}), retrievedAt: now, validation: { environment: resource.environment } });
    // Evidence first (append-only): the exact bytes + digest + what the import found.
    let bin = '';
    for (const b of result.imported.sourceBytes) bin += String.fromCharCode(b);
    await this.appendOnly(STUDIO_KEYS.importEvidence(cardResourceId, result.imported.sourceDigest), {
      sourceDigest: result.imported.sourceDigest,
      sourceBase64: btoa(bin),
      uri: result.imported.uri ?? null,
      retrievedAt: now,
      unknownFields: result.imported.unknownFields,
      diagnostics: result.diagnostics,
      signatureVerification: result.signatureVerification ?? null,
      importedBy: caller.principal,
    });
    // The import becomes the draft as a PROPOSAL: every top-level field is a `manual` binding from `import`.
    const bindings: Record<string, FieldBindingV1> = {};
    const { signatures: _drop, ...unsigned } = result.imported.card;
    for (const key of Object.keys(unsigned)) {
      const pointer = `/${key}`;
      bindings[pointer] = { pointer, mode: 'manual', source: { kind: 'import', ...(result.imported.uri ? { ref: result.imported.uri } : {}) }, evidence: [{ kind: 'fetched-document', ref: STUDIO_KEYS.importEvidence(cardResourceId, result.imported.sourceDigest), digest: result.imported.sourceDigest, observedAt: now }], state: 'fresh', updatedAt: now };
    }
    let next: A2AAgentCardDraftV1 = { ...draft, revision: draft.revision + 1, state: 'draft', card: unsigned as A2AAgentCardV1, fieldBindings: bindings, updatedAt: now };
    next = { ...next, etag: draftEtag(next) };
    await this.saveDraft(caller, resources, resource, meta, next);
    await this.audit('agent.card.imported', caller, kind, 'success', this.ctx(caller, cardResourceId, m.correlationId, { inputDigest: result.imported.sourceDigest, resultDigest: cardContentDigest(next.card) }));
    return { draft: next, diagnostics: result.diagnostics, unknownFields: result.imported.unknownFields, signatureVerification: result.signatureVerification ?? null, sourceDigest: result.imported.sourceDigest };
  }

  private async cardValidate(caller: StudioCaller, kind: 'human' | 'service-agent', args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const cardResourceId = str(args.cardResourceId, 'cardResourceId');
    const correlationId = optStr(args.correlationId) ?? this.newId();
    const { resource } = await this.loadResource(cardResourceId);
    const draft = await this.loadDraft(cardResourceId, undefined);
    const live = await this.deps.sources.liveCard(caller.agent);
    const diagnostics = validateA2ACard(draft.card, this.validationOptions(resource, draft, live));
    const errors = diagnostics.filter((d) => d.severity === 'error').length;
    const state = errors === 0 ? 'validated' : 'draft';
    // Validation moves the draft's STATE only — revision and etag (content) are untouched.
    if (draft.state !== state && draft.state !== 'stale') {
      await this.deps.vault.set(STUDIO_KEYS.draft(cardResourceId), { ...draft, state } satisfies A2AAgentCardDraftV1);
    }
    await this.audit('agent.card.validation.completed', caller, kind, 'success', this.ctx(caller, cardResourceId, correlationId, { inputDigest: cardContentDigest(draft.card), resultDigest: jcsDigest(diagnostics) }));
    return { diagnostics, errors, state, revision: draft.revision };
  }

  private async cardCreateRelease(caller: StudioCaller, kind: 'human' | 'service-agent', args: Record<string, unknown>, m: StudioMutationV1): Promise<Record<string, unknown>> {
    const cardResourceId = str(args.cardResourceId, 'cardResourceId');
    const { resources, resource, meta } = await this.loadResource(cardResourceId);
    const draft = await this.loadDraft(cardResourceId, m.expectedRevision);
    const live = await this.deps.sources.liveCard(caller.agent);
    const now = this.now();
    const releaseNumber = meta.nextReleaseNumber;
    const supersedes = resource.latestReleaseId;
    const release = createRelease(draft, { releaseNumber, agentVersion: draft.card.version, now, validation: this.validationOptions(resource, draft, live), ...(supersedes ? { supersedes } : {}) });
    await this.appendOnly(STUDIO_KEYS.release(cardResourceId, release.releaseId), release);
    // Editing after a release = a new draft based on it (spec 347 §3).
    const nextDraft = forkDraft(release, { now, revision: draft.revision + 1 });
    await this.deps.vault.set(STUDIO_KEYS.draft(cardResourceId), nextDraft);
    await this.deps.vault.set(STUDIO_KEYS.meta(cardResourceId), { ...meta, releaseIds: [...meta.releaseIds, release.releaseId], nextReleaseNumber: releaseNumber + 1 });
    await this.touchResource(resources, resource, { latestReleaseId: release.releaseId, currentDraftRevision: nextDraft.revision });
    await this.audit('agent.card.release.created', caller, kind, 'success', this.ctx(caller, release.releaseId, m.correlationId, { inputDigest: draft.etag, resultDigest: release.unsignedContentDigest }));
    return { release, draft: nextDraft };
  }

  private async releaseTransition(caller: StudioCaller, kind: 'human' | 'service-agent', args: Record<string, unknown>, m: StudioMutationV1, to: 'approvalPending' | 'deprecated'): Promise<Record<string, unknown>> {
    const cardResourceId = str(args.cardResourceId, 'cardResourceId');
    const releaseId = str(args.releaseId, 'releaseId');
    const { meta } = await this.loadResource(cardResourceId);
    const release = await this.loadRelease(cardResourceId, releaseId);
    const now = this.now();
    const next = transition(release, to, { now, ...(m.reason ? { reason: m.reason } : {}) });
    await this.saveRelease(next);
    if (to === 'deprecated') await this.stopServing(cardResourceId, meta, releaseId, caller.agent);
    await this.audit(to === 'approvalPending' ? 'agent.card.approval.requested' : 'agent.card.deprecated', caller, kind, 'success', this.ctx(caller, releaseId, m.correlationId, { inputDigest: release.unsignedContentDigest }), m.reason);
    return { release: next };
  }

  private async releaseApprove(caller: StudioCaller, kind: 'human' | 'service-agent', args: Record<string, unknown>, m: StudioMutationV1): Promise<Record<string, unknown>> {
    const cardResourceId = str(args.cardResourceId, 'cardResourceId');
    const releaseId = str(args.releaseId, 'releaseId');
    const { meta } = await this.loadResource(cardResourceId);
    const release = await this.loadRelease(cardResourceId, releaseId);
    if (this.deps.env.separationOfDuties === 'strict' && meta.lastEditor.toLowerCase() === caller.principal.toLowerCase()) {
      await this.audit('agent.card.release.approved', caller, kind, 'denied', this.ctx(caller, releaseId, m.correlationId, { inputDigest: release.unsignedContentDigest }), 'separation of duties: approver is the last editor');
      throw new StudioError(403, 'separation_of_duties', 'SEPARATION_OF_DUTIES=strict: the approver must not be the draft\'s last editor');
    }
    const now = this.now();
    const approval: ApprovalRefV1 = {
      approvalId: `urn:ap:approval:${idFrom(caller.agent, releaseId, m.idempotencyKey)}`,
      approvedDigest: release.unsignedContentDigest,
      approver: caip10(this.deps.env.chainId, caller.principal),
      approvedAt: now,
      ...(optStr(args.expiresAt) ? { expiresAt: optStr(args.expiresAt) } : {}),
      idempotencyKey: m.idempotencyKey,
      ...(m.reason ? { conditions: [m.reason] } : {}),
    };
    const next = transition(release, 'approved', { now, approval });
    await this.appendOnly(STUDIO_KEYS.approval(approval.approvalId), { approval, subject: { kind: 'card-release', objectId: releaseId, agent: caip10(this.deps.env.chainId, caller.agent) }, approverPrincipal: caller.principal } satisfies StoredApprovalV1);
    await this.saveRelease(next);
    await this.audit('agent.card.release.approved', caller, kind, 'success', this.ctx(caller, releaseId, m.correlationId, { inputDigest: release.unsignedContentDigest, actingAuthorityRef: approval.approvalId }));
    return { release: next, approval };
  }

  /**
   * Attach a CLIENT-produced ES256 JWS (+ optional EIP-712 Smart Agent binding). The server verifies both and
   * never holds a signing key: `signerJwk` must thumbprint to the protected header's `kid`, the JWS must verify
   * over the release's canonical bytes, and the binding must ERC-1271-verify against this SA for this release.
   */
  private async releaseSign(caller: StudioCaller, kind: 'human' | 'service-agent', args: Record<string, unknown>, m: StudioMutationV1): Promise<Record<string, unknown>> {
    const cardResourceId = str(args.cardResourceId, 'cardResourceId');
    const releaseId = str(args.releaseId, 'releaseId');
    const signedCard = args.signedCard as A2AAgentCardV1 | undefined;
    const signature = args.signature as A2AAgentCardSignatureV1 | undefined;
    const signerJwk = args.signerJwk as JsonWebKey | undefined;
    if (!signedCard || typeof signedCard !== 'object' || !signature || typeof signature.protected !== 'string' || typeof signature.signature !== 'string' || !signerJwk || typeof signerJwk !== 'object') {
      throw new StudioError(400, 'bad_input', 'release.sign requires { signedCard, signature, signerJwk }');
    }
    await this.loadResource(cardResourceId);
    const release = await this.loadRelease(cardResourceId, releaseId);
    // The signed card may carry exactly the signatures already attached to this release plus the new one —
    // a client cannot smuggle an unverified entry into the bytes the well-known route will serve.
    const expectedSignatures = [...(release.signedCard?.signatures ?? []), signature];
    if (jcsDigest(signedCard.signatures ?? []) !== jcsDigest(expectedSignatures)) {
      throw new StudioError(422, 'signature_invalid', 'signedCard.signatures must be the release\'s existing signatures plus the one being attached');
    }
    const kid = await jwkThumbprint(signerJwk);
    const verification = await verifyA2ACardSignatures({ ...signedCard, signatures: [signature] }, { keys: (k) => (k === kid ? signerJwk : undefined) });
    if (!verification.ok) {
      await this.audit('agent.card.signed', caller, kind, 'denied', this.ctx(caller, releaseId, m.correlationId, { inputDigest: release.unsignedContentDigest }), `JWS verification failed: ${verification.failures.map((f) => f.reason).join(',')}`);
      throw new StudioError(422, 'signature_invalid', 'the JWS does not verify over this release with the supplied key', { failures: verification.failures });
    }
    const now = this.now();
    let next = attachSignature(release, { signedCard, signature, signedAt: now });
    const binding = args.smartAgentBinding as SignedSmartAgentCardBindingV1 | undefined;
    let bindingResult: unknown = null;
    if (binding) {
      const r = await verifySmartAgentCardBinding(binding, { erc1271Verifier: this.deps.sources.erc1271, now: Math.floor(Date.parse(now) / 1000), expect: { unsignedCardDigest: next.unsignedContentDigest, signedCardDigest: next.signedContentDigest } });
      if (!r.ok) {
        await this.audit('agent.card.binding.created', caller, kind, 'denied', this.ctx(caller, releaseId, m.correlationId), `binding verification failed: ${r.reason}`);
        throw new StudioError(422, 'binding_invalid', `SmartAgentCardBinding failed verification: ${r.reason}`);
      }
      if (binding.verifyingContract.toLowerCase() !== caller.agent.toLowerCase()) throw new StudioError(422, 'binding_invalid', 'binding names a different Smart Agent');
      next = attachSmartAgentBinding(next, binding);
      bindingResult = { ok: true, digest: r.digest };
    }
    await this.deps.vault.set(STUDIO_KEYS.signingKey(cardResourceId, kid), { kid, jwk: signerJwk, firstUsedAt: now, releaseId });
    await this.saveRelease(next);
    await this.audit('agent.card.signed', caller, kind, 'success', this.ctx(caller, releaseId, m.correlationId, { inputDigest: release.unsignedContentDigest, resultDigest: next.signedContentDigest, actingAuthorityRef: kid }));
    if (binding) await this.audit('agent.card.binding.created', caller, kind, 'success', this.ctx(caller, releaseId, m.correlationId, { resultDigest: next.signedContentDigest }));
    return { release: next, kid, binding: bindingResult };
  }

  /** The exact bytes the well-known route serves: JCS of the signed card, so `sha256(bytes) === signedContentDigest`. */
  private servedBytes(release: A2AAgentCardReleaseV1): { bytes: string; digest: Sha256 } {
    if (!release.signedCard || !release.signedContentDigest) throw new StudioError(409, 'release_not_signed');
    const bytes = jcsCanonicalize(release.signedCard);
    const digest = sha256Digest(utf8.encode(bytes));
    if (digest !== release.signedContentDigest) throw new StudioError(500, 'digest_mismatch', 'served bytes do not hash to the release digest');
    return { bytes, digest };
  }

  private async releasePublish(caller: StudioCaller, kind: 'human' | 'service-agent', args: Record<string, unknown>, m: StudioMutationV1): Promise<Record<string, unknown>> {
    const cardResourceId = str(args.cardResourceId, 'cardResourceId');
    const releaseId = str(args.releaseId, 'releaseId');
    const { resources, resource, meta } = await this.loadResource(cardResourceId);
    const release = await this.loadRelease(cardResourceId, releaseId);
    if (release.state !== 'signed' && release.state !== 'published') throw new StudioError(409, 'release_not_signed', `release is ${release.state}; publish needs signed`);
    if (!this.deps.releasedCards) throw new StudioError(503, 'released_cards_unbound', 'RELEASED_CARDS KV is not bound on this deployment');
    const uri = await this.deps.sources.cardUri(caller.agent);
    if (!uri) throw new StudioError(409, 'agent_has_no_host', 'the agent has no name, so no well-known host to publish at');
    const { bytes, digest } = this.servedBytes(release);
    await this.deps.releasedCards.put(studioReleasedCardKey(caller.agent), JSON.stringify({ digest, releaseId, bytes }));
    const receipt = await this.verifyWellKnown(uri, releaseId, digest);
    await this.appendOnly(STUDIO_KEYS.publication(cardResourceId, receipt.receiptId), receipt);
    let next = release;
    if (receipt.verificationResult === 'valid') {
      next = release.state === 'published' ? release : transition(release, 'published', { now: receipt.verifiedAt, publication: { uri } });
      await this.saveRelease(next);
      // The previously published release of this resource is superseded — never erased.
      for (const id of meta.releaseIds) {
        if (id === releaseId) continue;
        const other = await this.deps.vault.get<A2AAgentCardReleaseV1>(STUDIO_KEYS.release(cardResourceId, id));
        if (other?.state === 'published') await this.saveRelease(transition(other, 'superseded', { now: receipt.verifiedAt, successor: releaseId }));
      }
      await this.deps.vault.set(STUDIO_KEYS.meta(cardResourceId), { ...meta, servedReleaseId: releaseId });
      await this.touchResource(resources, resource, {});
      await this.audit('agent.card.published', caller, kind, 'success', this.ctx(caller, releaseId, m.correlationId, { resultDigest: digest, target: uri, receiptRef: receipt.receiptId, privacyClass: 'public' }));
    } else {
      // The cache holds the bytes; the RECORD says the world has not confirmed it. Re-run release.verifyPublication.
      await this.deps.vault.set(STUDIO_KEYS.meta(cardResourceId), { ...meta, servedReleaseId: releaseId });
      await this.audit('agent.card.published', caller, kind, 'error', this.ctx(caller, releaseId, m.correlationId, { resultDigest: digest, target: uri, receiptRef: receipt.receiptId, privacyClass: 'public' }), `well-known verification ${receipt.verificationResult}: ${receipt.detail ?? ''}`);
    }
    return { release: next, receipt };
  }

  private async releaseVerifyPublication(caller: StudioCaller, kind: 'human' | 'service-agent', args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const cardResourceId = str(args.cardResourceId, 'cardResourceId');
    const releaseId = str(args.releaseId, 'releaseId');
    const correlationId = optStr(args.correlationId) ?? this.newId();
    await this.loadResource(cardResourceId);
    const release = await this.loadRelease(cardResourceId, releaseId);
    if (!release.signedContentDigest) throw new StudioError(409, 'release_not_signed');
    const uri = release.publication?.uri ?? (await this.deps.sources.cardUri(caller.agent));
    if (!uri) throw new StudioError(409, 'agent_has_no_host');
    const receipt = await this.verifyWellKnown(uri, releaseId, release.signedContentDigest);
    await this.appendOnly(STUDIO_KEYS.publication(cardResourceId, receipt.receiptId), receipt);
    let next = release;
    if (receipt.verificationResult === 'valid' && release.state === 'signed') {
      next = transition(release, 'published', { now: receipt.verifiedAt, publication: { uri } });
      await this.saveRelease(next);
      await this.audit('agent.card.published', caller, kind, 'success', this.ctx(caller, releaseId, correlationId, { resultDigest: release.signedContentDigest, target: uri, receiptRef: receipt.receiptId, privacyClass: 'public' }));
    }
    return { release: next, receipt };
  }

  /**
   * READ what the agent's public well-known URL is ACTUALLY serving right now — the operational endpoint,
   * not the draft. The Home shows the real document beside "Effective JSON" (which is the draft, and is what
   * WOULD be signed), so the difference between "what I am editing", "what I released" and "what the world
   * fetches" is visible rather than assumed.
   *
   * Read-only on purpose: it writes no receipt and moves no release. PROVING a publication is
   * `release.verifyPublication`'s job — that one records an `A2AWellKnownPublicationReceiptV1`. Egress goes
   * through the same SSRF-pinned `sources.fetch`, and an unreachable endpoint is reported as unreachable,
   * never as "no card" (ADR-0013).
   */
  private async cardWellKnown(caller: StudioCaller): Promise<Record<string, unknown>> {
    const uri = await this.deps.sources.cardUri(caller.agent);
    if (!uri) throw new StudioError(409, 'agent_has_no_host', 'this agent has no public A2A host, so nothing is served');
    const fetchedAt = this.now();
    let resp: Response;
    try {
      resp = await this.deps.sources.fetch(uri);
    } catch (e) {
      return { uri, fetchedAt, reachable: false, detail: `egress failed: ${e instanceof Error ? e.message : String(e)}` };
    }
    const head = {
      uri,
      fetchedAt,
      reachable: true,
      status: resp.status,
      source: resp.headers.get('x-ap-card-source'),
      releaseId: resp.headers.get('x-ap-card-release'),
      headerDigest: resp.headers.get('x-ap-card-digest'),
      etag: resp.headers.get('etag'),
      cacheControl: resp.headers.get('cache-control'),
      contentType: resp.headers.get('content-type'),
    };
    if (!resp.ok) return { ...head, detail: `HTTP ${resp.status}` };
    const body = await resp.text();
    // TWO digests, because they answer two different questions and are NOT interchangeable:
    //   servedDigest    — sha256 of the EXACT bytes returned. This is what a byte-for-byte publication is
    //                     proven with, and what equals a release's `signedContentDigest` once published.
    //   canonicalDigest — RFC 8785 digest of the parsed card with `signatures` stripped. This is what a
    //                     DRAFT's effective card hashes to, so it is the only fair draft-vs-served comparison.
    // For a live (unpublished) card they legitimately differ: the runtime serializes with JSON.stringify.
    const servedDigest = sha256Digest(utf8.encode(body));
    let card: unknown = null;
    let canonicalDigest: string | null = null;
    let parseError: string | null = null;
    try {
      card = JSON.parse(body);
      canonicalDigest = cardContentDigest(card as { signatures?: unknown });
    } catch (e) {
      parseError = e instanceof Error ? e.message : String(e);
    }
    return { ...head, body, servedDigest, canonicalDigest, card, ...(parseError ? { parseError } : {}) };
  }

  /** Re-fetch the public card and compare BOTH the served bytes' digest and the `x-ap-card-digest` header. */
  private async verifyWellKnown(uri: string, releaseId: string, digest: Sha256): Promise<A2AWellKnownPublicationReceiptV1> {
    const verifiedAt = this.now();
    const observedVia = this.deps.sources.observedVia ?? 'network';
    const base = { type: 'A2AWellKnownPublicationReceiptV1' as const, receiptId: `wk-${idFrom(uri, releaseId, digest, verifiedAt)}`, uri, releaseId, contentDigest: digest, verifiedAt, observedVia };
    let resp: Response;
    try {
      resp = await this.deps.sources.fetch(uri);
    } catch (e) {
      return { ...base, verificationResult: 'unverified', detail: `egress failed: ${e instanceof Error ? e.message : String(e)}` };
    }
    const etag = resp.headers.get('etag') ?? undefined;
    const cacheControl = resp.headers.get('cache-control') ?? undefined;
    if (!resp.ok) return { ...base, ...(etag ? { httpEtag: etag } : {}), verificationResult: 'unverified', detail: `HTTP ${resp.status}` };
    const body = await resp.text();
    const served = sha256Digest(utf8.encode(body));
    const header = resp.headers.get('x-ap-card-digest');
    const ok = served === digest && header === digest;
    return {
      ...base,
      ...(etag ? { httpEtag: etag } : {}),
      ...(cacheControl ? { cacheControl } : {}),
      verificationResult: ok ? 'valid' : 'invalid',
      ...(ok ? {} : { detail: `served digest ${served}, x-ap-card-digest ${header ?? 'absent'}, expected ${digest}` }),
    };
  }

  /** Drop the cache entry when the release it serves stops being publishable (deprecate / revoke). */
  private async stopServing(cardResourceId: string, meta: CardMetaV1, releaseId: string, agent: Address): Promise<void> {
    if (meta.servedReleaseId !== releaseId) return;
    if (this.deps.releasedCards) await this.deps.releasedCards.delete(studioReleasedCardKey(agent));
    const { servedReleaseId: _drop, ...rest } = meta;
    await this.deps.vault.set(STUDIO_KEYS.meta(cardResourceId), rest);
  }

  private async releaseRevoke(caller: StudioCaller, kind: 'human' | 'service-agent', args: Record<string, unknown>, m: StudioMutationV1): Promise<Record<string, unknown>> {
    const cardResourceId = str(args.cardResourceId, 'cardResourceId');
    const releaseId = str(args.releaseId, 'releaseId');
    const { meta } = await this.loadResource(cardResourceId);
    const release = await this.loadRelease(cardResourceId, releaseId);
    if (!m.reason) throw new StudioError(400, 'bad_input', 'release.revoke requires mutation.reason');
    const next = revokeRelease(release, { reason: m.reason, authority: caip10(this.deps.env.chainId, caller.principal), now: this.now(), ...(optStr(args.successor) ? { successor: optStr(args.successor) } : {}) });
    await this.saveRelease(next);
    await this.stopServing(cardResourceId, meta, releaseId, caller.agent);
    await this.audit('agent.card.revoked', caller, kind, 'success', this.ctx(caller, releaseId, m.correlationId, { inputDigest: release.unsignedContentDigest }), m.reason);
    return { release: next };
  }

  // ── projections (spec 347 §6 / §8.2 / §8.3) ──

  private async loadProjectionIndex(): Promise<string[]> {
    const idx = await this.deps.vault.get<{ v: 1; instanceIds: string[] }>(STUDIO_KEYS.projectionIndex());
    return idx?.instanceIds ?? [];
  }

  private async loadProjection(instanceId: string): Promise<StoredProjectionV1> {
    const stored = await this.deps.vault.get<StoredProjectionV1>(STUDIO_KEYS.projection(instanceId));
    if (!stored) throw new StudioError(404, 'projection_not_found');
    return stored;
  }

  private async saveProjection(stored: StoredProjectionV1): Promise<void> {
    await this.deps.vault.set(STUDIO_KEYS.projection(stored.instance.instanceId), stored);
  }

  private async projectionList(): Promise<Record<string, unknown>> {
    const ids = await this.loadProjectionIndex();
    const projections = (await this.getMany<StoredProjectionV1>(ids.map((id) => STUDIO_KEYS.projection(id)))).filter((p): p is StoredProjectionV1 => !!p);
    return { projections: projections.map((p) => ({ instance: p.instance, family: p.family, selectedCard: p.selectedCard ?? null, planIds: p.planIds, receiptIds: p.receiptIds })) };
  }

  private definitionFor(family: 'ap-naming' | 'ap-registry'): ProjectionDefinitionV1 {
    return family === 'ap-naming' ? AP_NAMING_PROJECTION_DEFINITION : AP_REGISTRY_PROJECTION_DEFINITION;
  }

  private async projectionConfigure(caller: StudioCaller, kind: 'human' | 'service-agent', args: Record<string, unknown>, m: StudioMutationV1): Promise<Record<string, unknown>> {
    const family = str(args.family, 'family');
    if (family !== 'ap-naming' && family !== 'ap-registry') throw new StudioError(400, 'unsupported_family', 'this wave configures ap-naming and ap-registry only; external targets are sibling-repo adapters (ADR-0037)');
    const raw = (args.configuration ?? {}) as Record<string, unknown>;
    const now = this.now();
    const configuration: ApNamingProjectionConfigV1 | ApRegistryProjectionConfigV1 = family === 'ap-naming'
      ? { chainId: this.deps.env.chainId, registry: this.deps.env.namingRegistry, ...pick(raw, ['name', 'a2aEndpoint', 'a2aPath', 'displayName', 'publishCardUri']) } as ApNamingProjectionConfigV1
      : {
          chainId: this.deps.env.chainId,
          registry: parseAddress(raw.registry, 'configuration.registry'),
          registryId: str(raw.registryId, 'configuration.registryId') as RegistryId,
          ...(optStr(raw.entryId) ? { entryId: optStr(raw.entryId) as RegistryEntryId } : {}),
          claimSlots: Array.isArray(raw.claimSlots) ? (raw.claimSlots as ApRegistryProjectionConfigV1['claimSlots']) : [],
          ...(raw.includeCoarseClaims === true ? { includeCoarseClaims: true } : {}),
          ...(typeof raw.expiresAt === 'number' ? { expiresAt: raw.expiresAt } : {}),
          // Pinned at configure time: a projector never reads a clock (spec 347 §6.3).
          issuedAt: optStr(raw.issuedAt) ?? now,
        };
    const definition = this.definitionFor(family);
    const instanceId = `urn:ap:projection-instance:${family}:${caller.agent.toLowerCase()}`;
    const existing = await this.deps.vault.get<StoredProjectionV1>(STUDIO_KEYS.projection(instanceId));
    let selectedCard = existing?.selectedCard;
    if (optStr(args.selectedReleaseId) && optStr(args.cardResourceId)) {
      const rel = await this.loadRelease(optStr(args.cardResourceId)!, optStr(args.selectedReleaseId)!);
      if (!isProjectionReady(rel)) throw new StudioError(409, 'release_not_projection_ready', `release ${rel.releaseId} is ${rel.state}; a projection consumes a signed or published release`);
      selectedCard = { cardResourceId: rel.cardResourceId, releaseId: rel.releaseId };
    }
    const baseInstance: ProjectionInstanceV1 = existing?.instance ?? {
      type: 'ProjectionInstanceV1',
      instanceId,
      agent: caip10(this.deps.env.chainId, caller.agent),
      definition: { id: definition.id, digest: definitionDigest(definition), target: definition.target, adapter: definition.adapter },
      configuration,
      configurationDigest: configurationDigest(configuration),
      state: 'unconfigured',
      since: now,
      desiredSources: {},
    };
    const instance = transitionProjection({ ...baseInstance, configuration, configurationDigest: configurationDigest(configuration), definition: { id: definition.id, digest: definitionDigest(definition), target: definition.target, adapter: definition.adapter } }, { kind: 'configure', at: now });
    const stored: StoredProjectionV1 = { instance, family, ...(selectedCard ? { selectedCard } : {}), planIds: existing?.planIds ?? [], receiptIds: existing?.receiptIds ?? [] };
    await this.saveProjection(stored);
    const ids = await this.loadProjectionIndex();
    if (!ids.includes(instanceId)) await this.deps.vault.set(STUDIO_KEYS.projectionIndex(), { v: 1, instanceIds: [...ids, instanceId] });
    await this.audit('agent.projection.configured', caller, kind, 'success', this.ctx(caller, instanceId, m.correlationId, { inputDigest: instance.configurationDigest, target: family }));
    return { instance, family, selectedCard: selectedCard ?? null };
  }

  /** Build the sealed input bundle (spec 347 §6.1) from canonical sources + the selected release. */
  private async inputBundle(agent: Address, stored: StoredProjectionV1): Promise<{ bundle: ProjectionInputBundleV1; release: A2AAgentCardReleaseV1 | null }> {
    const [prof, names, declared, claims, bindings] = await Promise.all([
      this.deps.sources.profile(agent),
      this.deps.sources.names(agent),
      this.deps.sources.derivedType(agent),
      this.deps.sources.publicSkillClaims(agent),
      this.loadBindings(),
    ]);
    const primary = names.find((n) => n.role === 'primary') ?? names[0];
    const derivedType = declared ?? primary?.derivedType ?? null;
    if (!derivedType) throw new StudioError(409, 'agent_type_undeclared', 'the agent has no on-chain atl:agentType / atl:agentKind and no typed name; declare its type before projecting (spec 346)');
    const profile = prof?.profile ?? synthesizedProfile(primary?.name, {});
    const profileDigest = jcsDigest(profile);
    let release: A2AAgentCardReleaseV1 | null = null;
    if (stored.selectedCard) {
      release = await this.loadRelease(stored.selectedCard.cardResourceId, stored.selectedCard.releaseId);
      if (!isProjectionReady(release)) throw new StudioError(409, 'release_not_projection_ready', `selected release ${release.releaseId} is ${release.state}`);
    }
    const bundle = sealInputBundle({
      type: 'ProjectionInputBundleV1',
      canonicalAgent: { id: caip10(this.deps.env.chainId, agent), derivedType, root: rootClassForDerivedType(derivedType), names: names.map((n) => n.name) },
      canonicalProfile: { release: `urn:ap:profile-snapshot:${shortDigest(profileDigest)}`, digest: profileDigest, ...(prof?.uri ? { uri: prof.uri } : {}) },
      ...(release && release.signedContentDigest
        ? { selectedA2ACard: { cardResourceId: release.cardResourceId, releaseId: release.releaseId, contentDigest: release.signedContentDigest, ...(release.publication?.uri ? { publicationUri: release.publication.uri } : {}) } }
        : {}),
      skillClaims: claims,
      trustClaims: [],
      names,
      existingExternalBindings: bindings,
      disclosurePolicyId: 'urn:ap:disclosure-policy:public-claims',
    });
    return { bundle, release };
  }

  private async projectionPreview(caller: StudioCaller, kind: 'human' | 'service-agent', args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const instanceId = str(args.instanceId, 'instanceId');
    const correlationId = optStr(args.correlationId) ?? this.newId();
    const stored = await this.loadProjection(instanceId);
    const { bundle } = await this.inputBundle(caller.agent, stored);
    const result: ProjectionResultV1<ApNamingArtifactV1 | ApRegistryArtifactV1> = stored.family === 'ap-naming'
      ? apNamingProjector.project(bundle, stored.instance.configuration as ApNamingProjectionConfigV1)
      : apRegistryProjector.project(bundle, stored.instance.configuration as ApRegistryProjectionConfigV1);
    const artifactRecord = STUDIO_KEYS.artifact(instanceId, result.artifactDigest);
    // Keyed by artifact digest: the SAME artifact regenerated from a later bundle (a binding's `verifiedAt`
    // moved) keeps its first provenance record — identical bytes, one record, never a rewrite.
    await this.appendOnly(artifactRecord, { result, bundle }, (v) => (v as { result: { artifactDigest: string } }).result.artifactDigest);
    const now = this.now();
    let instance = stored.instance;
    // A preview is pure; it never disturbs a pending approval or an in-flight publication (the approval
    // names an exact plan digest, so a newer artifact cannot be published under it anyway).
    if (instance.state === 'configured') instance = transitionProjection(instance, { kind: 'validate', at: now });
    if (['ready', 'generated', 'published', 'stale', 'drifted', 'failed'].includes(instance.state)) instance = transitionProjection(instance, { kind: 'generate', at: now });
    instance = { ...instance, desiredSources: { sourceBundleDigest: bundle.sourceBundleDigest, canonicalProfileDigest: bundle.canonicalProfile.digest, ...(bundle.selectedA2ACard ? { selectedCardDigest: bundle.selectedA2ACard.contentDigest } : {}) }, lastArtifact: { artifactDigest: result.artifactDigest, digests: result.digests, generatedAt: now } };
    await this.saveProjection({ ...stored, instance });
    await this.audit('agent.projection.generated', caller, kind, 'success', this.ctx(caller, instanceId, correlationId, { inputDigest: bundle.sourceBundleDigest, resultDigest: result.artifactDigest, target: stored.family }));
    return { instance, result, bundle, artifactRecord };
  }

  private async loadArtifact(instanceId: string, artifactDigest: string): Promise<{ result: ProjectionResultV1<ApNamingArtifactV1 | ApRegistryArtifactV1>; bundle: ProjectionInputBundleV1 }> {
    const rec = await this.deps.vault.get<{ result: ProjectionResultV1<ApNamingArtifactV1 | ApRegistryArtifactV1>; bundle: ProjectionInputBundleV1 }>(STUDIO_KEYS.artifact(instanceId, artifactDigest));
    if (!rec) throw new StudioError(404, 'artifact_not_found', 'run projection.preview first');
    return rec;
  }

  /** Turn a plan's operations into the `{to,value,data}` calls the Home executes with the custodian. */
  private async contractCallsFor(family: 'ap-naming' | 'ap-registry', plan: PublicationPlanV1, artifact: ApNamingArtifactV1 | ApRegistryArtifactV1): Promise<{ calls: PlannedContractCallV1[]; signatureRequests: Array<{ purpose: string; digest: Hex }> }> {
    const calls: PlannedContractCallV1[] = [];
    const signatureRequests: Array<{ purpose: string; digest: Hex }> = [];
    for (const op of plan.operations) {
      if (op.kind === 'contract-call' && op.call) {
        calls.push(op.call);
      } else if (op.kind === 'name-record-write' && family === 'ap-naming') {
        const a = artifact as ApNamingArtifactV1;
        const resolver = await this.deps.sources.nameResolver(a.node);
        if (!resolver) throw new StudioError(409, 'name_has_no_resolver', `${a.name} has no resolver set on ${a.registry}`);
        const records: AgentNameRecords = {
          addr: a.records.addr,
          ...(a.records.agentKind ? { agentKind: a.records.agentKind } : {}),
          ...(a.records.displayName !== undefined ? { displayName: a.records.displayName } : {}),
          ...(a.records.a2aEndpoint !== undefined ? { a2aEndpoint: a.records.a2aEndpoint } : {}),
          ...(a.records.metadataUri !== undefined ? { metadataUri: a.records.metadataUri } : {}),
          ...(a.records.metadataHash !== undefined ? { metadataHash: a.records.metadataHash } : {}),
          ...(a.records.cardDigest !== undefined ? { cardDigest: a.records.cardDigest } : {}),
          ...(a.records.cardUri !== undefined ? { cardUri: a.records.cardUri } : {}),
        };
        for (const c of buildRecordCalls({ resolver, node: a.node, records })) calls.push({ chainId: a.chainId, to: c.to, value: c.value.toString(), data: c.data });
      } else if (op.kind === 'smart-agent-signature') {
        const payload = op.payload as { digest?: string } | undefined;
        if (payload?.digest) signatureRequests.push({ purpose: op.target, digest: sha256ToBytes32(payload.digest as Sha256) });
      } else {
        throw new StudioError(500, 'unsupported_operation', `plan operation ${op.kind} has no execution binding here`);
      }
    }
    return { calls, signatureRequests };
  }

  private async projectionPlan(caller: StudioCaller, kind: 'human' | 'service-agent', args: Record<string, unknown>, m: StudioMutationV1): Promise<Record<string, unknown>> {
    const instanceId = str(args.instanceId, 'instanceId');
    const stored = await this.loadProjection(instanceId);
    const artifactDigest = optStr(args.artifactDigest) ?? stored.instance.lastArtifact?.artifactDigest;
    if (!artifactDigest) throw new StudioError(409, 'no_artifact', 'run projection.preview first');
    const { result } = await this.loadArtifact(instanceId, artifactDigest);
    const blocking = result.requiredActions.filter((a) => a.blocking && a.kind !== 'sign-binding-proof');
    if (blocking.length > 0) throw new StudioError(409, 'blocking_required_actions', 'the artifact has blocking required actions', { requiredActions: blocking });
    if (result.diagnostics.some((d) => d.severity === 'error')) throw new StudioError(422, 'artifact_has_errors', 'the artifact has validation errors', { diagnostics: result.diagnostics });
    const ctx: PublisherContext = {
      projectionInstanceId: instanceId,
      credentialRefs: [{ backend: 'smart-agent-custody', keyId: caller.agent, kind: 'smart-agent-custody' }],
      dryRun: args.dryRun === true,
      now: this.now(),
      idempotencyKey: m.idempotencyKey,
      ...(typeof args.planTtlSeconds === 'number' ? { planTtlSeconds: args.planTtlSeconds } : {}),
      ...(args.costCeiling && typeof args.costCeiling === 'object' ? { costCeiling: args.costCeiling as PublisherContext['costCeiling'] } : {}),
    };
    // REGISTER or RE-POINT is decided by what is on chain, never by the caller's optimism: `registerEntry`
    // reverts `EntryExists`, so an existing listing publishing a newer card failed on chain with nothing
    // recorded (2026-08-30). One read answers it (spec 346 §7's update path).
    let plan: PublicationPlanV1;
    if (stored.family === 'ap-naming') {
      plan = buildApNamingPublicationPlan(result.artifact as ApNamingArtifactV1, ctx);
    } else {
      const a = result.artifact as ApRegistryArtifactV1;
      const asked = optStr(args.mode);
      const onChain = await this.deps.sources.registryEntry({ registry: a.registry, registryId: urnToBytes32(a.entry.registryId), entryId: urnToBytes32(a.entry.id) }).catch(() => null);
      const mode = asked === 'renew' ? 'renew' : onChain && onChain.status !== 0 ? 'update' : 'register';
      plan = buildApRegistryPublicationPlan(a, ctx, { mode });
    }
    const { calls, signatureRequests } = await this.contractCallsFor(stored.family, plan, result.artifact);
    const storedPlan: StoredPlanV1 = { plan, contractCalls: calls, signatureRequests, artifactRecord: STUDIO_KEYS.artifact(instanceId, artifactDigest), createdBy: caller.principal };
    await this.appendOnly(STUDIO_KEYS.plan(instanceId, plan.planId), storedPlan);
    if (!stored.planIds.includes(plan.planId)) await this.saveProjection({ ...stored, planIds: [...stored.planIds, plan.planId] });
    await this.audit('agent.projection.publication.planned', caller, kind, 'success', this.ctx(caller, instanceId, m.correlationId, { inputDigest: artifactDigest, resultDigest: plan.planDigest, target: stored.family }));
    return { plan, contractCalls: calls, signatureRequests };
  }

  private async loadPlan(instanceId: string, planId: string): Promise<StoredPlanV1> {
    const p = await this.deps.vault.get<StoredPlanV1>(STUDIO_KEYS.plan(instanceId, planId));
    if (!p) throw new StudioError(404, 'plan_not_found');
    return p;
  }

  private async projectionRequestApproval(caller: StudioCaller, kind: 'human' | 'service-agent', args: Record<string, unknown>, m: StudioMutationV1): Promise<Record<string, unknown>> {
    const instanceId = str(args.instanceId, 'instanceId');
    const planId = str(args.planId, 'planId');
    const stored = await this.loadProjection(instanceId);
    await this.loadPlan(instanceId, planId);
    const instance = transitionProjection(stored.instance, { kind: 'requestApproval', at: this.now(), reason: planId });
    await this.saveProjection({ ...stored, instance });
    await this.audit('agent.projection.approval.requested', caller, kind, 'success', this.ctx(caller, instanceId, m.correlationId, { inputDigest: planId, target: stored.family }));
    return { instance };
  }

  private async projectionApprove(caller: StudioCaller, kind: 'human' | 'service-agent', args: Record<string, unknown>, m: StudioMutationV1): Promise<Record<string, unknown>> {
    const instanceId = str(args.instanceId, 'instanceId');
    const planId = str(args.planId, 'planId');
    const stored = await this.loadProjection(instanceId);
    const storedPlan = await this.loadPlan(instanceId, planId);
    if (this.deps.env.separationOfDuties === 'strict' && storedPlan.createdBy.toLowerCase() === caller.principal.toLowerCase()) {
      throw new StudioError(403, 'separation_of_duties', 'SEPARATION_OF_DUTIES=strict: the approver must not be the planner');
    }
    const now = this.now();
    const approval: ApprovalRefV1 = {
      approvalId: `urn:ap:approval:${idFrom(caller.agent, planId, m.idempotencyKey)}`,
      approvedDigest: storedPlan.plan.planDigest,
      approver: caip10(this.deps.env.chainId, caller.principal),
      approvedAt: now,
      expiresAt: optStr(args.expiresAt) ?? storedPlan.plan.expiresAt,
      idempotencyKey: storedPlan.plan.idempotencyKey,
      ...(m.reason ? { conditions: [m.reason] } : {}),
    };
    await this.appendOnly(STUDIO_KEYS.approval(approval.approvalId), { approval, subject: { kind: 'projection-publication', objectId: planId, agent: caip10(this.deps.env.chainId, caller.agent) }, approverPrincipal: caller.principal } satisfies StoredApprovalV1);
    await this.deps.vault.set(STUDIO_KEYS.plan(instanceId, planId), { ...storedPlan, approvalId: approval.approvalId });
    // Vocabulary gap: spec 347 §9 names `agent.card.release.approved` but no projection twin — recorded as
    // `agent.projection.approved` (the approvals:* record is the evidence either way).
    await this.audit('agent.projection.approved', caller, kind, 'success', this.ctx(caller, instanceId, m.correlationId, { inputDigest: storedPlan.plan.planDigest, actingAuthorityRef: approval.approvalId, target: stored.family }));
    return { approval, plan: storedPlan.plan };
  }

  /**
   * The Home executed the plan's calls with the custodian and reports the tx hashes. The server re-checks
   * the approval covers the plan (fail-closed), then verifies ON CHAIN — `readContract` only — that the
   * target now carries the artifact, and records the receipt + external identity binding.
   */
  private async projectionRecordPublication(caller: StudioCaller, kind: 'human' | 'service-agent', args: Record<string, unknown>, m: StudioMutationV1): Promise<Record<string, unknown>> {
    const instanceId = str(args.instanceId, 'instanceId');
    const planId = str(args.planId, 'planId');
    const approvalId = str(args.approvalId, 'approvalId');
    const stored = await this.loadProjection(instanceId);
    const storedPlan = await this.loadPlan(instanceId, planId);
    const storedApproval = await this.deps.vault.get<StoredApprovalV1>(STUDIO_KEYS.approval(approvalId));
    if (!storedApproval) throw new StudioError(404, 'approval_not_found');
    const now = this.now();
    assertApprovalCoversPlan(storedApproval.approval, storedPlan.plan, now);
    if (storedPlan.plan.dryRun) throw new StudioError(409, 'dry_run_plan', 'a dry-run plan is never recorded as published');
    const txs = Array.isArray(args.transactions) ? (args.transactions as Array<{ chainId?: number; hash?: string; blockNumber?: string }>) : [];
    const transactions = txs.map((t) => ({ chainId: typeof t.chainId === 'number' ? t.chainId : this.deps.env.chainId, hash: bytes32Hex(str(t.hash, 'transactions[].hash'), 'transactions[].hash'), ...(t.blockNumber ? { blockNumber: String(t.blockNumber) } : {}) }));
    const { result } = await this.loadArtifact(instanceId, storedPlan.plan.artifactDigest);
    let instance = stored.instance;
    if (instance.state === 'approvalPending' || instance.state === 'failed') instance = transitionProjection(instance, { kind: 'publish', at: now });
    await this.audit('agent.projection.publish.started', caller, kind, 'success', this.ctx(caller, instanceId, m.correlationId, { inputDigest: storedPlan.plan.planDigest, actingAuthorityRef: approvalId, target: stored.family, ...(transactions[0] ? { txRef: transactions[0].hash } : {}) }));

    const verdict = await this.verifyOnChain(stored.family, result.artifact);
    const receipt: PublicationReceiptV1 = {
      type: 'PublicationReceiptV1',
      receiptId: `urn:ap:publication-receipt:${idFrom(instanceId, planId, now)}`,
      planId,
      artifactDigest: storedPlan.plan.artifactDigest,
      digests: result.digests,
      publishedAt: now,
      externalIds: [{ family: stored.family, registry: verdict.registry, network: `eip155:${this.deps.env.chainId}`, externalId: verdict.externalId }],
      transactions,
      verification: { result: verdict.ok ? 'valid' : 'invalid', verifiedAt: now, method: 'readContract' },
    };
    await this.appendOnly(STUDIO_KEYS.receipt(instanceId, receipt.receiptId), receipt);
    const binding = await this.upsertBinding(caller.agent, stored.family, verdict, storedPlan.plan.artifactDigest, now);
    instance = transitionProjection(instance, { kind: verdict.ok ? 'publishSucceeded' : 'publishFailed', at: now, ...(verdict.ok ? {} : { reason: verdict.detail }) });
    instance = { ...instance, lastPublication: { receiptId: receipt.receiptId, planId, artifactDigest: storedPlan.plan.artifactDigest, publishedAt: now }, lastBinding: { bindingId: binding.bindingId, externalId: binding.externalId, verificationState: binding.verification.state } };
    await this.saveProjection({ ...stored, instance, receiptIds: [...stored.receiptIds, receipt.receiptId] });
    const auditCtx = this.ctx(caller, instanceId, m.correlationId, { inputDigest: storedPlan.plan.planDigest, resultDigest: storedPlan.plan.artifactDigest, actingAuthorityRef: approvalId, target: stored.family, receiptRef: receipt.receiptId, ...(transactions[0] ? { txRef: transactions[0].hash } : {}), privacyClass: 'public' });
    await this.audit(verdict.ok ? 'agent.projection.publish.completed' : 'agent.projection.publish.failed', caller, kind, verdict.ok ? 'success' : 'error', auditCtx, verdict.ok ? undefined : verdict.detail);
    await this.audit(verdict.ok ? 'agent.binding.verified' : 'agent.binding.verification.failed', caller, kind, verdict.ok ? 'success' : 'error', this.ctx(caller, binding.bindingId, m.correlationId, { target: stored.family, privacyClass: 'public' }), verdict.ok ? undefined : verdict.detail);
    if (stored.family === 'ap-naming' && verdict.ok) await this.audit('agent.naming.updated', caller, kind, 'success', this.ctx(caller, verdict.externalId, m.correlationId, { resultDigest: storedPlan.plan.artifactDigest, target: verdict.registry, privacyClass: 'public' }));
    return { receipt, binding, instance };
  }

  /** ONE mechanism: read the target's current state and compare it with the artifact. Never a log scan. */
  private async verifyOnChain(family: 'ap-naming' | 'ap-registry', artifact: ApNamingArtifactV1 | ApRegistryArtifactV1): Promise<{ ok: boolean; registry: string; externalId: string; detail?: string; observed: unknown }> {
    if (family === 'ap-naming') {
      const a = artifact as ApNamingArtifactV1;
      const onChain = await this.deps.sources.nameRecords(a.name);
      const mismatches: string[] = [];
      const cmp = (k: keyof AgentNameRecords, want: unknown) => {
        if (want === undefined) return;
        const have = onChain[k];
        const eq = typeof want === 'string' && typeof have === 'string' ? want.toLowerCase() === have.toLowerCase() : want === have;
        if (!eq) mismatches.push(`${k}: on-chain ${String(have)} ≠ artifact ${String(want)}`);
      };
      cmp('addr', a.records.addr);
      cmp('agentKind', a.records.agentKind);
      cmp('displayName', a.records.displayName);
      cmp('a2aEndpoint', a.records.a2aEndpoint);
      cmp('metadataUri', a.records.metadataUri);
      cmp('metadataHash', a.records.metadataHash);
      cmp('cardDigest', a.records.cardDigest);
      cmp('cardUri', a.records.cardUri);
      return { ok: mismatches.length === 0, registry: a.registry, externalId: a.node, observed: onChain, ...(mismatches.length ? { detail: mismatches.join('; ') } : {}) };
    }
    const a = artifact as ApRegistryArtifactV1;
    const entry = await this.deps.sources.registryEntry({ registry: a.registry, registryId: urnToBytes32(a.entry.registryId), entryId: urnToBytes32(a.entry.id) });
    if (!entry) return { ok: false, registry: a.registry, externalId: a.entry.id, detail: 'entry not found on chain', observed: null };
    const mismatches: string[] = [];
    if (entry.subjectAgent.toLowerCase() !== a.entry.subjectAgent.toLowerCase()) mismatches.push('subjectAgent');
    if (entry.cardHash.toLowerCase() !== sha256ToBytes32(a.entry.cardHash).toLowerCase()) mismatches.push('cardHash');
    if (entry.bindingProofHash.toLowerCase() !== sha256ToBytes32(a.entry.bindingProofHash).toLowerCase()) mismatches.push('bindingProofHash');
    if (entry.status !== 1) mismatches.push(`status ${entry.status} (not Active)`);
    return { ok: mismatches.length === 0, registry: a.registry, externalId: a.entry.id, observed: entry, ...(mismatches.length ? { detail: `mismatch: ${mismatches.join(', ')}` } : {}) };
  }

  // ── bindings ──

  private async loadBindings(): Promise<ExternalIdentityBindingV1[]> {
    const idx = await this.deps.vault.get<{ v: 1; bindingIds: string[] }>(STUDIO_KEYS.bindingIndex());
    const ids = idx?.bindingIds ?? [];
    return (await this.getMany<ExternalIdentityBindingV1>(ids.map((id) => STUDIO_KEYS.binding(id)))).filter((b): b is ExternalIdentityBindingV1 => !!b);
  }

  private async upsertBinding(agent: Address, family: 'ap-naming' | 'ap-registry', verdict: { ok: boolean; registry: string; externalId: string; detail?: string }, artifactDigest: Sha256, now: string): Promise<ExternalIdentityBindingV1> {
    const bindingId = `urn:ap:binding:${family}:${idFrom(agent, verdict.registry, verdict.externalId)}`;
    const existing = await this.deps.vault.get<ExternalIdentityBindingV1>(STUDIO_KEYS.binding(bindingId));
    let binding: ExternalIdentityBindingV1;
    if (existing && existing.lifecycle.state !== 'revoked' && existing.lifecycle.state !== 'superseded') {
      binding = transitionBinding({ ...existing, artifactDigest, verification: { state: verdict.ok ? 'verified' : 'failed', verifiedAt: now, method: 'readContract' } }, { kind: verdict.ok ? 'verified' : 'verificationFailed', at: now, ...(verdict.detail ? { reason: verdict.detail } : {}) });
    } else {
      binding = {
        type: 'ExternalIdentityBindingV1',
        bindingId,
        canonicalAgentId: caip10(this.deps.env.chainId, agent),
        target: { family, registry: verdict.registry, network: `eip155:${this.deps.env.chainId}` },
        externalId: verdict.externalId,
        artifactDigest,
        verification: { state: verdict.ok ? 'verified' : 'failed', verifiedAt: now, method: 'readContract' },
        lifecycle: { state: verdict.ok ? 'active' : 'pendingVerification', since: now, ...(verdict.detail ? { reason: verdict.detail } : {}) },
      };
    }
    await this.deps.vault.set(STUDIO_KEYS.binding(bindingId), binding);
    const idx = await this.deps.vault.get<{ v: 1; bindingIds: string[] }>(STUDIO_KEYS.bindingIndex());
    const ids = idx?.bindingIds ?? [];
    if (!ids.includes(bindingId)) await this.deps.vault.set(STUDIO_KEYS.bindingIndex(), { v: 1, bindingIds: [...ids, bindingId] });
    return binding;
  }

  private async bindingList(): Promise<Record<string, unknown>> {
    return { bindings: await this.loadBindings() };
  }

  private async bindingVerify(caller: StudioCaller, kind: 'human' | 'service-agent', args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const bindingId = str(args.bindingId, 'bindingId');
    const correlationId = optStr(args.correlationId) ?? this.newId();
    const binding = await this.deps.vault.get<ExternalIdentityBindingV1>(STUDIO_KEYS.binding(bindingId));
    if (!binding) throw new StudioError(404, 'binding_not_found');
    const family = binding.target.family as 'ap-naming' | 'ap-registry';
    if (family !== 'ap-naming' && family !== 'ap-registry') throw new StudioError(400, 'unsupported_family');
    if (!binding.artifactDigest) throw new StudioError(409, 'binding_has_no_artifact');
    const instanceId = `urn:ap:projection-instance:${family}:${caller.agent.toLowerCase()}`;
    const { result } = await this.loadArtifact(instanceId, binding.artifactDigest);
    const verdict = await this.verifyOnChain(family, result.artifact);
    const next = await this.upsertBinding(caller.agent, family, verdict, binding.artifactDigest, this.now());
    await this.audit(verdict.ok ? 'agent.binding.verified' : 'agent.binding.verification.failed', caller, kind, verdict.ok ? 'success' : 'error', this.ctx(caller, bindingId, correlationId, { target: family, privacyClass: 'public' }), verdict.detail);
    return { binding: next, verdict: { ok: verdict.ok, detail: verdict.detail ?? null, observed: verdict.observed } };
  }
}

// ─── Small helpers ───────────────────────────────────────────────────────────────────────────────────

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function pick<T extends Record<string, unknown>>(raw: T, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (raw[k] !== undefined) out[k] = raw[k];
  return out;
}

function parseAddress(v: unknown, field: string): Address {
  if (typeof v !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(v)) throw new StudioError(400, 'bad_input', `${field} must be an address`);
  return v as Address;
}

/** A profile stand-in when the agent has no anchored `atl:metadataURI` — computed, and bound as such. */
function synthesizedProfile(primaryName: string | undefined, live: Record<string, unknown>): CanonicalAgentProfileV1 {
  const label = primaryName ? primaryName.split('.')[0] ?? primaryName : undefined;
  return {
    type: 'service',
    ...(label ? { displayName: label } : typeof live.name === 'string' ? { displayName: live.name } : {}),
    ...(typeof live.description === 'string' ? { description: live.description } : {}),
  };
}

function statusOf(e: unknown): number {
  if (e instanceof StudioError) return e.status;
  if (e instanceof A2ACardLifecycleError || e instanceof ProjectionLifecycleError || e instanceof PlanNotApprovedError) return 409;
  if (e instanceof A2ACardValidationError) return 422;
  return 500;
}

function errorBody(e: unknown): Record<string, unknown> {
  if (e instanceof StudioError) return { ok: false, error: e.code, detail: e.message, ...(e.extra ?? {}) };
  if (e instanceof A2ACardLifecycleError) return { ok: false, error: 'illegal_transition', detail: e.message, from: e.from, to: e.to };
  if (e instanceof A2ACardValidationError) return { ok: false, error: 'validation_failed', detail: e.message, diagnostics: e.diagnostics };
  if (e instanceof ProjectionLifecycleError) return { ok: false, error: 'illegal_projection_transition', detail: e.message };
  if (e instanceof PlanNotApprovedError) return { ok: false, error: 'plan_not_approved', reason: e.reason, detail: e.message };
  return { ok: false, error: 'studio_failed', detail: e instanceof Error ? e.message : String(e) };
}
