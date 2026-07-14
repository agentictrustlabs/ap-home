// InteractionsDO — the per-principal SERIALIZED execution point for the interaction substrate
// (spec 322 W2; the embryo of spec 316's PrincipalGatewayDO). One instance per principal SA
// (idFromName = lowercase org/person SA): every board/directory mutation for that principal flows
// through THIS object, giving the single-writer ordering the vault's last-writer-wins storage
// cannot (spec 322 §5). Plane-B custody: the DO stores the principal's steward-signed interactions
// grant (the OPERATIONAL wire lives with its delegate service — spec 322 §2); callers never touch
// `/mcp/vault/*` for interaction records.
//
// Gates (spec 322 §4), all fail-closed:
//   caller    = a broker-verified Home session (any principal kind) → the session SA;
//   member    = a CURRENT directory listing whose ERC-1271 proof re-verifies AT GATE TIME against
//               the subject SA (index presence is never trust — the index is writable under the
//               execution grant);
//   steward   = a PRESENTED org→person stewardship DelegationWire, signature-verified against the
//               org (approved-hash 0x03 wires validate through the SA's ERC-1271 branch) and
//               checked unrevoked on-chain;
//   replay    = monotonic publishedAt per subject + tombstones honored by the gate.
// The VAULT enforces scopes only — never membership (stated so nobody optimizes this gate away).
// Audit: D1 (spec 322 §7), before commit.
import { createPublicClient, http, decodeAbiParameters, type Address, type Hex } from 'viem';
import { baseSepolia } from 'viem/chains';
import { hashDelegation, decodeVaultRecordScopeTerms, VAULT_RECORD_SCOPE_ENFORCER, type Delegation } from '@agenticprimitives/delegation';
import {
  appendBoardPost,
  createBoardChannel,
  canSeeChannel,
  canonicalizeMessage,
  createVaultMessageBodyStore,
  isListingCurrent,
  sha256Hex32,
  validateDirectoryListing,
  type ChannelV1,
  type DirectoryListingV1,
  type MessageEnvelopeV1,
} from '@agenticprimitives/fabric/messaging';
import type { Vault } from '@agenticprimitives/vault';

import { verifyHomeSession } from './custody-oidc.js';
import { verifyBridgeCall, nonceStoreFromKv, type NonceStore } from './bridge-hmac';
// Hoisted-function import from index.js — the documented safe cycle (see a2a-task-do.ts:38).
import { buildAuditSink, callMcpToolBound, type Env, type IncomingDelegation } from './index.js';

const ERC1271_ABI = [{ type: 'function', name: 'isValidSignature', stateMutability: 'view', inputs: [{ name: 'hash', type: 'bytes32' }, { name: 'signature', type: 'bytes' }], outputs: [{ type: 'bytes4' }] }] as const;
const ERC1271_MAGIC = '0x1626ba7e';
const IS_REVOKED_ABI = [{ type: 'function', name: 'isRevoked', stateMutability: 'view', inputs: [{ name: 'delegationHash', type: 'bytes32' }], outputs: [{ name: 'revoked', type: 'bool' }] }] as const;

// spec 324 §10 conversation/topic split (renamed from board.* in the W6 key migration): descriptors in
// `conversation.index`; per-topic message projections in `conversation.topic:<id>` (multi-writer conflicts
// shrink to same-topic; reads stop paying for the whole board; per-topic scopes become possible). NO dual-read
// from the old `board.*` keys (ADR-0013) — the scope rename forces a grant re-enable, which self-invalidates.
const CONVERSATION_INDEX_RESOURCE = 'conversation.index';
const TOPIC_RESOURCE = (conversationId: string): string => `conversation.topic:${conversationId}`;
const DIRECTORY_RESOURCE = 'directory.data';

/** The scope set the CURRENT wave requires — a stored grant missing any of these is STALE and the
 *  steward re-signs via the Enable ceremony (grant re-signs are ceremonies, not migration). */
// NOTE: `vault:org.applications` is deliberately NOT here. It ships in the interactions grant (so fresh grants
// can write the applications doc), but it is a FEATURE-specific additive scope — gating the WHOLE interactions
// plane (channels/directory/inbox/invite) on it would strand any grant that predates it (or was signed in a
// deploy window) with a blanket "stale — re-enable". A grant lacking it simply can't write org.applications
// (the vault-record-scope caveat enforces that at the vault); everything else keeps working.
const REQUIRED_SCOPES = ['vault:conversation.index', 'vault:conversation.topic:*', 'vault:message.body:topic:*', 'vault:inbox.data', 'vault:directory.data', 'vault:relationships.data', 'vault:member.profile:*', 'vault:org.membership:*', 'vault:message.body:dm:*', 'vault:impact-profile', 'vault:skills.data', 'vault:home.manifest', 'vault:control-events.data'] as const;

// 1-1 inbox residency (spec 322 W3f): the DELIVERY grant is WRITE-ONLY — every inbox.data READ and
// dm-body READ rides the interactions grant THROUGH this DO (single writer, single reader path).
const INBOX_RESOURCE = 'inbox.data';
const DM_BODY_PREFIX = 'message.body:dm:';
// spec 324 §7 Tier-2 — the org's pending MembershipApplications doc, a plain whole-doc record in the org's
// vault (NOT the inbox — a non-member's application must surface reliably to the steward). Bridge-only: the
// Home appends on the applicant's behalf (applying is open) and reads on the steward's behalf.
const APPLICATIONS_RESOURCE = 'org.applications';

// Person-plane records (spec 322 W3d): the person's authoritative org-relationship doc and their
// per-org shareable profile cards. Self-gated ops only — the session SA must BE the principal.
const RELATIONSHIPS_RESOURCE = 'relationships.data';
const MEMBER_PROFILE_RESOURCE = (org: string): string => `member.profile:${org.toLowerCase()}`;

// spec 324 W3 — the AUTHORITATIVE OrganizationMembership record (a private SituationV2 + its credential),
// per org, in the party's own vault. Membership is NOT a delegation and NOT a directory listing (ADR-0048
// #3/#6): this record is the single source of truth; the related:* link, directory roster row, and gate
// caches are provenance-tagged projections of it. Self-gated writes (the principal owns their membership
// record); the org retains its own copy in the org's DO.
const MEMBERSHIP_RESOURCE = (org: string): string => `org.membership:${org.toLowerCase()}`;

// spec 323 W2 — owner-own capability DOCUMENTS (last-writer-wins whole-doc records), reachable ONLY
// self (session SA === principal) over the interactions grant. This is the delegation-authorized,
// KEK-encrypted replacement for the bearer/service-MAC `impact-profile` path (V-1 remediation) and
// the app-local `skills`/`home-manifest` KV. NOT append logs (control-events needs its own op).
const CAPABILITY_RECORDS = new Set(['impact-profile', 'skills.data', 'home.manifest', 'control-events.data']);
const CONTROL_EVENTS_RESOURCE = 'control-events.data';
const CONTROL_EVENTS_CAP = 200; // ring buffer — the person's portable timeline is a recent-window projection.

// spec 323 §3: wires whose DELEGATE is this person (stewardship, member-access) are the person's
// own private credentials — they ride the entry so any Home can act from the vault (ADR-0025).
// spec 323 W1-tail — kind/parent capture the managed-tree SHAPE (org / org-treasury / person-treasury
// and where it hangs), so a second Home reconstructs the FULL tree + inbox-control from the vault, not
// just member/steward org links.
// spec 324 W3 — provenance fields (membershipId / membershipSituationHash / enrollmentDecisionRef) make this
// projection traceable back to its authoritative OrganizationMembership Situation. `relationship:'member'`
// here is a projection LABEL, never authority (ADR-0048 #3): the delegations it carries are the authority
// artifacts issued BECAUSE of membership; the membership itself is the SituationV2 the provenance points to.
interface RelationshipEntryV1 { org: string; relationship: 'member' | 'steward'; orgName?: string; kind?: string; parent?: string; delegationHash?: string; delegations?: IncomingDelegation[]; membershipId?: string; membershipSituationHash?: string; enrollmentDecisionRef?: string; updatedAt: string }
interface RelationshipsDocV1 { orgs: Record<string, RelationshipEntryV1> }
/** Grants LEDGER row (spec 322 W3e §2): hash + metadata ONLY — the wire itself is a bearer secret. */
interface GrantLedgerRowV1 { hash: string; delegate: string; resources: string[]; storedAt: string }

interface IndexedListing { listing: DirectoryListingV1; label: string }
interface StoredState {
  grant?: IncomingDelegation;
  /** NEW-C1 — the PRINCIPAL-signed DEL-001 session-delegation leaf (principal → the interactions-session
   *  KMS key). Custodied at grant.put alongside `grant`. When present (+ GCP_KMS_INTERACTIONS_KEY_NAME set),
   *  vaultFor CLIENT-MINTS a bound token (callMcpToolBound) instead of server-mint — no DEMO_ALLOW_SERVER_MINT.
   *  Absent ⇒ vaultFor falls back to the server-mint bridge (existing principals migrate on next enable). */
  sessionLeaf?: IncomingDelegation;
  /** spec 323 W3 — the WRITE-ONLY delivery wire (owner → DELIVERY_SERVICE_SA), custodied HERE (a
   *  stored wire is a bearer secret; the DO is the delegate-service side, spec 322 §2). The DO is
   *  now the sole holder+wielder for dm-body writes — no app (not even the Home) keeps it. */
  deliveryGrant?: IncomingDelegation;
  /** Issuance ledger (spec 322 W3e): every grant ever custodied here, hash/metadata only. */
  ledger?: GrantLedgerRowV1[];
  /** subject(lowercase caip10) → highest publishedAt accepted (replay guard) + tombstone flag. */
  subjects?: Record<string, { publishedAt: string; tombstoned?: boolean }>;
}

const json = (b: unknown, s = 200): Response => new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } });

export class InteractionsDO {
  constructor(private state: DurableObjectState, private env: Env) {}

  /** ARCH-H1 — a per-instance RMW mutex. A Durable Object serves concurrent requests that interleave
   *  across the MCP round-trip, so two appends to the SAME doc both read rev N and one silently
   *  overwrites the other (lost update). This serializes read→modify→write for the ops that share a
   *  doc across DISTINCT writers — channel posts (many members), deliveries (many senders), timeline
   *  appends (many server flows). Reads never take it; self-only single-writer ops don't need it. */
  private mutating: Promise<unknown> = Promise.resolve();
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.mutating.then(fn, fn);
    this.mutating = run.then(() => undefined, () => undefined);
    return run;
  }


  private pub() {
    return createPublicClient({ chain: baseSepolia, transport: http(this.env.RPC_URL) });
  }

  private async erc1271(account: Address, digest: Hex, signature: Hex): Promise<boolean> {
    try {
      const magic = (await this.pub().readContract({ address: account, abi: ERC1271_ABI, functionName: 'isValidSignature', args: [digest, signature] })) as Hex;
      return magic.toLowerCase() === ERC1271_MAGIC;
    } catch { return false; }
  }

  /** The fabric Vault port over the delegation-authorized demo-mcp transport (plane B). */
  private vaultFor(grant: IncomingDelegation): Vault {
    const env = this.env;
    // NEW-C1 — per-op transport selection. When the principal has custodied a DEL-001 session leaf
    // (st.sessionLeaf, PRINCIPAL-signed, binding the interactions-session KMS key) AND that key is
    // configured, CLIENT-MINT a bound token (callMcpToolBound, enforceBinding) — the leaf's delegator MUST
    // equal this grant's delegator (the principal / token sub), else it's not the right principal's leaf.
    // Otherwise fall back to the server-mint bridge so pre-enable principals keep working; they migrate to
    // bound-mint on their next enable (grant.put). No behavior change until GCP_KMS_INTERACTIONS_KEY_NAME set.
    const callTool = async (toolName: 'get_vault_record' | 'set_vault_record' | 'list_vault_record', toolArgs: Record<string, unknown>): Promise<Response> => {
      if ((env.GCP_KMS_INTERACTIONS_KEY_NAME ?? '').trim()) {
        const st = ((await this.state.storage.get('state')) ?? {}) as StoredState;
        const leaf = st.sessionLeaf;
        if (leaf && leaf.delegator.toLowerCase() === grant.delegator.toLowerCase()) {
          return callMcpToolBound({ env, toolName, grant, sessionLeaf: leaf, toolArgs });
        }
        // CRIT-2 W4 — the interactions-session key IS configured but this principal has NO custodied leaf
        // (it enabled before leaf-signing shipped). FAIL-CLOSED (ADR-0013 one-mechanism): require a
        // re-enable to custody the DEL-001 leaf; do NOT switch to the server-mint bridge. Server-mint is
        // retired. The Home's activateInteractionsIfNeeded self-heals this on the principal's next login.
        return new Response(
          JSON.stringify({ ok: false, error: 'session_leaf_required', detail: 'interactions vault access needs a re-enable to custody the DEL-001 session leaf (server-mint retired — CRIT-2)' }),
          { status: 409, headers: { 'Content-Type': 'application/json' } },
        );
      }
      // CRIT-2 W6 — server-mint retired. The interactions-session KMS key is REQUIRED for interactions vault
      // ops (bound-mint above / DO-side proof). Unconfigured ⇒ FAIL-CLOSED (dev must provision
      // GCP_KMS_INTERACTIONS_KEY_NAME); prod always sets it, taking the bound/409 branch above. No fallback.
      return new Response(
        JSON.stringify({ ok: false, error: 'interactions_key_unprovisioned', detail: 'GCP_KMS_INTERACTIONS_KEY_NAME is unset — interactions vault ops require it (server-mint retired, CRIT-2)' }),
        { status: 503, headers: { 'Content-Type': 'application/json' } },
      );
    };
    return {
      async write({ resource, data }: { owner: string; resource: string; data: unknown; classification?: string }): Promise<void> {
        const resp = await callTool('set_vault_record', { recordType: resource, data });
        const out = (await resp.json().catch(() => ({}))) as { ok?: boolean; error?: string };
        if (!resp.ok || out.ok === false) throw new Error(out.error ?? `vault write failed (${resp.status})`);
      },
      async read<T>({ resource }: { owner: string; resource: string }): Promise<{ data: T } | null> {
        // BOUNDED RETRY (2026-07-11) — cold-cache first read; demo-mcp caches the deterministic vault-key
        // verdict, so only the first op per isolate touches the chain. A real empty (`ok:true, record:null`)
        // returns immediately — empty is an answer, an auth error is not (ADR-0013: retry the SAME call).
        // NOTE: get_vault_record returns the payload under `data` (NOT `record`) — the field-name mismatch
        // was THE "saved but reads back empty" bug.
        let lastErr = 'vault read failed';
        for (let attempt = 0; attempt < 4; attempt++) {
          const resp = await callTool('get_vault_record', { recordType: resource });
          const out = (await resp.json().catch(() => ({}))) as { ok?: boolean; data?: T | null; error?: string };
          if (!resp.ok) throw new Error(out.error ?? `vault read failed (${resp.status})`);
          if (out.ok === false) { lastErr = out.error ?? 'vault read unauthorized'; if (attempt < 3) { await new Promise((r) => setTimeout(r, 120)); continue; } throw new Error(lastErr); }
          return out.data === null || out.data === undefined ? null : { data: out.data };
        }
        throw new Error(lastErr);
      },
      // spec 315 — enumerate the owner's OWN vault record types. demo-mcp's list_vault_record is
      // record-scope-FILTERED to the interactions grant, so this returns ONLY the Home-managed records
      // (app-specific records under other grants stay invisible — least-privilege). Bare record types.
      async list(): Promise<Array<{ resource: string; updatedAt: string }>> {
        const resp = await callTool('list_vault_record', {});
        const out = (await resp.json().catch(() => ({}))) as { ok?: boolean; records?: Array<{ record_type: string; updated_at: string }>; error?: string };
        if (!resp.ok || out.ok === false) throw new Error(out.error ?? `vault list failed (${resp.status})`);
        return (out.records ?? []).map((r) => ({ resource: r.record_type, updatedAt: r.updated_at }));
      },
    } as unknown as Vault;
  }

  private async readDoc<T>(grant: IncomingDelegation, resource: string, empty: T): Promise<T> {
    const r = await this.vaultFor(grant).read<T>({ owner: '', resource });
    return (r?.data as T) ?? empty;
  }

  private async writeDoc(grant: IncomingDelegation, resource: string, data: unknown): Promise<void> {
    await this.vaultFor(grant).write({ owner: '', resource, data, classification: 'internal' } as never);
  }

  /** GATE-TIME listing verification (spec 322 §4): current + ERC-1271-proven + not tombstoned. */
  private async memberName(grant: IncomingDelegation, principal: string, sessionSaCaip: string): Promise<string | null> {
    const rows = await this.readDoc<IndexedListing[]>(grant, DIRECTORY_RESOURCE, []);
    const me = sessionSaCaip.toLowerCase();
    const now = new Date().toISOString();
    const mine = rows.find((l) => l.listing.subject.toLowerCase() === me && isListingCurrent(l.listing, now));
    if (!mine) return null;
    const st = ((await this.state.storage.get('state')) ?? {}) as StoredState;
    if (st.subjects?.[me]?.tombstoned) return null;
    const { proof, ...draft } = mine.listing;
    const digest = await sha256Hex32(canonicalizeMessage(draft));
    const subjectAddr = mine.listing.subject.match(/0x[0-9a-fA-F]{40}$/)?.[0] as Address | undefined;
    if (!subjectAddr || !(await this.erc1271(subjectAddr, digest as Hex, proof.signature as Hex))) return null;
    void principal;
    return mine.listing.displayName;
  }

  /** Does the wire carry the STEWARDSHIP shape, not a data grant? (SEC-C1). A stewardship/site
   *  delegation (`buildApprovedSiteDelegation`) carries an `allowedTargetsEnforcer` caveat (governance
   *  targets: agent-relationship / naming / registry) and NEVER a vault-record-scope caveat. Every
   *  org→person DATA grant — member-access, membership, delivery, interactions — instead carries a
   *  VAULT_RECORD_SCOPE_ENFORCER caveat. Requiring the governance caveat AND rejecting the scope
   *  caveat separates a steward from a member: without this, a member's own org→member member-access
   *  delegation (same delegator=org, delegate=member, org-signed, unrevoked) passed as a steward
   *  proof → member→steward escalation (kick members, dump the ledger, act as steward). */
  private hasStewardshipShape(wire: IncomingDelegation): boolean {
    // NEW-H2 — FAIL CLOSED on an unconfigured enforcer. If ALLOWED_TARGETS_ENFORCER is unset (wrangler
    // binds "" for a placeholder var), the old `enforcer(c) === ''` matched ANY caveat with a missing/empty
    // enforcer → a record-scoped member wire (with a blank-enforcer caveat) would pass as stewardship
    // (member→steward escalation). A stewardship wire is unrecognizable without the real governance-targets
    // address, so no address ⇒ no stewardship.
    const targetEnforcer = (this.env.ALLOWED_TARGETS_ENFORCER ?? '').toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(targetEnforcer)) return false;
    const caveats = wire.caveats ?? [];
    const enforcer = (c: { enforcer?: string }): string => (c.enforcer ?? '').toLowerCase();

    // STEWARD-SHAPE-CONFUSION-1 — stewardship must be a POSITIVE identity, not "allowedTargets present ∧ no
    // record-scope". Payment mandates ([payment, timestamp, allowedTargets, allowedMethods]) and A2A message
    // grants ([timestamp, allowedTargets, allowedMethods]) ALSO carry allowedTargets and no record-scope, so
    // the old negative test accepted any of them as a steward proof → member/outsider → steward escalation
    // (the SEC-C1 hole reached through a different wire shape). The genuine steward/site wire
    // (`buildSiteDelegation`/`siteCaveats`): carries NO allowedMethods and NO record-scope caveat, AND its
    // allowedTargets terms pin the GOVERNANCE contracts (agentRelationship + agentNameRegistry + subregistry).
    // A payment mandate targets an asset; an a2a grant targets the recipient agent — neither names the
    // governance registries — and both add allowedMethods, so both are rejected here.
    const methodsEnforcer = (this.env.ALLOWED_METHODS_ENFORCER ?? '').toLowerCase();
    if (methodsEnforcer && caveats.some((c) => enforcer(c) === methodsEnforcer)) return false; // a2a grant / payment mandate
    if (caveats.some((c) => enforcer(c) === VAULT_RECORD_SCOPE_ENFORCER.toLowerCase())) return false; // data grant (SEC-C1)

    const rel = (this.env.AGENT_RELATIONSHIP ?? '').toLowerCase();
    const reg = (this.env.AGENT_NAME_REGISTRY ?? '').toLowerCase();
    // Fail closed if we can't positively identify the governance targets (prod injects both; org-create
    // already depends on them). No governance anchor ⇒ no stewardship.
    if (!/^0x[0-9a-f]{40}$/.test(rel) || !/^0x[0-9a-f]{40}$/.test(reg)) return false;
    const targetsCav = caveats.find((c) => enforcer(c) === targetEnforcer);
    if (!targetsCav?.terms) return false;
    let targets: string[];
    try {
      targets = (decodeAbiParameters([{ type: 'address[]' }], targetsCav.terms as Hex)[0] as readonly Address[]).map((a) => a.toLowerCase());
    } catch { return false; }
    // The site wire pins [agentRelationship, agentNameRegistry, subregistry]; require BOTH registries to be
    // present so a wire whose allowedTargets name anything else (asset, agent SA, host endpoint) is not
    // stewardship.
    return targets.includes(rel) && targets.includes(reg);
  }

  /** Organization-resource-access proof (SEC-H1): a presented org→member organizationResourceAccessDelegation wire — the ORG's
   *  authorization that this person may join (minted at invite time, `issueMemberAccessDelegation`).
   *  delegator = the org (this principal), delegate = the caller, org-signed + unrevoked, AND
   *  carrying the DATA-grant shape (a vault-record-scope caveat) so a governance/stewardship wire
   *  can't be replayed here. Without it a self-signed listing alone made anyone a member of any org
   *  (self-join → read its private channels). */
  private async hasMemberAccess(principal: string, sessionSa: Address, wire: IncomingDelegation | undefined): Promise<boolean> {
    if (!wire) return false;
    if (wire.delegator.toLowerCase() !== principal.toLowerCase()) return false;
    if (wire.delegate.toLowerCase() !== sessionSa.toLowerCase()) return false;
    const hasRecordScope = (wire.caveats ?? []).some((c) => (c.enforcer ?? '').toLowerCase() === VAULT_RECORD_SCOPE_ENFORCER.toLowerCase());
    if (!hasRecordScope) return false; // a stewardship/governance wire is not member-access
    const d: Delegation = { ...wire, salt: BigInt(wire.salt), caveats: wire.caveats.map((c) => ({ enforcer: c.enforcer, terms: c.terms, args: (c.args ?? '0x') as Hex })) } as Delegation;
    const digest = hashDelegation(d, Number(this.env.CHAIN_ID ?? 84532), this.env.DELEGATION_MANAGER as Address);
    if (!(await this.erc1271(wire.delegator as Address, digest, wire.signature as Hex))) return false;
    try {
      const revoked = (await this.pub().readContract({ address: this.env.DELEGATION_MANAGER as Address, abi: IS_REVOKED_ABI, functionName: 'isRevoked', args: [digest] })) as boolean;
      return !revoked;
    } catch { return false; }
  }

  /** Steward proof: a presented org→person organizationStewardshipDelegation wire, org-verified + unrevoked on-chain, AND
   *  carrying the stewardship caveat shape (SEC-C1 — never a data grant). */
  private async isSteward(principal: string, sessionSa: Address, wire: IncomingDelegation | undefined): Promise<boolean> {
    if (!wire) return false;
    if (wire.delegator.toLowerCase() !== principal.toLowerCase()) return false;
    if (wire.delegate.toLowerCase() !== sessionSa.toLowerCase()) return false;
    if (!this.hasStewardshipShape(wire)) return false; // SEC-C1: a member-access grant is NOT stewardship
    const d: Delegation = { ...wire, salt: BigInt(wire.salt), caveats: wire.caveats.map((c) => ({ enforcer: c.enforcer, terms: c.terms, args: (c.args ?? '0x') as Hex })) } as Delegation;
    const digest = hashDelegation(d, Number(this.env.CHAIN_ID ?? 84532), this.env.DELEGATION_MANAGER as Address);
    if (!(await this.erc1271(wire.delegator as Address, digest, wire.signature as Hex))) return false;
    try {
      const revoked = (await this.pub().readContract({ address: this.env.DELEGATION_MANAGER as Address, abi: IS_REVOKED_ABI, functionName: 'isRevoked', args: [digest] })) as boolean;
      return !revoked;
    } catch { return false; } // fail-closed on chain-read failure
  }


  /** Does the stored grant cover the CURRENT wave's scope set? Stale ⇒ steward re-enables. */
  private grantIsCurrent(grant: IncomingDelegation): boolean {
    const cav = (grant.caveats ?? []).find((c) => (c.enforcer ?? '').toLowerCase() === VAULT_RECORD_SCOPE_ENFORCER.toLowerCase());
    if (!cav?.terms) return false;
    try {
      const resources = new Set(decodeVaultRecordScopeTerms(cav.terms as Hex).flatMap((g) => g.resources));
      return REQUIRED_SCOPES.every((r) => resources.has(r));
    } catch { return false; }
  }

  /** Bridge-HMAC gate for the Home-server channel (SEC-010 envelope; audience pins the op). */
  private async bridgeGate(request: Request, rawBody: string, op: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    const secret = this.env.A2A_CUSTODY_BRIDGE_SECRET;
    const kv = this.env.BRIDGE_NONCES;
    if (!secret || !kv) return { ok: false, reason: 'bridge not configured' };
    const nonces: NonceStore = nonceStoreFromKv(kv);
    return verifyBridgeCall({ request, rawBody, secret, expectedAudience: `interactions.${op}`, nonces });
  }

  /** spec 323 W4 — the PORTABLE gate for owner-facing residency ops: the OWNER's broker session
   *  (verifyHomeSession, session SA === principal) is accepted DIRECTLY, so ANY Home holding the
   *  owner's session drives them with NO shared bridge secret. Caller-selected (not a fallback,
   *  ADR-0013): a request that carries `session` takes the Web3-authenticated owner path; one that
   *  carries the SEC-010 envelope instead takes the incumbent demo-a2a↔Home server transport. Each
   *  fails closed. (Non-owner-facing ops — invite.* — stay bridge-only: they are org-steward /
   *  token-redeem substrate flows, not the owner acting on their own records.) */
  private async ownerOrBridge(request: Request, rawBody: string, op: string, principal: string, session: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (session) {
      const g = await verifyHomeSession(session, this.env);
      if (!g.ok) return { ok: false, reason: g.error };
      if (g.sa.toLowerCase() !== principal) return { ok: false, reason: 'these records belong to the principal — self access only' };
      return { ok: true };
    }
    return this.bridgeGate(request, rawBody, op);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean); // interactions/<principal>/<op>
    const principal = (parts[1] ?? '').toLowerCase();
    const op = parts[2] ?? '';
    if (!/^0x[0-9a-fA-F]{40}$/.test(principal)) return json({ error: 'bad principal' }, 400);
    const rawBody = await request.text();
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(rawBody) as Record<string, unknown>; } catch { /* empty body ok */ }

    // ── Grant custody (plane B): the Worker pre-verifies the steward session + delegator match. ──
    if (op === 'grant' && request.method === 'POST') {
      const wire = body.delegation as IncomingDelegation | undefined;
      if (!wire?.signature || wire.delegator.toLowerCase() !== principal) return json({ error: 'delegation with delegator = principal required' }, 400);
      // Verify the wire IS the principal's before storing (junk-overwrite DoS guard): ERC-1271 over
      // the delegation digest against the delegator (approved-hash 0x03 wires validate through the
      // SA's approved-hash branch). Fail-closed: an unverifiable grant is never stored.
      const d: Delegation = { ...wire, salt: BigInt(wire.salt), caveats: wire.caveats.map((c) => ({ enforcer: c.enforcer, terms: c.terms, args: (c.args ?? '0x') as Hex })) } as Delegation;
      const digest = hashDelegation(d, Number(this.env.CHAIN_ID ?? 84532), this.env.DELEGATION_MANAGER as Address);
      if (!(await this.erc1271(wire.delegator as Address, digest, wire.signature as Hex))) {
        return json({ error: 'grant signature failed verification against the delegator' }, 403);
      }
      // NEW-H6 (Phase B): pin the delegate to the configured interactions service SA. `vaultFor` runs every
      // op as requester=grant.delegate, so a grant issued to any OTHER delegate would route the principal's
      // entire vault surface through the wrong delegate. Inert until provisioned (INTERACTIONS_SERVICE_SA
      // unset ⇒ no pin, the pre-Phase-B behavior).
      const expectedInteractionsSa = (this.env.INTERACTIONS_SERVICE_SA ?? '').toLowerCase();
      if (/^0x[0-9a-f]{40}$/.test(expectedInteractionsSa) && wire.delegate.toLowerCase() !== expectedInteractionsSa) {
        return json({ error: 'grant delegate must be the configured interactions service SA (NEW-H6)' }, 403);
      }
      const st = ((await this.state.storage.get('state')) ?? {}) as StoredState;
      st.grant = wire;
      // NEW-C1 — custody the PRINCIPAL-signed DEL-001 session leaf (principal → interactions-session key), if
      // supplied. Verify it ERC-1271 against the principal (== grant delegator) so the DO never bound-mints
      // with a junk leaf; demo-mcp re-checks the binding at enforceBinding. Absent ⇒ server-mint bridge.
      const leafWire = body.sessionLeaf as IncomingDelegation | undefined;
      if (leafWire?.signature) {
        if (leafWire.delegator.toLowerCase() !== wire.delegator.toLowerCase()) {
          return json({ error: 'session leaf delegator must equal the grant delegator (the principal) — NEW-C1' }, 400);
        }
        const ld: Delegation = { ...leafWire, salt: BigInt(leafWire.salt), caveats: leafWire.caveats.map((c) => ({ enforcer: c.enforcer, terms: c.terms, args: (c.args ?? '0x') as Hex })) } as Delegation;
        const ldigest = hashDelegation(ld, Number(this.env.CHAIN_ID ?? 84532), this.env.DELEGATION_MANAGER as Address);
        if (!(await this.erc1271(leafWire.delegator as Address, ldigest, leafWire.signature as Hex))) {
          return json({ error: 'session leaf signature failed verification against the principal (NEW-C1)' }, 403);
        }
        st.sessionLeaf = leafWire;
      }
      // Ledger row (W3e): hash + delegate + decoded resources — never the wire (bearer secret).
      let resources: string[] = [];
      try {
        const cav = wire.caveats.find((c) => (c.enforcer ?? '').toLowerCase() === VAULT_RECORD_SCOPE_ENFORCER.toLowerCase());
        if (cav?.terms) resources = decodeVaultRecordScopeTerms(cav.terms as Hex).flatMap((g) => g.resources);
      } catch { /* undecodable scopes → empty resources row; the currency gate handles enforcement */ }
      st.ledger = [...(st.ledger ?? []), { hash: digest, delegate: wire.delegate.toLowerCase(), resources, storedAt: new Date().toISOString() }].slice(-50);
      await this.state.storage.put('state', st);
      return json({ ok: true });
    }
    // spec 323 W3 — custody the write-only DELIVERY wire in the DO (verified like /grant). Same
    // ERC-1271-against-delegator junk-guard; the wire never returns to any app.
    if (op === 'grant.delivery.put' && request.method === 'POST') {
      const wire = body.delegation as IncomingDelegation | undefined;
      if (!wire?.signature || wire.delegator.toLowerCase() !== principal) return json({ error: 'delivery delegation with delegator = principal required' }, 400);
      const d: Delegation = { ...wire, salt: BigInt(wire.salt), caveats: wire.caveats.map((c) => ({ enforcer: c.enforcer, terms: c.terms, args: (c.args ?? '0x') as Hex })) } as Delegation;
      const digest = hashDelegation(d, Number(this.env.CHAIN_ID ?? 84532), this.env.DELEGATION_MANAGER as Address);
      if (!(await this.erc1271(wire.delegator as Address, digest, wire.signature as Hex))) return json({ error: 'delivery grant signature failed verification against the delegator' }, 403);
      // NEW-H6 (Phase B): pin the delivery delegate to the configured delivery service SA (inert until provisioned).
      const expectedDeliverySa = (this.env.DELIVERY_SERVICE_SA ?? '').toLowerCase();
      if (/^0x[0-9a-f]{40}$/.test(expectedDeliverySa) && wire.delegate.toLowerCase() !== expectedDeliverySa) {
        return json({ error: 'delivery grant delegate must be the configured delivery service SA (NEW-H6)' }, 403);
      }
      const st = ((await this.state.storage.get('state')) ?? {}) as StoredState;
      st.deliveryGrant = wire;
      st.ledger = [...(st.ledger ?? []), { hash: digest, delegate: wire.delegate.toLowerCase(), resources: ['(delivery:write-only)'], storedAt: new Date().toISOString() }].slice(-50);
      await this.state.storage.put('state', st);
      return json({ ok: true });
    }
    if (op === 'status') {
      const st = ((await this.state.storage.get('state')) ?? {}) as StoredState;
      return json({ ok: true, granted: !!st.grant, current: !!st.grant && this.grantIsCurrent(st.grant), deliveryGranted: !!st.deliveryGrant });
    }

    // ── 1-1 inbox residency (spec 322 W3f) — the Home-server channel + in-Worker delivery. ──
    // The Home reaches this principal's mail ONLY here (bridge-HMAC-authenticated, the same SEC-010
    // envelope as the custody bridge); the a2a messaging skills merge deliveries here in-Worker
    // (`internal.deliver` — the public route refuses `internal.*`, so only Worker code reaches it).
    // The standing DELIVERY grant is write-only: it can no longer read anyone's mail.
    if (op === 'inbox.get' || op === 'inbox.put' || op === 'inbox.body.get' || op === 'internal.deliver' || op === 'internal.dm.body.put' || op === 'controlevents.append' || op === 'dm.body.put' || op === 'invite.get' || op === 'invite.put' || op === 'applications.get' || op === 'applications.put') {
      // Owner-facing residency ops accept the OWNER's session OR the bridge (spec 323 W4 — a portable
      // Home needs no secret). invite.* are substrate steward/redeem flows → bridge only. internal.*
      // are in-Worker (a2a deliver skill) → no external gate.
      const OWNER_FACING = op === 'inbox.get' || op === 'inbox.put' || op === 'inbox.body.get' || op === 'controlevents.append' || op === 'dm.body.put';
      if (op === 'internal.deliver' || op === 'internal.dm.body.put') {
        // ARCH-H2 — the public router refuses internal.*, but the DO must NOT trust that alone.
        // Require an internal marker only in-Worker callers can supply (the bridge secret, shared by
        // co-resident DOs in this Worker). Any other path reaching internal.* fails closed.
        const secret = this.env.A2A_CUSTODY_BRIDGE_SECRET;
        if (!secret || request.headers.get('x-ap-internal') !== secret) return json({ error: 'internal op — not authorized' }, 403);
      } else {
        const bg = OWNER_FACING
          ? await this.ownerOrBridge(request, rawBody, op, principal, String(body.session ?? ''))
          : await this.bridgeGate(request, rawBody, op);
        if (!bg.ok) return json({ error: `unauthorized: ${bg.reason}` }, 401);
      }
      const st0 = ((await this.state.storage.get('state')) ?? {}) as StoredState;
      const g = st0.grant;
      if (!g) return json({ error: 'no interactions grant — enable interactions for this agent first' }, 409);
      if (!this.grantIsCurrent(g)) return json({ error: 'interactions grant is stale — re-enable (scope widened this wave)' }, 409);
      try {
        if (op === 'inbox.get') {
          const doc = await this.readDoc<unknown>(g, INBOX_RESOURCE, null);
          return json({ ok: true, doc });
        }
        if (op === 'inbox.put') {
          if (body.doc === undefined) return json({ error: 'doc required' }, 400);
          await this.writeDoc(g, INBOX_RESOURCE, body.doc);
          return json({ ok: true });
        }
        if (op === 'applications.get') {
          const doc = await this.readDoc<unknown>(g, APPLICATIONS_RESOURCE, { applications: [] });
          return json({ ok: true, doc });
        }
        if (op === 'applications.put') {
          if (body.doc === undefined) return json({ error: 'doc required' }, 400);
          await this.writeDoc(g, APPLICATIONS_RESOURCE, body.doc);
          return json({ ok: true });
        }
        if (op === 'inbox.body.get') {
          // dm-namespace ONLY — the bridge cannot be aimed at arbitrary vault records (the grant's
          // record scope enforces the same bound at the vault; this is the belt to that suspender).
          const resource = String(body.resource ?? '');
          if (!resource.startsWith(DM_BODY_PREFIX)) return json({ error: 'dm body resources only' }, 400);
          const r = await this.vaultFor(g).read<unknown>({ owner: '', resource });
          return json({ ok: true, record: r?.data ?? null });
        }
        if (op === 'invite.get' || op === 'invite.put') {
          // spec 323 W3.2 — the org's invite records (`org.invite:*`) read/written via the DO-held
          // delivery wire (its r+w scope covers org.invite); replaces orgVault's KV-wire transport so
          // the Home stores no org wire either. Namespace-pinned belt to the wire's own record scope.
          const dg = st0.deliveryGrant;
          if (!dg) return json({ error: 'no delivery grant — enable storage for this org first' }, 409);
          const resource = String(body.resource ?? '');
          if (!resource.startsWith('org.invite:')) return json({ error: 'org.invite resources only' }, 400);
          if (op === 'invite.get') {
            const r = await this.vaultFor(dg).read<unknown>({ owner: '', resource });
            return json({ ok: true, record: r?.data ?? null });
          }
          if (body.data === undefined) return json({ error: 'data required' }, 400);
          await this.vaultFor(dg).write({ owner: '', resource, data: body.data, classification: 'internal' } as never);
          return json({ ok: true });
        }
        if (op === 'dm.body.put' || op === 'internal.dm.body.put') {
          // spec 323 W3 — dm body WRITE via the DO-held DELIVERY wire (the only wire scoped to write
          // dm bodies). `dm.body.put` = the Home's split-plane writer over the bridge; the in-Worker
          // `internal.dm.body.put` is the a2a deliver skill. dm-namespace pinned (belt to the wire's
          // own write-only record scope).
          const dg = st0.deliveryGrant;
          if (!dg) return json({ error: 'no delivery grant — enable inbox delivery for this agent first' }, 409);
          const resource = String(body.resource ?? '');
          if (!resource.startsWith(DM_BODY_PREFIX)) return json({ error: 'dm body resources only' }, 400);
          if (body.data === undefined) return json({ error: 'data required' }, 400);
          // DM-BODY-OVERWRITE-1 — the resource id is sender-controlled beyond the dm: prefix and the write is
          // last-writer-wins. A sender who knows an existing message id could overwrite that slot with a body
          // whose hash no longer matches the persisted envelope's bodyHash → the recipient's loadBody sees a
          // hash mismatch and silently drops the message (per-message censorship). DM bodies are write-once:
          // reject an overwrite whose bodyHash differs (an idempotent same-hash re-delivery still succeeds).
          const incomingHash = (body.data as { bodyHash?: string } | null)?.bodyHash;
          // ADR-0013 — do NOT swallow a soft-failed read into "no record": a transient auth/RPC error would then
          // re-open the write-once overwrite this guards (per-message censorship). `read` returns null ONLY for a
          // genuine-absent body (it bounded-retries transients and throws on auth/decrypt failure); let a real
          // failure fail the write CLOSED rather than silently permit an overwrite.
          const existing = await this.vaultFor(dg).read<{ bodyHash?: string }>({ owner: '', resource });
          if (existing?.data?.bodyHash && incomingHash && existing.data.bodyHash !== incomingHash) {
            return json({ error: 'dm body already exists with a different hash — bodies are write-once' }, 409);
          }
          await this.vaultFor(dg).write({ owner: '', resource, data: body.data, classification: 'internal' } as never);
          return json({ ok: true });
        }
        if (op === 'controlevents.append') {
          // spec 323 W2.3 — the person's portable control-plane timeline (`control-events.data`),
          // append-only under the single writer. Server flows (inbox decisions, manifest publish)
          // append via the SEC-010 bridge; the person READS their own via record.get (session-gated).
          const event = body.event;
          if (event === undefined || event === null) return json({ error: 'event required' }, 400);
          return this.serialize(async () => { // ARCH-H1 — serialize the timeline append (many server flows)
            const rows = await this.readDoc<unknown[]>(g, CONTROL_EVENTS_RESOURCE, []);
            rows.push(event);
            await this.writeDoc(g, CONTROL_EVENTS_RESOURCE, rows.slice(-CONTROL_EVENTS_CAP));
            return json({ ok: true });
          });
        }
        // internal.deliver — append-only merge of a validated envelope (the skill already verified
        // addressing + bodyHash and persisted the body under the delivery grant).
        const envelope = body.envelope as MessageEnvelopeV1 | undefined;
        if (!envelope?.id) return json({ error: 'envelope required' }, 400);
        return this.serialize(async () => { // ARCH-H1 — serialize the inbox merge (many senders → one inbox)
          const doc = (await this.readDoc<Record<string, unknown>>(g, INBOX_RESOURCE, null as never)) ?? { version: 1, envelopes: [], events: [], draftCases: [], caseEvents: [], cards: {} };
          const envs = (doc.envelopes as MessageEnvelopeV1[] | undefined) ?? [];
          if (!envs.some((e) => e.id === envelope.id)) {
            doc.envelopes = [...envs, envelope];
            doc.events = [
              ...((doc.events as unknown[] | undefined) ?? []),
              { version: 'ap.message.event.v1', messageId: envelope.id, actor: envelope.from, eventType: 'delivered', at: new Date().toISOString() },
            ];
            await this.writeDoc(g, INBOX_RESOURCE, doc);
          }
          return json({ ok: true, messageId: envelope.id });
        });
      } catch (e) {
        return json({ error: e instanceof Error ? e.message : String(e) }, 409);
      }
    }

    // ── Skills — caller = broker-verified Home session (any principal kind). ──
    const gate = await verifyHomeSession(String(body.session ?? ''), this.env);
    if (!gate.ok) return json({ error: gate.error }, gate.status);
    const sessionSa = gate.sa;
    const sessionCaip = gate.caip;

    const st = ((await this.state.storage.get('state')) ?? {}) as StoredState;
    const grant = st.grant;
    if (!grant) return json({ error: 'no interactions grant — a steward must enable storage for this agent' }, 409);
    if (!this.grantIsCurrent(grant)) return json({ error: 'interactions grant is stale — a steward must re-enable storage (scope widened this wave)' }, 409);
    const audit = buildAuditSink(this.env);

    try {
      if (op === 'directory.publish') {
        const listing = body.listing as DirectoryListingV1 | undefined;
        if (!listing) return json({ error: 'listing required' }, 400);
        const errors = validateDirectoryListing(listing);
        if (errors.length > 0) return json({ error: `invalid listing: ${errors.join(', ')}` }, 400);
        if (listing.subject.toLowerCase() !== sessionCaip.toLowerCase()) {
          // A steward publishing ANOTHER subject's ORG listing (spec 313 §4 Networks): the presented
          // stewardship wire must be delegated BY the listing subject to the session SA.
          const subjAddr = listing.subject.match(/0x[0-9a-fA-F]{40}$/)?.[0];
          const w = body.subjectStewardship as IncomingDelegation | undefined;
          const ok = !!subjAddr && (await this.isSteward(subjAddr, sessionSa, w));
          if (!ok) return json({ error: 'listing subject must be the session principal (or present its stewardship wire)' }, 403);
          // DIR-INJECT-1 — proving you steward the SUBJECT is NOT enough: `principal` here is the DIRECTORY
          // OWNER (this org shard) and `listing.context.id`/communityId is caller-chosen, so without this
          // check any steward of any org could inject their org's card into an arbitrary victim org's
          // membership index (the doc `memberName` trusts) — the SEC-H1 self-publish gate reached through the
          // cross-subject branch. The directory OWNER must also have authorized this caller.
          const ownerAuthorized =
            (await this.isSteward(principal, sessionSa, body.stewardship as IncomingDelegation | undefined)) ||
            (await this.hasMemberAccess(principal, sessionSa, body.memberAccess as IncomingDelegation | undefined));
          if (!ownerAuthorized) return json({ error: 'this organization has not authorized you to publish listings into its directory' }, 403);
        } else {
          // SELF-publish (join / update own listing). SEC-H1: a self-signed listing is NOT enough —
          // the ORG must have authorized this member. Require the org→you member-access grant (from an
          // invite), OR prove you steward this org (the creator's / steward's own self-card).
          const authorized =
            (await this.hasMemberAccess(principal, sessionSa, body.memberAccess as IncomingDelegation | undefined)) ||
            (await this.isSteward(principal, sessionSa, body.stewardship as IncomingDelegation | undefined));
          if (!authorized) return json({ error: 'this organization has not authorized you to join — an invite (member-access grant) or stewardship is required' }, 403);
        }
        const { proof, ...draft } = listing;
        const digest = await sha256Hex32(canonicalizeMessage(draft));
        const proofSubject = (listing.subject.match(/0x[0-9a-fA-F]{40}$/)?.[0] ?? sessionSa) as Address;
        if (!(await this.erc1271(proofSubject, digest as Hex, proof.signature as Hex))) return json({ error: 'listing signature failed ERC-1271 verification' }, 403);
        // DIR-INJECT-1 — the replay/tombstone/dedup key is the LISTING SUBJECT, not the caller session. For a
        // self-publish these are equal; for a steward-of-subject publish they differ, and keying on the caller
        // let a tombstoned (subject-keyed) listing be re-injected and duplicate subject rows accumulate.
        const me = listing.subject.toLowerCase();
        // NEW-M1 (ARCH-H1 residual) — the directory doc + st.subjects RMW is a shared-doc write across
        // concurrent joins; serialize it (re-reading both inside the lock) so two simultaneous joins can't
        // lost-update each other's listing. The expensive ERC-1271 proof stays outside the lock.
        return this.serialize(async () => {
          const fresh = ((await this.state.storage.get('state')) ?? {}) as StoredState;
          // Replay guard: monotonic publishedAt per subject; publishing clears any tombstone (rejoin).
          const prev = fresh.subjects?.[me]?.publishedAt;
          if (prev && Date.parse(listing.publishedAt) <= Date.parse(prev)) return json({ error: 'stale listing (publishedAt must be monotonic)' }, 409);
          const rows = (await this.readDoc<IndexedListing[]>(grant, DIRECTORY_RESOURCE, [])).filter((l) => l.listing.subject.toLowerCase() !== me);
          rows.push({ listing, label: String(body.label ?? '') });
          await audit.write({ id: crypto.randomUUID(), timestamp: new Date().toISOString(), action: 'interactions.directory.publish', outcome: 'success', actor: { type: 'user', id: sessionSa }, subject: { type: 'listing', id: me } });
          await this.writeDoc(grant, DIRECTORY_RESOURCE, rows);
          fresh.subjects = { ...(fresh.subjects ?? {}), [me]: { publishedAt: listing.publishedAt } };
          await this.state.storage.put('state', fresh);
          return json({ ok: true });
        });
      }

      if (op === 'directory.revoke') {
        const me = sessionCaip.toLowerCase();
        const rows = (await this.readDoc<IndexedListing[]>(grant, DIRECTORY_RESOURCE, [])).filter((l) => l.listing.subject.toLowerCase() !== me);
        await audit.write({ id: crypto.randomUUID(), timestamp: new Date().toISOString(), action: 'interactions.directory.revoke', outcome: 'success', actor: { type: 'user', id: sessionSa }, subject: { type: 'listing', id: me } });
        await this.writeDoc(grant, DIRECTORY_RESOURCE, rows);
        st.subjects = { ...(st.subjects ?? {}), [me]: { publishedAt: st.subjects?.[me]?.publishedAt ?? new Date().toISOString(), tombstoned: true } };
        await this.state.storage.put('state', st);
        return json({ ok: true });
      }

      if (op === 'directory.remove') {
        // STEWARD removal of another member's listing (spec 321 W3 continuity under the DO): the
        // caller presents the stewardship wire; the subject's listing is dropped + tombstoned so a
        // replayed old listing cannot re-enter (spec 322 §4).
        const steward = await this.isSteward(principal, sessionSa, body.stewardship as IncomingDelegation | undefined);
        if (!steward) return json({ error: 'stewardship proof required' }, 403);
        const subject = String(body.subject ?? '').toLowerCase();
        if (!subject) return json({ error: 'subject required' }, 400);
        const rows = (await this.readDoc<IndexedListing[]>(grant, DIRECTORY_RESOURCE, [])).filter((l) => !l.listing.subject.toLowerCase().endsWith(subject));
        await audit.write({ id: crypto.randomUUID(), timestamp: new Date().toISOString(), action: 'interactions.directory.remove', outcome: 'success', actor: { type: 'user', id: sessionSa }, subject: { type: 'listing', id: subject } });
        await this.writeDoc(grant, DIRECTORY_RESOURCE, rows);
        const key = Object.keys(st.subjects ?? {}).find((k) => k.endsWith(subject)) ?? subject;
        st.subjects = { ...(st.subjects ?? {}), [key]: { publishedAt: st.subjects?.[key]?.publishedAt ?? new Date().toISOString(), tombstoned: true } };
        await this.state.storage.put('state', st);
        return json({ ok: true });
      }

      if (op === 'directory.list') {
        const name = await this.memberName(grant, principal, sessionCaip);
        const steward = await this.isSteward(principal, sessionSa, body.stewardship as IncomingDelegation | undefined);
        if (!name && !steward) return json({ error: 'join this community first — publish a directory listing to enter' }, 403);
        const now = new Date().toISOString();
        const rows = (await this.readDoc<IndexedListing[]>(grant, DIRECTORY_RESOURCE, [])).filter((l) => isListingCurrent(l.listing, now));
        return json({ ok: true, listings: rows });
      }

      if (op === 'channels.list' || op === 'channels.read') {
        const name = await this.memberName(grant, principal, sessionCaip);
        const steward = await this.isSteward(principal, sessionSa, body.stewardship as IncomingDelegation | undefined);
        if (!name && !steward) return json({ error: 'join this community first — publish a directory listing to enter its channels' }, 403);
        // Conversation/topic split (§10): descriptors from conversation.index; ONE topic's messages from its own doc.
        const index = await this.readDoc<ChannelV1[]>(grant, CONVERSATION_INDEX_RESOURCE, []);
        const bodies: Record<string, string> = {};
        // spec 324 §10 — a viewer sees public topics + only the private topics they're a member of (steward sees all).
        let wire = index
          .filter((c) => canSeeChannel(c, sessionSa, steward))
          .map((c) => ({ ...c, messages: [] as { envelope: MessageEnvelopeV1; authorName: string }[] }));
        if (op === 'channels.read' && typeof body.channelId === 'string') {
          const messages = await this.readDoc<{ envelope: MessageEnvelopeV1; authorName: string }[]>(grant, TOPIC_RESOURCE(body.channelId), []);
          wire = wire.map((c) => (c.descriptor.id === body.channelId ? { ...c, messages } : c));
          const store = createVaultMessageBodyStore(this.vaultFor(grant), principal);
          await Promise.all(messages.map(async (m) => {
            // Bodies load at the envelope's OWN resource (channel namespace) — never re-normalized.
            try { bodies[m.envelope.id] = new TextDecoder().decode(await store.loadBody(m.envelope)); } catch { /* fail-closed omit */ }
          }));
        }
        return json({ ok: true, channels: wire, bodies, you: name ?? 'Steward', steward });
      }

      if (op === 'channels.create') {
        const name = await this.memberName(grant, principal, sessionCaip);
        const steward = await this.isSteward(principal, sessionSa, body.stewardship as IncomingDelegation | undefined);
        if (!name && !steward) return json({ error: 'join this community first — publish a directory listing to enter its channels' }, 403);
        return this.serialize(async () => { // ARCH-H1 — the conversation.index RMW is a shared-doc write; serialize it too
          const index = await this.readDoc<ChannelV1[]>(grant, CONVERSATION_INDEX_RESOURCE, []);
          const r = createBoardChannel(index, {
            contextId: principal, owner: sessionCaip as ChannelV1['descriptor']['owner'], title: String(body.title ?? ''), createdBy: name ?? 'Steward',
            // spec 324 §10 — public (default) or private-to-a-member-subset; the creator is always a member.
            visibility: body.visibility === 'private' ? 'private' : 'public',
            members: Array.isArray(body.members) ? (body.members as unknown[]).map((m) => String(m)) : [],
            creatorSa: sessionSa,
          });
          if (!r.ok) return json({ error: r.error }, r.error.includes('already exists') ? 409 : 400);
          await audit.write({ id: crypto.randomUUID(), timestamp: new Date().toISOString(), action: 'interactions.channels.create', outcome: 'success', actor: { type: 'user', id: sessionSa }, subject: { type: 'channel', id: r.channel.descriptor.id } });
          await this.writeDoc(grant, CONVERSATION_INDEX_RESOURCE, index); // index holds descriptors only (messages stay [])
          return json({ ok: true, channelId: r.channel.descriptor.id });
        });
      }

      if (op === 'channels.post') {
        const name = await this.memberName(grant, principal, sessionCaip);
        if (!name) return json({ error: 'join this community first — publish a directory listing to enter its channels' }, 403); // posting = listing members ONLY
        // Board split (W3): only the ONE channel doc is read + rewritten — same-channel conflicts only.
        const channelId = String(body.channelId ?? '');
        return this.serialize(async () => { // ARCH-H1 — serialize the channel append (many members → one channel doc)
          const index = await this.readDoc<ChannelV1[]>(grant, CONVERSATION_INDEX_RESOURCE, []);
          const entry = index.find((c) => c.descriptor.id === channelId);
          if (!entry) return json({ error: 'unknown channel' }, 404);
          // spec 324 §10 — a private topic only admits its own members (the creator is one).
          if (!canSeeChannel(entry, sessionSa)) return json({ error: 'not a member of this private topic' }, 403);
          const messages = await this.readDoc<{ envelope: MessageEnvelopeV1; authorName: string }[]>(grant, TOPIC_RESOURCE(channelId), []);
          const composed: ChannelV1[] = [{ ...entry, messages }];
          const r = await appendBoardPost(composed, { channelId, from: sessionCaip as MessageEnvelopeV1['from'], authorName: name, bodyText: String(body.bodyText ?? '') });
          if (!r.ok) return json({ error: r.error }, r.error === 'unknown channel' ? 404 : 400);
          await audit.write({ id: crypto.randomUUID(), timestamp: r.envelope.createdAt, action: 'interactions.channels.post', outcome: 'success', actor: { type: 'user', id: sessionSa }, subject: { type: 'channel-post', id: r.envelope.id } });
          const store = createVaultMessageBodyStore(this.vaultFor(grant), principal);
          // Channel bodies live in the CHANNEL namespace (the envelope's own resource — closes FAB-SSO-2).
          await store.putBody({ messageId: r.envelope.id, bytes: new TextEncoder().encode(String(body.bodyText ?? '').trim()), contentType: 'text/plain', classification: 'internal', resource: r.envelope.body.resource });
          await this.writeDoc(grant, TOPIC_RESOURCE(channelId), composed[0]!.messages);
          return json({ ok: true, messageId: r.envelope.id });
        });
      }

      if (op === 'grants.list') {
        // Steward-or-self visibility into the issuance ledger (spec 322 W3e).
        const self = sessionSa.toLowerCase() === principal;
        const steward = self ? false : await this.isSteward(principal, sessionSa, body.stewardship as IncomingDelegation | undefined);
        if (!self && !steward) return json({ error: 'stewardship proof required' }, 403);
        return json({ ok: true, grants: st.ledger ?? [] });
      }

      // ── Person-plane ops (spec 322 W3d) — STRICTLY self: the session SA must BE the principal. ──
      if (op === 'relationships.get' || op === 'relationships.merge' || op === 'member.profile.put') {
        if (sessionSa.toLowerCase() !== principal) return json({ error: 'this record belongs to the principal — self access only' }, 403);
        if (op === 'relationships.get') {
          const doc = await this.readDoc<RelationshipsDocV1>(grant, RELATIONSHIPS_RESOURCE, { orgs: {} });
          return json({ ok: true, relationships: doc });
        }
        if (op === 'relationships.merge') {
          const entry = body.entry as Partial<RelationshipEntryV1> | undefined;
          const org = String(entry?.org ?? '').toLowerCase();
          if (!/^0x[0-9a-fA-F]{40}$/.test(org)) return json({ error: 'entry.org (address) required' }, 400);
          const doc = await this.readDoc<RelationshipsDocV1>(grant, RELATIONSHIPS_RESOURCE, { orgs: {} });
          if (body.remove === true) delete doc.orgs[org];
          else {
            const prev = doc.orgs[org];
            doc.orgs[org] = {
              org,
              // steward ⊇ member: a subsequent 'member' merge must NEVER downgrade an existing steward (spec
              // 324 W3 fix — recording the creator as a member was silently stripping their steward inbox
              // control, resolveInboxOwner then 403'd them from their own application queue).
              relationship: entry?.relationship === 'steward' || prev?.relationship === 'steward' ? 'steward' : 'member',
              ...(entry?.orgName ? { orgName: String(entry.orgName) } : {}),
              ...(entry?.kind ? { kind: String(entry.kind) } : prev?.kind ? { kind: prev.kind } : {}),
              ...(entry?.parent ? { parent: String(entry.parent).toLowerCase() } : prev?.parent ? { parent: prev.parent } : {}),
              // spec 324 W3 — provenance back to the authoritative OrganizationMembership Situation.
              ...(entry?.membershipId ? { membershipId: String(entry.membershipId) } : prev?.membershipId ? { membershipId: prev.membershipId } : {}),
              ...(entry?.membershipSituationHash ? { membershipSituationHash: String(entry.membershipSituationHash) } : prev?.membershipSituationHash ? { membershipSituationHash: prev.membershipSituationHash } : {}),
              ...(entry?.enrollmentDecisionRef ? { enrollmentDecisionRef: String(entry.enrollmentDecisionRef) } : prev?.enrollmentDecisionRef ? { enrollmentDecisionRef: prev.enrollmentDecisionRef } : {}),
              ...(entry?.delegationHash ? { delegationHash: String(entry.delegationHash) } : {}),
              // Wires accumulate (a member-access grant may arrive after the membership entry);
              // self-gated op — only the person can place credentials in their own doc.
              ...(Array.isArray(entry?.delegations) || prev?.delegations
                ? { delegations: [...(prev?.delegations ?? []), ...((entry?.delegations as IncomingDelegation[] | undefined) ?? [])].slice(-8) }
                : {}),
              updatedAt: new Date().toISOString(),
            };
          }
          await audit.write({ id: crypto.randomUUID(), timestamp: new Date().toISOString(), action: 'interactions.relationships.merge', outcome: 'success', actor: { type: 'user', id: sessionSa }, subject: { type: 'org-link', id: org } });
          await this.writeDoc(grant, RELATIONSHIPS_RESOURCE, doc);
          return json({ ok: true });
        }
        const org = String(body.org ?? '').toLowerCase();
        if (!/^0x[0-9a-fA-F]{40}$/.test(org)) return json({ error: 'org (address) required' }, 400);
        const profile = (body.profile ?? {}) as Record<string, unknown>;
        await audit.write({ id: crypto.randomUUID(), timestamp: new Date().toISOString(), action: 'interactions.member-profile.put', outcome: 'success', actor: { type: 'user', id: sessionSa }, subject: { type: 'member-profile', id: org } });
        await this.writeDoc(grant, MEMBER_PROFILE_RESOURCE(org), profile);
        return json({ ok: true });
      }

      // ── Owner-own capability records (spec 323 W2) — STRICTLY self; whitelisted recordType. ──
      // `record.get`/`record.put { record }`: the delegation-authorized, KEK-encrypted home for the
      // person's own profile/skills/manifest, replacing the V-1 bearer path + app-local KV. The
      // interactions grant's record scope + the vault's KEK gate BOTH bound this at demo-mcp; the
      // self-check + whitelist here are the belt to those suspenders.
      if (op === 'record.list') {
        // spec 315 vault viewer — the person enumerates their OWN Home-managed vault records (self-gated).
        // demo-mcp's list is record-scope-filtered to the interactions grant, so app-specific records under
        // other grants never appear (least-privilege).
        if (sessionSa.toLowerCase() !== principal) return json({ error: 'this vault belongs to the principal — self access only' }, 403);
        const records = await this.vaultFor(grant).list('');
        return json({ ok: true, records });
      }
      if (op === 'record.get' || op === 'record.put') {
        if (sessionSa.toLowerCase() !== principal) return json({ error: 'this record belongs to the principal — self access only' }, 403);
        const recordType = String(body.recordType ?? '');
        if (!recordType) return json({ error: 'recordType required' }, 400);
        // WRITES stay whitelisted (only the known capability records may be written from here). READS defer
        // to demo-mcp's record-scope gate (the interactions grant's scope) so the vault viewer (spec 315)
        // can VIEW any Home-managed record; an out-of-scope record is denied at demo-mcp, never silently.
        // The self-check above + the KEK gate + the grant scope remain.
        if (op === 'record.put' && !CAPABILITY_RECORDS.has(recordType)) {
          return json({ error: `recordType must be one of: ${[...CAPABILITY_RECORDS].join(', ')}` }, 400);
        }
        if (op === 'record.get') {
          const r = await this.vaultFor(grant).read<unknown>({ owner: '', resource: recordType });
          return json({ ok: true, record: r?.data ?? null });
        }
        if (body.record === undefined) return json({ error: 'record required' }, 400);
        await audit.write({ id: crypto.randomUUID(), timestamp: new Date().toISOString(), action: 'interactions.record.put', outcome: 'success', actor: { type: 'user', id: sessionSa }, subject: { type: 'record', id: recordType } });
        await this.vaultFor(grant).write({ owner: '', resource: recordType, data: body.record, classification: 'internal' } as never);
        return json({ ok: true });
      }

      // ── OrganizationMembership record (spec 324 W3) — STRICTLY self; the AUTHORITATIVE membership Situation
      //    + credential per org, in the principal's OWN vault. Membership ≠ Delegation ≠ Listing (ADR-0048
      //    #3/#6): this is the single source of truth the related:*/directory/gate projections point back to.
      //    Writing it grants NO authority — the delegations issued *because of* membership are separate. ──
      if (op === 'membership.get' || op === 'membership.put') {
        if (sessionSa.toLowerCase() !== principal) return json({ error: 'this membership record belongs to the principal — self access only' }, 403);
        const org = String(body.org ?? '').toLowerCase();
        if (!/^0x[0-9a-fA-F]{40}$/.test(org)) return json({ error: 'org (address) required' }, 400);
        if (op === 'membership.get') {
          const r = await this.vaultFor(grant).read<unknown>({ owner: '', resource: MEMBERSHIP_RESOURCE(org) });
          return json({ ok: true, membership: r?.data ?? null });
        }
        if (body.membership === undefined) return json({ error: 'membership (SituationV2) required' }, 400);
        await audit.write({ id: crypto.randomUUID(), timestamp: new Date().toISOString(), action: 'interactions.membership.put', outcome: 'success', actor: { type: 'user', id: sessionSa }, subject: { type: 'org-membership', id: org } });
        await this.vaultFor(grant).write({ owner: '', resource: MEMBERSHIP_RESOURCE(org), data: { membership: body.membership, credential: body.credential ?? null }, classification: 'internal' } as never);
        return json({ ok: true });
      }

      return json({ error: `unknown op: ${op}` }, 400);
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : String(e) }, 409);
    }
  }
}
