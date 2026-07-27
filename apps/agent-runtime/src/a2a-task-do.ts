// A2aTaskDO — the live A2A task runtime for ONE agent, sharded `idFromName(agentSA)`.
//
// This is the demo-a2a *relayer adoption* of `@agenticprimitives/a2a` (spec 269 W5): the worker no
// longer fakes "message received" — it runs the real delegation-authorized Task runtime. The DO holds
// the durable TaskStore (the package's `./cloudflare` adapter over DO storage), drives `processDue()`
// from `alarm()`, and binds the on-chain auth checks (ERC-1271 + isRevoked) to Base Sepolia.
//
// Boundary: the generic transport/runtime lives in the package; this module supplies the Cloudflare DO
// class (it owns the skill handlers + the chain wiring), exactly as ADR-0034 prescribes. Bodies live in
// the agent's DO-storage vault (`vault:<owner>:<recordType>`); task state carries only hashes + refs
// (A2A-INV-04). No long-lived signing key here — push delivery (which needs a terminal signer) is a
// follow-up; this leg is poll-based (`tasks/get`), so the worker holds no agent key (SC-8 honored).
/// <reference types="@cloudflare/workers-types" />
import { createPublicClient, http, keccak256, toBytes, type Address, type Hex } from 'viem';
import { baseSepolia } from 'viem/chains';
import { hashDelegation, type Delegation } from '@agenticprimitives/delegation';
import {
  createA2aAgent,
  dispatchA2aRpc,
  hashA2aMessage,
  hashA2aTaskRequest,
  type A2aAgent,
  type A2aBudgetPort,
  type OnChainChecks,
  type VaultClient,
  type VaultRef,
  type McpClient,
  type SkillHandler,
} from '@agenticprimitives/a2a';
import { createDurableObjectTaskStore } from '@agenticprimitives/a2a/cloudflare';
// Content fabric over A2A→MCP (ADR-0055): the content intents ride the existing vault seam.
import { A2A_CONTENT_INTENTS, parseVaultResourceId, toVaultRecordResource } from '@agenticprimitives/content-storage';
import { createDurableObjectBudgetStore } from '@agenticprimitives/rate-control-cloudflare';
import { createChainAuthorityReader } from '@agenticprimitives/chain-state';
import { createViemChainProvider } from '@agenticprimitives/chain-state-viem';
// ADR-0044 — the Ring-0 agentic loop. The `orchestrate` skill runs the SHARED orchestration core (tools +
// planner selection live in ./orchestration, reused by the /a2a/intent relayer); the LLM binding stays
// behind the Planner port (the chain-state-viem pattern), selected by env at request time.
import { runOrchestration } from './orchestration.js';
import { endeavorRequestFromA2aTask } from './endeavor-intake.js';
import { handleDiscussionRespond, handleConsultSynthesis, type DiscussionRespondInput, type DiscussionRoutingOpts } from './discussion-skill.js';
import { draftEndeavorPlan } from './endeavor-plan-skill.js';
import { executeEndeavorStep, synthesizeEndeavorOutcome, gatherReferenceContext } from './endeavor-work-skill.js';
import { handleInboxRespond, type InboxRespondInput } from './inbox-skill.js';
import { handleConsultRespond } from './consult-skill.js';
import { parseRoutedConsultSignature, verifyRoutedConsultSignature, wrapRoutedConsultSignature } from './consult-wire.js';
import { fetchDiscoveryFacets } from './discovery-facets.js';
import { makeMessagingSkills } from './messaging-skills.js';
import { skillProvenanceMetadata } from './skill-provenance.js';
import { buildA2aReceiptsConfig } from './receipts.js';
import { caip10 } from './custody-oidc.js';
import type { CanonicalAgentId } from '@agenticprimitives/types';
import {
  CONSULT_RATE_MAX,
  CONSULT_RATE_WINDOW_MS,
  CONSULT_SKILL_ID,
  ROUTING_RATE_MAX,
  ROUTING_RATE_WINDOW_MS,
  buildConsultRequest,
  buildConsultProvenance,
  buildConsultationIntentRecord,
  consultationIntentKey,
  fixedWindowAllow,
  generateConversationId,
  generateMessageId,
  messageBodyResource,
  parseConsultRequest,
  rankConsultCandidates,
  routedConsultationContextRef,
  routingPendingKey,
  sha256Hex32,
  validateConsultAnswer,
  validateMessageEnvelope,
  type ConsultAnswerV1,
  type ConsultOutcomeV1,
  type ConsultationIntentV1,
  type EligibleConsultMemberV1,
  type FixedWindowState,
  type MessageEnvelopeV1,
} from '@agenticprimitives/fabric/messaging';
// FR-3.4 — deliver artifacts into a principal's demo-mcp vault over their delegation. The value import is
// cyclic with index.ts, but safe: `callMcpToolViaDelegation` is a hoisted function used only at request
// time (never at module-init), and `Env`/`IncomingDelegation` are type-only.
import { buildAuditSink, callMcpToolWithProof, interactionsSessionAccount, type Env, type IncomingDelegation } from './index.js';

const ERC1271_ABI = [{ type: 'function', name: 'isValidSignature', stateMutability: 'view', inputs: [{ name: 'hash', type: 'bytes32' }, { name: 'signature', type: 'bytes' }], outputs: [{ name: 'magic', type: 'bytes4' }] }] as const;
const ERC1271_MAGIC = '0x1626ba7e';
const IS_REVOKED_ABI = [{ type: 'function', name: 'isRevoked', stateMutability: 'view', inputs: [{ name: 'delegationHash', type: 'bytes32' }], outputs: [{ name: 'revoked', type: 'bool' }] }] as const;

/** Stable JSON keccak — the body integrity hash. The sender computes `bodyHash` the same way. */
const hashBody = (data: unknown): Hex => keccak256(toBytes(JSON.stringify(data ?? null)));

/** echo — the live proof-of-life skill: deposit the input as an artifact in the agent's vault. The
 *  full lifecycle (authorize → submitted → working → completed → poll) runs over real infra. */
const echo: SkillHandler = {
  skill: 'echo',
  handle: async (ctx) => ({ state: 'completed', artifactIds: [await ctx.emitArtifact({ artifactKind: 'echo', body: ctx.input })] }),
};

// ── Content fabric over A2A → MCP (ADR-0055) ──────────────────────────────────────────────────────────
// The content intents are ordinary A2A skills that ride the EXISTING vault seam. Each lowers the
// app-facing `ap-vault://<sa>/<kind>/<id>` id to the flat, principal-keyed MCP record and calls
// get/set_vault_record under the task delegation. `toVaultRecordResource` is FAIL-CLOSED on
// `vaultId !== principal` — a task may only address its own principal's vault. Person + service today
// (the record.* / content.* path); org-owned content is a follow-on (org.content:* op).
function contentRecordType(uri: string, principal: Address): string {
  const ref = parseVaultResourceId(uri);
  if (!ref) throw new Error(`malformed ap-vault resource: ${uri}`);
  // strip the `vault:` prefix — get/set_vault_record take the bare recordType (demo-mcp re-adds it).
  return toVaultRecordResource(ref, principal).replace(/^vault:/, '');
}
function makeContentSkills(): SkillHandler[] {
  return [
    {
      skill: A2A_CONTENT_INTENTS.accessRequest,
      handle: async (ctx) => {
        const uri = (ctx.input as { resource?: string } | null)?.resource ?? '';
        const record = await ctx.mcp.callTool({ tool: 'get_vault_record', toolArgs: { recordType: contentRecordType(uri, ctx.principal) }, delegation: ctx.delegation });
        return { state: 'completed', artifactIds: [await ctx.emitArtifact({ artifactKind: 'content.record', body: record })] };
      },
    },
    {
      skill: A2A_CONTENT_INTENTS.skillPublishRequest,
      handle: async (ctx) => {
        const input = (ctx.input as { resource?: string; release?: unknown } | null) ?? {};
        await ctx.mcp.callTool({ tool: 'set_vault_record', toolArgs: { recordType: contentRecordType(input.resource ?? '', ctx.principal), record: input.release ?? null }, delegation: ctx.delegation });
        return { state: 'completed', artifactIds: [await ctx.emitArtifact({ artifactKind: 'skill.release', body: input.release ?? null })] };
      },
    },
  ];
}

// ── The Ring-0 agentic model (ADR-0044) ──────────────────────────────────────────────────────────────
/** The `orchestrate` skill — the intent-task entry point. Reads a GOAL, plans which MCP tool composes to
 *  satisfy it (shared core in ./orchestration), runs it under the TASK's delegation (every call rides
 *  on-chain authority — the invoker wraps `ctx.mcp.callTool`), and emits the result as an artifact. */
function makeOrchestrateSkill(env: Env, agentSA: Address): SkillHandler {
  return {
    skill: 'orchestrate',
    handle: async (ctx) => {
      const raw = ctx.input as { goal?: unknown; endeavor?: unknown } | string | null;
      const goal = typeof raw === 'string' ? raw : typeof raw?.goal === 'string' ? raw.goal : '';
      if (!goal.trim()) return { state: 'failed', error: 'orchestrate requires input.goal (a declarative goal)' };

      // spec 334 §4 door 4 (W4): a caller may ask for coordination intake (`input.endeavor: true`) —
      // the task is then ALSO admitted as an EndeavorRequest against the managing principal,
      // requester = the delegation-verified task sender, intake context = this task's ref. Fail-
      // closed: an opted-in intake that cannot be filed fails the task rather than proceeding
      // unregistered (ADR-0013 — no silent skip).
      let endeavorRequestId: string | undefined;
      if (typeof raw === 'object' && raw?.endeavor === true) {
        const secret = env.A2A_CUSTODY_BRIDGE_SECRET;
        if (!secret) return { state: 'failed', error: 'endeavor intake requires the internal marker (A2A_CUSTODY_BRIDGE_SECRET)' };
        const opBody = endeavorRequestFromA2aTask({ taskId: ctx.taskId, goal });
        const target = ctx.principal.toLowerCase();
        const stub = env.INTERACTIONS.get(env.INTERACTIONS.idFromName(target));
        const resp = await stub.fetch(new Request(`https://do/interactions/${target}/internal.endeavor.request`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-ap-internal': secret },
          body: JSON.stringify({ ...opBody, requester: ctx.sender.toLowerCase() }),
        }));
        const out = (await resp.json().catch(() => ({}))) as { ok?: boolean; requestId?: string; error?: string };
        if (!resp.ok || !out.ok || !out.requestId) {
          return { state: 'failed', error: `endeavor intake failed: ${out.error ?? `status ${resp.status}`}` };
        }
        endeavorRequestId = out.requestId;
      }

      const { result, plannerKind } = await runOrchestration(env, {
        goal,
        principal: ctx.principal,
        // The invoker IS the authority boundary: every composed MCP call rides the TASK's delegation.
        invoke: async (toolId, toolArgs) => ctx.mcp.callTool({ tool: toolId, toolArgs, delegation: ctx.delegation }),
      });

      // skill-provenance/v1 — tag the artifact with the verifiable SKILL.md that
      // shaped it (inert unless SKILLS_CORPUS_URL is set; fail-open).
      const provenance = await skillProvenanceMetadata(env, {
        skill: 'orchestrate',
        agentSA,
        taskId: ctx.taskId,
        reason: 'orchestration goal accepted',
      });
      const artifactId = await ctx.emitArtifact({
        artifactKind: 'orchestration.result',
        body: {
          goal,
          planner: plannerKind,
          outcome: result.outcome,
          plan: result.plan,
          result: result.result ?? null,
          error: result.error ?? null,
          ...(endeavorRequestId ? { endeavorRequestId } : {}),
        },
        ...(provenance ? { metadata: provenance } : {}),
      });
      return result.outcome === 'completed'
        ? { state: 'completed', artifactIds: [artifactId] }
        : { state: 'failed', artifactIds: [artifactId], error: result.error };
    },
  };
}

const AGENT_SA_KEY = '__a2a_agent_sa';
const ALARM_DELAY_MS = 1500;

// ── spec 329 W3 — the ORG side of routed consultation (pending ring + poll cadence). ─────────────
/** Poll cadence for pending consults (alarm-driven — never a busy loop). */
const ROUTING_POLL_MS = 4000;
/** Bounded synthesis retries before the pending entry is dropped (audited). */
const ROUTING_SYNTHESIS_MAX_ATTEMPTS = 3;
/**
 * Per-member consult deadline — the EXECUTION POINT's policy (fabric's
 * CONSULT_MEMBER_TIMEOUT_MS is the pure-layer DEFAULT; the deadline that actually
 * gates the poll is ours to set, per consult-routing.ts's module doctrine). The
 * 60s default was tuned for a single member; a broad question fans to up to
 * maxFanout members whose agents each run a CONCURRENT LLM Ring-0 turn, and 3
 * such turns compose long grounded answers and, run CONCURRENTLY (and serialized
 * by the shared model key), routinely finish anywhere from ~70s to past 180s —
 * far past 60s, so answers that DID land were reported as timedOut. 240s covers
 * three concurrent multi-paragraph LLM answers with headroom; the alarm re-polls
 * every ROUTING_POLL_MS until then, so a member that finishes early is picked up
 * immediately (no fixed wait — the deadline only bites a member that never
 * completes). Tunable via the CONSULT_MEMBER_DEADLINE_MS var without a redeploy.
 */
const CONSULT_MEMBER_DEADLINE_DEFAULT_MS = 240_000;
function consultMemberDeadlineMs(env: { CONSULT_MEMBER_DEADLINE_MS?: string }): number {
  const v = Number(env.CONSULT_MEMBER_DEADLINE_MS);
  return Number.isFinite(v) && v > 0 ? v : CONSULT_MEMBER_DEADLINE_DEFAULT_MS;
}
/** Per-topic routing bucket key (spec 329 §4 — 3 routed questions / 10 min, on top of 327's). */
const ROUTING_RATE_KEY = (channelId: string): string => `routing.rate:${channelId}`;

/** One consulted member's slot in the pending ring. `status:'sent'` until a terminal outcome. */
interface PendingConsultMemberV1 {
  memberSA: string;
  displayName: string;
  taskId: Hex;
  sentAt: number;
  deadlineAt: number;
  status: 'sent' | ConsultOutcomeV1['status'];
  answer?: ConsultAnswerV1;
}
/** The `routing.pending:<topicId>:<questionId>` record (spec 329 §4.1 — org DO storage; DO-side
 *  custody like the W1 grant-store deviation: no deployed vault scope covers routing.*). */
interface PendingRoutingV1 {
  channelId: string;
  questionId: string;
  question: string;
  topicTitle: string;
  displayName: string;
  members: PendingConsultMemberV1[];
  createdAt: number;
  synthesisAttempts?: number;
}

// ── spec 329 §3 — the `discussion.consult` skill on PERSON agents ────────────────────────────────────
/** Member-side per-org consult rate bucket key (DO storage; fixed window 12/hour/org). */
const CONSULT_RATE_KEY = (orgSA: string): string => `consult.rate:${orgSA.toLowerCase()}`;

/**
 * The consult skill handler (spec 329 §3.2). Registered on EVERY agent's DO alongside the
 * messaging skills — REACHABILITY is the delegation gate's alone (`authorizeA2aMessage`: the
 * member-signed consultability grant must name the org as delegate, THIS agent in allowedTargets,
 * and the `discussion.consult` selector in allowedMethods; on-chain isRevoked + ERC-1271 per
 * message). No delegation, no consult (ADR-0013). The handler adds the belts the gate can't see:
 *   • delegator === THIS agent (the grant is the MEMBER's own opt-in — a third party's grant
 *     naming this agent as a target is not consultability);
 *   • the payload's context.orgSA === the VERIFIED sender (no org spoofing inside the body);
 *   • the member-side per-org fixed window (12/hour/org — spec 329 §3.2), audited on exceed.
 * The turn itself is the Ring-0 loop in ./consult-skill.ts; the structured ConsultAnswer artifact
 * is the task's terminal (decline included — an explicit decline COMPLETES with a declined
 * artifact; only pipeline errors fail the task).
 */
function makeConsultSkill(env: Env, agentSA: Address, storage: DurableObjectStorage): SkillHandler {
  return {
    skill: CONSULT_SKILL_ID,
    handle: async (ctx) => {
      const audit = buildAuditSink(env);
      const orgSender = ctx.sender.toLowerCase();
      const auditRow = (action: string, outcome: 'success' | 'denied' | 'error', subjectId: string, reason?: string) =>
        audit.write({
          id: crypto.randomUUID(), timestamp: new Date().toISOString(), action, outcome,
          actor: { type: 'service', id: orgSender }, subject: { type: 'consult', id: subjectId },
          ...(reason ? { reason } : {}),
        }).catch(() => undefined);

      // The consultability grant is the MEMBER's own opt-in: its delegator must BE this agent.
      if (ctx.principal.toLowerCase() !== agentSA.toLowerCase()) {
        await auditRow('a2a.consult.received', 'denied', orgSender, 'delegation delegator is not this member agent');
        return { state: 'failed', error: 'consult grant must be signed by this member agent (delegator mismatch)' };
      }
      const parsed = parseConsultRequest(ctx.input);
      if (!parsed.ok) {
        await auditRow('a2a.consult.received', 'denied', orgSender, parsed.error);
        return { state: 'failed', error: parsed.error };
      }
      const { request } = parsed;
      // No org spoofing inside the body: the carried orgSA must be the VERIFIED sender.
      if (request.context.orgSA !== orgSender) {
        await auditRow('a2a.consult.received', 'denied', request.context.questionId, 'context.orgSA does not match the verified sender');
        return { state: 'failed', error: 'context.orgSA must be the verified consulting org (sender)' };
      }
      await auditRow('a2a.consult.received', 'success', request.context.questionId);

      // Member-side per-org fixed window (spec 329 §3.2: 12/hour/org). Exceed ⇒ typed fail, audited.
      const rateKey = CONSULT_RATE_KEY(orgSender);
      const prev = (await storage.get(rateKey)) as FixedWindowState | undefined;
      const rate = fixedWindowAllow(prev, Date.now(), { windowMs: CONSULT_RATE_WINDOW_MS, max: CONSULT_RATE_MAX });
      if (!rate.allowed) {
        await auditRow('a2a.consult.rateLimited', 'denied', request.context.questionId);
        return { state: 'failed', error: `consult rate limit exceeded for this organization (${CONSULT_RATE_MAX}/hour)` };
      }
      await storage.put(rateKey, rate.next);

      const memberCaip = caip10(Number(env.CHAIN_ID ?? 84532), agentSA) as CanonicalAgentId;
      try {
        const turn = await handleConsultRespond(env, { member: memberCaip, request }, {
          // Harness pre-read (spec 328 §4b record): the member's playbook + display name via the
          // marker-gated internal op on THEIR InteractionsDO. Best-effort enrichment — a member who
          // never enabled interactions answers under the default playbook, same mechanism.
          readContext: async () => {
            const secret = env.A2A_CUSTODY_BRIDGE_SECRET;
            if (!secret) throw new Error('no internal marker configured');
            const stub = env.INTERACTIONS.get(env.INTERACTIONS.idFromName(agentSA.toLowerCase()));
            const resp = await stub.fetch(new Request(`https://do/interactions/${agentSA.toLowerCase()}/internal.consult.context`, {
              method: 'POST', headers: { 'content-type': 'application/json', 'x-ap-internal': secret }, body: JSON.stringify({}),
            }));
            const out = (await resp.json().catch(() => ({}))) as Record<string, unknown> & { ok?: boolean; error?: string };
            if (!resp.ok || out.ok === false) throw new Error(out.error ?? `consult context read failed (${resp.status})`);
            return out;
          },
        });
        if (!turn.answer) {
          await auditRow('a2a.consult.answered', 'error', request.context.questionId, turn.error ?? turn.result.error ?? 'turn completed without a terminal');
          return { state: 'failed', error: turn.error ?? turn.result.error ?? 'consult turn completed without posting an answer' };
        }
        const provenance = await skillProvenanceMetadata(env, {
          skill: CONSULT_SKILL_ID,
          agentSA,
          taskId: ctx.taskId,
          reason: 'consult request accepted',
        });
        const artifactId = await ctx.emitArtifact({
          artifactKind: 'consult.answer',
          body: turn.answer,
          bodyContentType: 'application/json',
          ...(provenance ? { metadata: provenance } : {}),
        });
        await auditRow(turn.answer.declined ? 'a2a.consult.declined' : 'a2a.consult.answered', 'success', request.context.questionId);
        return { state: 'completed', artifactIds: [artifactId] };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await auditRow('a2a.consult.answered', 'error', request.context.questionId, msg);
        return { state: 'failed', error: msg };
      }
    },
  };
}

/** Normalize a JSON-wire delegation (string salt, optional caveat args) into the package's shape. */
function normalizeDelegation(d: Record<string, unknown>): Delegation {
  return {
    delegator: d.delegator as Address,
    delegate: d.delegate as Address,
    authority: d.authority as Hex,
    caveats: ((d.caveats as { enforcer: Address; terms: Hex; args?: Hex }[]) ?? []).map((c) => ({ enforcer: c.enforcer, terms: c.terms, args: (c.args ?? '0x') as Hex })),
    salt: BigInt((d.salt as string | number | bigint) ?? 0),
    signature: (d.signature ?? '0x') as Hex,
  };
}

/** Methods whose `params.delegation.salt` arrives as a JSON string and must become a bigint. */
const DELEGATION_METHODS = new Set(['message/send', 'tasks/resubmit']);

// spec 289 §5 — the resilient chain-read authority port for the A2A verify gate (revocation + the
// delegation/message/caller ERC-1271 signature reads), symmetric with demo-mcp's baseConfig. The viem
// provider validates signatures via the UniversalSignatureValidator (ECDSA/1271/6492) + reports `deployed`;
// circuit-breaker + bounded-freshness/divergence evidence wrap it. Memoized per isolate; falls back to the
// inline single-client reads when no RPC/USV. SINGLE provider (demo) — add more for divergence detection.
let _a2aChainReader: ReturnType<typeof createChainAuthorityReader> | undefined;
let _a2aChainReaderTried = false;
function a2aChainReader(env: Env): ReturnType<typeof createChainAuthorityReader> | undefined {
  if (_a2aChainReaderTried) return _a2aChainReader;
  _a2aChainReaderTried = true;
  const usv = env.UNIVERSAL_SIGNATURE_VALIDATOR?.trim();
  if (!env.RPC_URL || !usv) return undefined;
  _a2aChainReader = createChainAuthorityReader({
    chainId: Number(env.CHAIN_ID ?? 84532),
    providers: [createViemChainProvider({
      source: 'base-sepolia-rpc',
      delegationManager: env.DELEGATION_MANAGER as Address,
      universalSignatureValidator: usv as Address,
      rpcUrl: env.RPC_URL,
    })],
  });
  return _a2aChainReader;
}

export class A2aTaskDO {
  private agent: A2aAgent | null = null;
  constructor(private state: DurableObjectState, private env: Env) {}

  private build(agentSA: Address): A2aAgent {
    if (this.agent) return this.agent;
    const pub = createPublicClient({ chain: baseSepolia, transport: http(this.env.RPC_URL) });
    const chainId = Number(this.env.CHAIN_ID ?? 84532);
    const dm = this.env.DELEGATION_MANAGER as Address;
    // Inline ERC-1271 (direct SA isValidSignature) — the fallback when the resilient reader can't be built.
    const erc1271Inline = async (account: Address, digest: Hex, signature: Hex): Promise<boolean> => {
      const magic = (await pub.readContract({ address: account, abi: ERC1271_ABI, functionName: 'isValidSignature', args: [digest, signature] })) as Hex;
      return magic.toLowerCase() === ERC1271_MAGIC;
    };
    // spec 289 §5 — route revocation + the three signature reads through the resilient chain-state port when
    // available (USV-based, circuit-breaker, evidence). The signature reads require BOTH valid AND deployed:
    // the inline path reverts on an undeployed signer (fail-closed) — `valid && deployed` preserves that
    // (an A2A party is always a deployed SA), while the port also handles 6492 robustly. Fall back to inline.
    const reader = a2aChainReader(this.env);
    const verifySig = reader
      ? async (signer: Address, digest: Hex, signature: Hex): Promise<boolean> => {
          const r = await reader.verifySmartAgentSignature({ signer, digest, signature });
          return r.valid && r.deployed;
        }
      : erc1271Inline;
    const isRevokedFn = reader
      ? async (d: Delegation) => (await reader.isDelegationRevoked(hashDelegation(d, chainId, dm))).revoked
      : async (d: Delegation) => (await pub.readContract({ address: dm, abi: IS_REVOKED_ABI, functionName: 'isRevoked', args: [hashDelegation(d, chainId, dm)] })) as boolean;
    const verifyDelegationSigFn = async (d: Delegation) => verifySig(d.delegator, hashDelegation(d, chainId, dm), d.signature as Hex);
    // spec 329 §3.1 — accept the SESSION-WRAPPED consult signature alongside plain ERC-1271: an org
    // runtime holds no org key, so its consult-rail message/tasks-get signatures are ECDSA by the
    // interactions-session KMS key, wrapped WITH the steward-minted org consult wire. Verification
    // is fail-closed per message (wire shape: consult selector only + timestamp; delegator = the
    // claimed signer; ECDSA recovers to the wire's delegate; wire ERC-1271-valid against the org;
    // wire UNREVOKED on-chain — revocation kills routing immediately at this gate). Any other
    // signature shape takes the unchanged ERC-1271 path.
    const wireEnforcers = { timestamp: this.env.TIMESTAMP_ENFORCER ?? '', allowedMethods: this.env.ALLOWED_METHODS_ENFORCER ?? '' };
    const verifySigOrRouted = async (signer: Address, digest: Hex, signature: Hex): Promise<boolean> => {
      if (parseRoutedConsultSignature(signature)) {
        return verifyRoutedConsultSignature({
          signer, digest, signature,
          enforcers: wireEnforcers,
          verifyDelegationSig: verifyDelegationSigFn,
          isRevoked: isRevokedFn,
        });
      }
      return verifySig(signer, digest, signature);
    };
    const checks: OnChainChecks = {
      // Fail-closed: any throw propagates and the package denies (ADR-0013).
      isRevoked: isRevokedFn,
      verifyDelegationSignature: verifyDelegationSigFn,
      verifyMessageSignature: async (msg, digest) => verifySigOrRouted(msg.sender as Address, digest, msg.signature as Hex),
      // AUDIT NEW-A2A-2 — the read/control caller proves control of `caller` via ERC-1271 over the request digest.
      verifyCallerSignature: async (caller, digest, signature) => verifySigOrRouted(caller as Address, digest, signature as Hex),
    };
    // Vault seam (A2A-INV-04 — only refs/hashes in task state):
    //  • with a delegation (FR-3.4) → write/read the DELEGATOR's demo-mcp vault via the captured grant
    //    (demo-mcp keys by principal); this is how a handler delivers an Entitlement VC into the reader's
    //    own namespace. No DO signing key needed — the delegation is pre-signed (SR-8).
    //  • without one → the agent's private DO-storage store (its own artifacts), keyed by owner.
    const env = this.env;
    const toWire = (d: Delegation): IncomingDelegation => ({ ...d, salt: d.salt.toString() } as unknown as IncomingDelegation);
    const vault: VaultClient = {
      write: async ({ owner, recordType, data, delegation }) => {
        if (delegation) {
          const resp = await callMcpToolWithProof({ env, toolName: 'set_vault_record', delegation: toWire(delegation), toolArgs: { recordType, data } });
          if (!resp.ok) throw new Error(`a2a vault write via delegation failed (HTTP ${resp.status})`);
          return { owner, recordType };
        }
        await this.state.storage.put(`vault:${owner.toLowerCase()}:${recordType}`, data);
        return { owner, recordType };
      },
      read: async (ref, opts) => {
        if (opts?.delegation) {
          const resp = await callMcpToolWithProof({ env, toolName: 'get_vault_record', delegation: toWire(opts.delegation), toolArgs: { recordType: ref.recordType } });
          const j = (await resp.json().catch(() => null)) as { ok?: boolean; data?: unknown; error?: unknown } | null;
          // ADR-0013 — a soft failure (non-2xx from a rate-limited verify/decrypt, or `{ok:false}`) MUST throw,
          // never masquerade as an empty record (the "saw it, then it went away" bug). `null` is an answer only
          // for a genuine absent record (`data===null`); mirrors the `mcp` seam below + interactions-do read.
          if (!resp.ok || (j && j.ok === false)) {
            throw new Error(`a2a vault read via delegation failed (HTTP ${resp.status})${j?.error ? `: ${String(j.error)}` : ''}`);
          }
          return j?.data ?? null;
        }
        return (await this.state.storage.get(`vault:${ref.owner.toLowerCase()}:${ref.recordType}`)) ?? null;
      },
    };
    // Spec 290 §6 Stage-3 — the per-SA hard budget, enforced post-authority in the runtime (keyed by the
    // verified principal). One SHARED DO per SA: demo-a2a binds CROSS-SCRIPT to demo-mcp's SmartAgentBudgetDO
    // (script_name=demo-mcp-production), so the A2A + MCP paths debit ONE authority per SA (§9). Adapts the
    // rich HardBudgetStore to the a2a package's minimal structural port (fixed 1 unit per task).
    let budget: A2aBudgetPort | undefined;
    if (this.env.SA_BUDGET) {
      const hard = createDurableObjectBudgetStore({
        namespace: this.env.SA_BUDGET,
        chainId,
        limitUnits: Number(this.env.SA_BUDGET_LIMIT_UNITS ?? '1000'),
      });
      budget = {
        reserve: (i) => hard.reserve({ ...i, estimatedUnits: 1 }),
        commit: (id) => hard.commit(id, 1),
        release: (id) => hard.release(id),
      };
    }

    // MCP seam (ADR-0044 / ADR-0041) — the `orchestrate` skill composes MCP tools through this, ALWAYS under
    // the task's delegation (passed by the handler, symmetric with the vault seam). The delegation is the
    // authority; the planner only chose WHICH tool. Fail-closed: a tool call without a delegation, an
    // unauthorized grant, or a tool-level error throws → the loop observes the failure.
    const ALLOWED_MCP_TOOLS = new Set(['get_profile', 'get_pii', 'get_org_sensitive', 'get_vault_record', 'set_vault_record', 'list_vault_record']);
    type DelegatedToolName = Parameters<typeof callMcpToolWithProof>[0]['toolName'];
    const mcp: McpClient = {
      callTool: async ({ tool, toolArgs, delegation }) => {
        if (!ALLOWED_MCP_TOOLS.has(tool)) throw new Error(`mcp tool not exposed by this agent: ${tool}`);
        if (!delegation) throw new Error(`orchestrated MCP call requires a task delegation (tool ${tool})`);
        const resp = await callMcpToolWithProof({
          env,
          toolName: tool as DelegatedToolName,
          delegation: toWire(delegation),
          toolArgs,
        });
        const j = (await resp.json().catch(() => null)) as Record<string, unknown> | null;
        if (!resp.ok || (j && j.ok === false)) {
          throw new Error(`mcp ${tool} failed (HTTP ${resp.status})${j?.error ? `: ${String(j.error)}` : ''}`);
        }
        return j;
      },
    };

    this.agent = createA2aAgent({
      agentSA, chainId, delegationManager: dm,
      enforcers: { timestamp: this.env.TIMESTAMP_ENFORCER as Address, allowedTargets: this.env.ALLOWED_TARGETS_ENFORCER as Address, allowedMethods: this.env.ALLOWED_METHODS_ENFORCER as Address },
      taskStore: createDurableObjectTaskStore(this.state.storage),
      // spec 309 §7 / spec 316 §11a — the A2A messaging skills (messaging.deliver / interactions.respond /
      // interactions.deliverCredential): delivery rides standard `message/send`, authorized by the delegation
      // gate, then admitted DIRECTLY into the recipient's vault inbox (no Home callback). Registered on EVERY
      // agent's DO (this IS its inbox gateway).
      // spec 322 W3f: the inbox.data merge rides the recipient's InteractionsDO (in-Worker
      // `internal.deliver` — the serialized single writer; the public route refuses internal.*).
      // spec 329 §3 — the `discussion.consult` skill (person agents; delegation-gated: reachable
      // ONLY under a member-signed consultability grant naming the org + this skill's selector).
      checks, handlers: [echo, makeOrchestrateSkill(this.env, agentSA), makeConsultSkill(this.env, agentSA, this.state.storage), ...makeContentSkills(), ...makeMessagingSkills(agentSA, async (recipient, envelope, body) => {
        // spec 323 W3.2 — the recipient's InteractionsDO does BOTH admissions with its OWN held
        // delivery wire: the body (internal.dm.body.put) then the inbox.data merge (internal.deliver).
        const stub = this.env.INTERACTIONS.get(this.env.INTERACTIONS.idFromName(recipient.toLowerCase()));
        const call = async (op: string, payload: unknown): Promise<void> => {
          const resp = await stub.fetch(new Request(`https://do/interactions/${recipient.toLowerCase()}/${op}`, {
            // ARCH-H2 — the in-Worker internal marker the InteractionsDO requires for internal.* ops.
            method: 'POST', headers: { 'content-type': 'application/json', 'x-ap-internal': this.env.A2A_CUSTODY_BRIDGE_SECRET ?? '' }, body: JSON.stringify(payload),
          }));
          const out = (await resp.json().catch(() => ({}))) as { ok?: boolean; error?: string };
          if (!resp.ok || !out.ok) throw new Error(out.error ?? `${op} failed (${resp.status})`);
        };
        await call('internal.dm.body.put', { resource: body.resource, data: body.stored });
        await call('internal.deliver', { envelope });
      })], vault, mcp, hashBody, budget,
      // spec 303 W3 — mint verification receipts at the message/send +
      // resubmit terminals; the accept receipt rides the send result so the
      // SENDER retains it, and rows persist to D1 (migration 0002).
      receipts: buildA2aReceiptsConfig(this.env, agentSA),
    });
    return this.agent;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    // ── spec 327 §4 — the org-assistant turn (`discussion.respond`). IN-WORKER ONLY: dispatched by
    // the org's InteractionsDO after a triggering topic post, gated by the ARCH-H2 internal marker.
    // Deliberately NOT an A2A skill on the public card — its authorization model is "the org's own
    // substrate observed a triggering post", not a caller delegation, so a public `message/send`
    // can never reach it (fail-closed by path: the JSON-RPC dispatcher below has no such method).
    if (url.pathname === '/internal/discussion-respond') {
      const secret = this.env.A2A_CUSTODY_BRIDGE_SECRET;
      if (!secret || req.headers.get('x-ap-internal') !== secret) return Response.json({ ok: false, error: 'internal op — not authorized' }, { status: 403 });
      const p = (await req.json().catch(() => null)) as (DiscussionRespondInput & { trigger?: string; mentionHandle?: string }) | null;
      if (!p || !/^0x[0-9a-f]{40}$/.test(String(p.principal ?? '')) || !p.channelId) {
        return Response.json({ ok: false, error: 'principal + channelId required' }, { status: 400 });
      }
      const stub = this.env.INTERACTIONS.get(this.env.INTERACTIONS.idFromName(p.principal.toLowerCase()));
      const call = async (op: string, payload: unknown): Promise<Record<string, unknown>> => {
        const resp = await stub.fetch(new Request(`https://do/interactions/${p.principal.toLowerCase()}/${op}`, {
          method: 'POST', headers: { 'content-type': 'application/json', 'x-ap-internal': secret }, body: JSON.stringify(payload),
        }));
        const out = (await resp.json().catch(() => ({}))) as Record<string, unknown> & { ok?: boolean; error?: string };
        if (!resp.ok || out.ok === false) throw new Error(out.error ?? `${op} failed (${resp.status})`);
        return out;
      };
      // ── spec 329 W2/W3 — routing context, HARNESS-computed before the turn (the 327 "harness
      // reads, model posts" finding applied to routing: eligibility ∩ discovery ranking are
      // pre-read and embedded; the tools only expose/pin that snapshot). Every failure here
      // fail-opens to the plain spec-327 turn — the human surface is never blocked (§1). The
      // depth-1 guard is structural: this dispatch only fires for human-authored triggers
      // (assistantTrigger skips actor-marked + org-authored posts), and the consult skill's
      // handler has NO routing tools.
      let routing: DiscussionRoutingOpts | undefined;
      let askCount = 0; // consults actually sent — the status post carries the contextRef iff > 0
      const audit = buildAuditSink(this.env);
      try {
        const elig = (await call('internal.consult.eligible', { channelId: p.channelId })) as { enabled?: boolean; maxFanout?: number; members?: EligibleConsultMemberV1[] };
        if (elig.enabled === true && (elig.members?.length ?? 0) > 0) {
          // Per-topic routing bucket (spec 329 §4: 3 routed questions / 10 min, on top of 327's
          // dispatch bucket). Consumed only when a routed question actually starts; exceed ⇒ the
          // turn runs WITHOUT routing tools (audited, never queued).
          const rateKey = ROUTING_RATE_KEY(p.channelId);
          const prev = (await this.state.storage.get(rateKey)) as FixedWindowState | undefined;
          const rate = fixedWindowAllow(prev, Date.now(), { windowMs: ROUTING_RATE_WINDOW_MS, max: ROUTING_RATE_MAX });
          if (!rate.allowed) {
            await audit.write({ id: crypto.randomUUID(), timestamp: new Date().toISOString(), action: 'interactions.routing.rateLimited', outcome: 'denied', actor: { type: 'service', id: p.principal }, subject: { type: 'channel', id: p.channelId } });
          } else {
            const wireResp = (await call('internal.consult.orgWire', {})) as { wire?: IncomingDelegation | null };
            if (wireResp.wire) {
              await this.state.storage.put(rateKey, rate.next);
              const questionId = `q_${crypto.randomUUID()}`;
              // W2 — discovery enrichment + spec-281 ranking (fail-open to fewer signals: an
              // unreachable discovery yields the un-enriched eligible set, never more candidates).
              const facets = await fetchDiscoveryFacets(this.env, elig.members!.map((m) => m.memberSA));
              const ranking = rankConsultCandidates({ eligible: elig.members!, facets, need: p.triggerBody, max: 5 });
              const evidenceHash = await sha256Hex32(new TextEncoder().encode(JSON.stringify(ranking.candidates)));
              await audit.write({ id: crypto.randomUUID(), timestamp: new Date().toISOString(), action: 'interactions.routing.decision', outcome: 'success', actor: { type: 'service', id: p.principal }, subject: { type: 'routing-question', id: questionId }, reason: `candidates=${ranking.candidates.length} enriched=${ranking.enriched} droppedByMandates=${ranking.droppedByMandates} evidenceHash=${evidenceHash}` });
              if (ranking.candidates.length > 0) {
                // Clipped topic tail for the routed context (spec 329 §2.3) — one bounded read.
                let tail: Array<{ author: string; bodyText: string }> = [];
                try {
                  const topicRead = (await call('internal.channels.read', { channelId: p.channelId, limit: 8 })) as { messages?: Array<{ authorName?: string; bodyText?: string }> };
                  tail = (topicRead.messages ?? []).map((m) => ({ author: m.authorName ?? 'member', bodyText: m.bodyText ?? '' }));
                } catch { /* trigger-only context */ }
                const maxFanout = Math.min(Math.max(Number(elig.maxFanout ?? 3) || 3, 1), 5);
                routing = {
                  questionId,
                  candidates: ranking.candidates,
                  maxFanout,
                  ask: async (memberSA, question) => {
                    const r = await this.submitConsult({
                      org: p.principal.toLowerCase(), orgWire: wireResp.wire!, memberSA, question,
                      channelId: p.channelId, questionId, topicTitle: p.topicTitle, tail,
                    });
                    askCount++;
                    return r;
                  },
                };
              }
            }
          }
        }
      } catch { /* fail-open: the plain 327 turn (the org answers alone) */ }

      try {
        const turn = await handleDiscussionRespond(this.env, p, {
          readTopic: () => call('internal.channels.read', { channelId: p.channelId }),
          // spec 334 §6 gather phase for the @ask turn: read ONE of the org's OWN records owner-self
          // through the read-only coordination grant (recordType OPAQUE — the org's playbook names
          // the domain records, never this platform). Non-throwing: a scope-denied / unenabled read
          // maps to { ok:false } so the gather sub-turn degrades gracefully to no reference data.
          readOrgRecord: (recordType: string) =>
            call('internal.coordination.vaultRead', { recordType })
              .then((r) => ({ ok: r.ok === true, data: (r as { data?: unknown }).data, error: (r as { error?: string }).error, needsEnable: (r as { needsEnable?: boolean }).needsEnable }))
              .catch((e) => ({ ok: false, error: e instanceof Error ? e.message : String(e) })),
          post: async (bodyText) => (await call('internal.channels.post', {
            channelId: p.channelId, bodyText,
            // The turn-1 status post carries the routed-consultation contextRef iff asks went out
            // (a routed-tools turn that consulted no one is a plain 327 answer — no chip).
            ...(routing && askCount > 0 ? { contextRefs: [routedConsultationContextRef(p.principal, p.channelId, routing.questionId)] } : {}),
          })) as { messageId?: string },
        }, routing);
        // W3 — pending ring + alarm-driven turn 2 (spec 329 §4.1). Recorded AFTER the status post
        // committed; a turn that asked no one leaves nothing pending (exact 327 behavior).
        if (routing && turn.asked.length > 0) {
          const nowMs = Date.now();
          const pending: PendingRoutingV1 = {
            channelId: p.channelId, questionId: routing.questionId, question: p.triggerBody,
            topicTitle: p.topicTitle, displayName: p.displayName, createdAt: nowMs,
            members: turn.asked.map((a) => ({
              memberSA: a.memberSA, displayName: a.displayName, taskId: a.taskId as Hex,
              sentAt: nowMs, deadlineAt: nowMs + consultMemberDeadlineMs(this.env), status: 'sent' as const,
            })),
          };
          await this.state.storage.put(routingPendingKey(p.channelId, routing.questionId), pending);
          await this.state.storage.put(AGENT_SA_KEY, p.principal.toLowerCase()); // alarm() rehydration
          await this.state.storage.setAlarm(Date.now() + ROUTING_POLL_MS);
        }
        // RESILIENCE INVARIANT (2026-07-17 live 502): a routing-extension failure degrades the turn
        // (audited below) — it never kills the base reply. Success ⇔ a reply was POSTED; the only
        // 502 left is the base turn itself failing to post, and that is never silent again.
        if (turn.degraded) {
          console.error(`[discussion-respond] routing degraded (step=${turn.degraded.step}): ${turn.degraded.cause}`);
          await audit.write({ id: crypto.randomUUID(), timestamp: new Date().toISOString(), action: 'interactions.routing.degraded', outcome: 'error', actor: { type: 'service', id: p.principal }, subject: routing ? { type: 'routing-question', id: routing.questionId } : { type: 'channel', id: p.channelId }, reason: `${turn.degraded.step}: ${turn.degraded.cause}`.slice(0, 500) }).catch(() => undefined);
        }
        if (!turn.posted) {
          const cause = turn.result.error ?? 'assistant turn completed without posting a reply';
          console.error(`[discussion-respond] 502 — no reply posted (step=turn outcome=${turn.result.outcome} planner=${turn.plannerKind}): ${cause}`);
          return Response.json({ ok: false, error: cause, plannerKind: turn.plannerKind }, { status: 502 });
        }
        return Response.json({ ok: true, messageId: turn.messageId, plannerKind: turn.plannerKind, asked: turn.asked.length, ...(turn.degraded ? { degraded: true } : {}) });
      } catch (e) {
        console.error(`[discussion-respond] 502 — dispatch threw (step=dispatch): ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
        return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 502 });
      }
    }
    // ── spec 329 §7 — steward routing disable: cancel this topic's pending consults (in-Worker,
    // marker-gated; called by the org's InteractionsDO). Cancellation is a DROP + audit — the
    // member-side tasks run to completion on their own store; their answers are simply never read.
    if (url.pathname === '/internal/routing-cancel') {
      const secret = this.env.A2A_CUSTODY_BRIDGE_SECRET;
      if (!secret || req.headers.get('x-ap-internal') !== secret) return Response.json({ ok: false, error: 'internal op — not authorized' }, { status: 403 });
      const p = (await req.json().catch(() => null)) as { channelId?: string } | null;
      if (!p?.channelId) return Response.json({ ok: false, error: 'channelId required' }, { status: 400 });
      const audit = buildAuditSink(this.env);
      const map = await this.state.storage.list({ prefix: `routing.pending:${p.channelId}:` });
      for (const key of map.keys()) {
        await this.state.storage.delete(key);
        await audit.write({ id: crypto.randomUUID(), timestamp: new Date().toISOString(), action: 'interactions.routing.cancelled', outcome: 'success', actor: { type: 'service', id: url.searchParams.get('agent') ?? '' }, subject: { type: 'routing-pending', id: key } }).catch(() => undefined);
      }
      return Response.json({ ok: true, cancelled: map.size });
    }
    // ── spec 329 §4.1 — consult-answer artifact read (in-Worker, marker-gated). The org's poller
    // has ALREADY proven itself via the signed tasks/get (caller = task sender, session-wrapped
    // signature verified); this body fetch re-checks sender-ship against the task record as the
    // belt. Bounded to a2a artifacts of the named task — never a general vault read.
    if (url.pathname === '/internal/consult-artifact') {
      const secret = this.env.A2A_CUSTODY_BRIDGE_SECRET;
      if (!secret || req.headers.get('x-ap-internal') !== secret) return Response.json({ ok: false, error: 'internal op — not authorized' }, { status: 403 });
      const p = (await req.json().catch(() => null)) as { taskId?: Hex; caller?: string; artifactId?: string } | null;
      if (!p?.taskId || !p.caller || !p.artifactId) return Response.json({ ok: false, error: 'taskId + caller + artifactId required' }, { status: 400 });
      const store = createDurableObjectTaskStore(this.state.storage);
      const rec = await store.get(p.taskId);
      if (!rec) return Response.json({ ok: false, error: 'unknown task' }, { status: 404 });
      if (rec.sender.toLowerCase() !== p.caller.toLowerCase()) return Response.json({ ok: false, error: 'only the task sender may read its artifacts' }, { status: 403 });
      const art = rec.artifacts.find((a) => String((a as { artifactId?: string }).artifactId ?? '').toLowerCase() === p.artifactId!.toLowerCase());
      if (!art) return Response.json({ ok: false, error: 'unknown artifact' }, { status: 404 });
      const body = await this.state.storage.get(`vault:${art.bodyRef.owner.toLowerCase()}:${art.bodyRef.recordType}`);
      return Response.json({ ok: true, body: body ?? null });
    }
    // ── spec 328 §4 — the person-inbox auto-reply turn (`inbox.respond`). IN-WORKER ONLY:
    // dispatched by the person's InteractionsDO after a triggering 1:1 delivery, gated by the
    // ARCH-H2 internal marker. Deliberately NOT an A2A skill on the public card — its
    // authorization model is "the person's own substrate observed a triggering delivery", so a
    // public `message/send` can never reach it (fail-closed by path, exactly like spec 327's
    // /internal/discussion-respond above).
    if (url.pathname === '/internal/inbox-respond') {
      const secret = this.env.A2A_CUSTODY_BRIDGE_SECRET;
      if (!secret || req.headers.get('x-ap-internal') !== secret) return Response.json({ ok: false, error: 'internal op — not authorized' }, { status: 403 });
      const p = (await req.json().catch(() => null)) as InboxRespondInput | null;
      if (!p || !/^0x[0-9a-f]{40}$/.test(String(p.principal ?? '')) || !p.conversationId) {
        return Response.json({ ok: false, error: 'principal + conversationId required' }, { status: 400 });
      }
      const stub = this.env.INTERACTIONS.get(this.env.INTERACTIONS.idFromName(p.principal.toLowerCase()));
      const call = async (op: string, payload: unknown): Promise<Record<string, unknown>> => {
        const resp = await stub.fetch(new Request(`https://do/interactions/${p.principal.toLowerCase()}/${op}`, {
          method: 'POST', headers: { 'content-type': 'application/json', 'x-ap-internal': secret }, body: JSON.stringify(payload),
        }));
        const out = (await resp.json().catch(() => ({}))) as Record<string, unknown> & { ok?: boolean; error?: string };
        if (!resp.ok || out.ok === false) throw new Error(out.error ?? `${op} failed (${resp.status})`);
        return out;
      };
      try {
        const turn = await handleInboxRespond(this.env, p, {
          readConversation: () => call('internal.inbox.read', { conversationId: p.conversationId }),
          post: async (bodyText) => (await call('internal.inbox.post', { conversationId: p.conversationId, bodyText })) as { messageId?: string },
        });
        if (turn.result.outcome !== 'completed' || !turn.posted) {
          return Response.json({ ok: false, error: turn.result.error ?? 'assistant turn completed without sending a reply', plannerKind: turn.plannerKind }, { status: 502 });
        }
        return Response.json({ ok: true, messageId: turn.messageId, plannerKind: turn.plannerKind });
      } catch (e) {
        return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 502 });
      }
    }
    // ── spec 334 §6 — the org agent's coordination-plan DRAFT turn. IN-WORKER ONLY: dispatched by
    // the org's InteractionsDO right after a steward adopted an EndeavorRequest. Runs the spec-327
    // single-tool planner over the goal, then posts the drafted steps back as a plan PROPOSAL via
    // `internal.endeavor.proposePlan` (org = actor; the steward reviews/edits/adopts).
    if (url.pathname === '/internal/endeavor-plan') {
      const secret = this.env.A2A_CUSTODY_BRIDGE_SECRET;
      if (!secret || req.headers.get('x-ap-internal') !== secret) return Response.json({ ok: false, error: 'internal op — not authorized' }, { status: 403 });
      const p = (await req.json().catch(() => null)) as { principal?: string; endeavorId?: string; goal?: string; autoWork?: boolean } | null;
      if (!p || !/^0x[0-9a-f]{40}$/.test(String(p.principal ?? '')) || !String(p.endeavorId ?? '').startsWith('end_') || !String(p.goal ?? '').trim()) {
        return Response.json({ ok: false, error: 'principal + endeavorId + goal required' }, { status: 400 });
      }
      const principal = p.principal!.toLowerCase();
      const endeavorId = p.endeavorId!;
      try {
        const playbook = await this.readOrgPlaybook(principal);
        const draft = await draftEndeavorPlan(this.env, { principal, endeavorId, goal: String(p.goal).trim(), playbook });
        const out = (await this.interactionsInternal(principal, 'internal.endeavor.proposePlan', {
          endeavorId,
          steps: draft.steps.map((s, i) => ({ stepId: `step_${i + 1}_${crypto.randomUUID().slice(0, 8)}`, kind: s.kind, description: s.description })),
        })) as { ok?: boolean; error?: string; planId?: string; revision?: number };
        // Auto-work: the SAME turn that drafted the plan now adopts + executes it (the agent does the
        // work). Off ⇒ draft-only, a steward reviews/adopts. Autopilot failures never fail the draft.
        let autopilot: { adopted?: boolean; stepsDone?: number; satisfied?: boolean } | undefined;
        if (p.autoWork) autopilot = await this.runEndeavorWork(principal, endeavorId).catch(() => undefined);
        return Response.json({ ok: true, planId: out.planId, revision: out.revision, steps: draft.steps.length, plannerKind: draft.plannerKind, ...(autopilot ? { autopilot } : {}) });
      } catch (e) {
        return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 502 });
      }
    }
    // spec 334 §6 auto-work — the org agent auto-triages (ADOPTS) a pending request, then the
    // adoption seeds the plan draft (which, being auto-work, chains into execute).
    if (url.pathname === '/internal/endeavor-adopt') {
      const secret = this.env.A2A_CUSTODY_BRIDGE_SECRET;
      if (!secret || req.headers.get('x-ap-internal') !== secret) return Response.json({ ok: false, error: 'internal op — not authorized' }, { status: 403 });
      const p = (await req.json().catch(() => null)) as { principal?: string; requestId?: string } | null;
      if (!p || !/^0x[0-9a-f]{40}$/.test(String(p.principal ?? '')) || !String(p.requestId ?? '').startsWith('ereq_')) {
        return Response.json({ ok: false, error: 'principal + requestId required' }, { status: 400 });
      }
      const principal = p.principal!.toLowerCase();
      try {
        const out = (await this.interactionsInternal(principal, 'internal.endeavor.create', { requestId: p.requestId })) as { ok?: boolean; error?: string; endeavorId?: string };
        return Response.json({ ok: true, endeavorId: out.endeavorId });
      } catch (e) {
        return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 502 });
      }
    }
    // spec 334 §6 auto-work — run the autopilot for one endeavor (adopt latest plan if needed →
    // execute every open step the principal can do itself → satisfy).
    if (url.pathname === '/internal/endeavor-work') {
      const secret = this.env.A2A_CUSTODY_BRIDGE_SECRET;
      if (!secret || req.headers.get('x-ap-internal') !== secret) return Response.json({ ok: false, error: 'internal op — not authorized' }, { status: 403 });
      const p = (await req.json().catch(() => null)) as { principal?: string; endeavorId?: string } | null;
      if (!p || !/^0x[0-9a-f]{40}$/.test(String(p.principal ?? '')) || !String(p.endeavorId ?? '').startsWith('end_')) {
        return Response.json({ ok: false, error: 'principal + endeavorId required' }, { status: 400 });
      }
      const principal = p.principal!.toLowerCase();
      try {
        const result = await this.runEndeavorWork(principal, p.endeavorId!);
        return Response.json({ ok: true, ...result });
      } catch (e) {
        return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 502 });
      }
    }
    const agentSA = (url.searchParams.get('agent') ?? (await this.state.storage.get<string>(AGENT_SA_KEY))) as Address | null;
    if (!agentSA) return Response.json({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'agent not bound to this task store' } }, { status: 400 });
    await this.state.storage.put(AGENT_SA_KEY, agentSA); // remember for alarm() rehydration
    const agent = this.build(agentSA);

    let body: { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };
    try { body = await req.json(); } catch { return Response.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); }
    if (body.params && typeof body.method === 'string' && DELEGATION_METHODS.has(body.method) && body.params.delegation) {
      body.params = { ...body.params, delegation: normalizeDelegation(body.params.delegation as Record<string, unknown>) };
    }
    const resp = await dispatchA2aRpc(agent, body);
    // Schedule the runtime to advance any newly-due task (alarm() runs processDue()).
    if (body.method === 'message/send' || body.method === 'tasks/resubmit') await this.state.storage.setAlarm(Date.now() + ALARM_DELAY_MS);
    return Response.json(resp);
  }

  async alarm(): Promise<void> {
    const agentSA = await this.state.storage.get<string>(AGENT_SA_KEY);
    if (!agentSA) return;
    const agent = this.build(agentSA as Address);
    await agent.processDue();
    // spec 329 §4.1 turn 2 — advance the org's pending consult fan-outs (poll → collect →
    // synthesize). Isolated from task processing: a routing failure never stalls the task loop.
    let routingRemain = false;
    try {
      routingRemain = await this.processRoutingDue(agentSA.toLowerCase());
    } catch {
      // A total failure of the poll must NOT strand a pending fan-out: re-arm as long as any
      // routed question is still pending, so the next alarm retries (the poll is idempotent).
      try {
        routingRemain = (await this.state.storage.list({ prefix: 'routing.pending:', limit: 1 })).size > 0;
      } catch { routingRemain = false; }
    }
    // If anything remains due (e.g. auth-required→resubmit just landed), re-arm.
    const store = createDurableObjectTaskStore(this.state.storage);
    if ((await store.listDue(Date.now())).length > 0) await this.state.storage.setAlarm(Date.now() + ALARM_DELAY_MS);
    else if (routingRemain) await this.state.storage.setAlarm(Date.now() + ROUTING_POLL_MS);
  }

  // ── spec 329 W3 — the org-side routing engine (ask → poll → synthesize) ────────────────────────

  /** In-Worker call to a principal's InteractionsDO internal op (ARCH-H2 marker). */
  /** spec 327 §4b / 334 §6 — the org's steward-authored playbook (SKILL.md), read once per
   *  coordination dispatch so the plan-draft and work turns speak in the org's own voice/policy.
   *  Best-effort ENRICHMENT: a missing doc or a read failure returns '' and the turn keeps its
   *  built-in contract unchanged — never fail a draft or a step over the playbook. */
  private async readOrgPlaybook(principal: string): Promise<string> {
    try {
      const out = (await this.interactionsInternal(principal, 'internal.assistantSkill.get', {})) as { skillMarkdown?: string };
      return String(out.skillMarkdown ?? '').trim();
    } catch { return ''; }
  }

  private async interactionsInternal(principal: string, op: string, payload: unknown): Promise<Record<string, unknown>> {
    const secret = this.env.A2A_CUSTODY_BRIDGE_SECRET;
    if (!secret) throw new Error('no internal marker configured');
    const stub = this.env.INTERACTIONS.get(this.env.INTERACTIONS.idFromName(principal.toLowerCase()));
    const resp = await stub.fetch(new Request(`https://do/interactions/${principal.toLowerCase()}/${op}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-ap-internal': secret }, body: JSON.stringify(payload),
    }));
    const out = (await resp.json().catch(() => ({}))) as Record<string, unknown> & { ok?: boolean; error?: string };
    if (!resp.ok || out.ok === false) throw new Error(out.error ?? `${op} failed (${resp.status})`);
    return out;
  }

  /** spec 334 §6 auto-work autopilot for ONE endeavor: adopt the latest plan revision if none is
   *  adopted yet, then execute every OPEN step the principal can do itself (a step turn produces the
   *  deliverable, which is posted to the endeavor conversation and recorded as the step's completion
   *  evidence), and finally satisfy the endeavor. Idempotent: re-runs skip satisfied steps and stop
   *  at whatever the reducer refuses (a step needing another party's authority stays open, honestly).
   *  All actor authority is the reducer's managing-principal gate (the org/person acting on itself).
   */
  private async runEndeavorWork(principal: string, endeavorId: string): Promise<{ adopted: boolean; stepsDone: number; satisfied: boolean }> {
    type PlanStep = { stepId: string; kind: string; description: string; satisfied: boolean };
    type StateOut = {
      lifecycle: string | null; goal: string; requester: string | null;
      adoptedPlanRef: { planId: string; revision: number; hash: string } | null;
      latestPlan: { planId: string; revision: number; contentHash: string } | null;
      plan: { planId: string; revision: number; contentHash: string; steps: PlanStep[] } | null;
    };
    let state = (await this.interactionsInternal(principal, 'internal.endeavor.state', { endeavorId })) as StateOut & { ok?: boolean };
    if (state.lifecycle !== 'adopted' && state.lifecycle !== 'active') return { adopted: false, stepsDone: 0, satisfied: state.lifecycle === 'satisfied' };

    // The org's playbook applies to every step turn and the synthesis, so read it ONCE for the run
    // (spec 327 §4b / 334 §6). '' when the steward authored none — the turns keep their built-ins.
    const playbook = await this.readOrgPlaybook(principal);

    // spec 334 §6 gather phase — the agent authors read-only queries against the PUBLIC graph AND
    // reads the org's OWN records (via the read-only coordination grant, if the steward enabled it),
    // collecting the facts the goal needs ONCE per run (shared by every step + the synthesis). Pure
    // enrichment: no endpoint/grant/LLM ⇒ '' and the run proceeds exactly as before.
    const references = await gatherReferenceContext(this.env, {
      goal: state.goal || 'the endeavor goal', playbook, principal, endeavorId,
      // Fulfil read_org_record through the InteractionsDO, which holds the coordination-read grant.
      readOrgRecord: (recordType) =>
        this.interactionsInternal(principal, 'internal.coordination.vaultRead', { recordType })
          .then((r) => ({ ok: r.ok === true, data: (r as { data?: unknown }).data, error: (r as { error?: string }).error, needsEnable: (r as { needsEnable?: boolean }).needsEnable }))
          .catch((e) => ({ ok: false, error: e instanceof Error ? e.message : String(e) })),
    }).catch(() => '');

    // 1) Adopt the latest proposed plan if nothing is adopted yet (the org adopting its own draft).
    let adopted = !!state.adoptedPlanRef;
    if (!adopted && state.latestPlan) {
      await this.interactionsInternal(principal, 'internal.endeavor.adoptPlan', {
        endeavorId,
        planRef: { planId: state.latestPlan.planId, revision: state.latestPlan.revision, hash: state.latestPlan.contentHash },
      });
      adopted = true;
      state = (await this.interactionsInternal(principal, 'internal.endeavor.state', { endeavorId })) as StateOut & { ok?: boolean };
    }
    const plan = state.plan;
    if (!plan) return { adopted, stepsDone: 0, satisfied: false };

    // 2) Execute each open step. Bounded (≤ plan length, hard cap 12) — no unbounded loop. Turns
    //    are PACED (short IO sleep between model calls) so a 6-step run doesn't burst straight into
    //    the provider's per-minute rate limit — that burst is what used to drop steps 2..n to the
    //    "picked up" fallback.
    const goal = state.goal || 'the endeavor goal';
    const priorOutputs: Array<{ description: string; output: string }> = [];
    const pace = (): Promise<void> => new Promise((r) => setTimeout(r, 2_500));
    let stepsDone = 0;
    let firstTurn = true;
    for (const step of plan.steps.slice(0, 12)) {
      if (step.satisfied) continue;
      if (!firstTurn) await pace();
      firstTurn = false;
      let output: string;
      try {
        const turn = await executeEndeavorStep(this.env, {
          principal, endeavorId, goal, stepKind: step.kind, stepDescription: step.description, priorOutputs, playbook, references,
        });
        output = turn.output;
      } catch {
        continue; // this step couldn't be done autonomously — leave it open for a human
      }
      // Post the deliverable to the endeavor conversation (visible provenance), then record it as the
      // step's completion evidence. A satisfyStep refusal (reducer gate) stops the run for this step.
      await this.interactionsInternal(principal, 'internal.endeavor.post', {
        endeavorId, bodyText: `[agent] ${step.description}\n\n${output}`,
      }).catch(() => undefined);
      try {
        await this.interactionsInternal(principal, 'internal.endeavor.satisfyStep', { endeavorId, stepId: step.stepId, evidence: output });
        priorOutputs.push({ description: step.description, output });
        stepsDone += 1;
      } catch {
        break; // the reducer refused (e.g. this step needs another party) — stop cleanly
      }
    }

    // 3) If every step is now satisfied, satisfy the endeavor (the coordinator confirming the outcome).
    const after = (await this.interactionsInternal(principal, 'internal.endeavor.state', { endeavorId })) as StateOut & { ok?: boolean };
    const allDone = !!after.plan && after.plan.steps.length > 0 && after.plan.steps.every((s) => s.satisfied);
    let satisfied = after.lifecycle === 'satisfied';
    if (allDone && !satisfied) {
      // Synthesize the requester-facing OUTCOME — the actual answer to their goal, not a process
      // recap — from every step's deliverable. Recorded as the EndeavorSatisfied outcome ref (the
      // "what came of it" the requester reads). Falls back to a plain count if no model is configured.
      let outcomeNote = `Completed ${after.plan!.steps.length} plan steps for "${goal}".`;
      try {
        if (!firstTurn) await pace(); // don't burst straight from the last step turn into synthesis
        const synth = await synthesizeEndeavorOutcome(this.env, { principal, endeavorId, goal, deliverables: priorOutputs, playbook, references });
        if (synth.answer.trim()) outcomeNote = synth.answer.trim();
      } catch { /* keep the deterministic count */ }
      await this.interactionsInternal(principal, 'internal.endeavor.satisfy', {
        endeavorId, note: outcomeNote,
      }).catch(() => undefined);
      const final = (await this.interactionsInternal(principal, 'internal.endeavor.state', { endeavorId }).catch(() => ({}))) as { lifecycle?: string };
      satisfied = final.lifecycle === 'satisfied';
      // Notify the requester in their 1:1 inbox that the work is done, carrying the outcome (spec
      // 334 §7). Best-effort: a requester who hasn't enabled inbox delivery simply isn't messaged —
      // the outcome still shows in their My Work. A message is never authority (ADR-0041).
      const requester = after.requester ?? state.requester;
      if (satisfied && requester && requester !== principal.toLowerCase()) {
        await this.deliverEndeavorOutcomeNotice(principal, requester, goal, outcomeNote).catch(() => undefined);
      }
    }
    return { adopted, stepsDone, satisfied };
  }

  /** Deliver a "your request is complete" message from `fromSa` (the working agent) to the
   *  requester's 1:1 inbox, carrying the outcome text (spec 334 §7). Constructs a valid message
   *  envelope server-side and admits it via the recipient's InteractionsDO — the SAME
   *  `internal.dm.body.put` + `internal.deliver` pair the a2a messaging.deliver skill uses (the
   *  recipient's DO holds its own delivery wire; the public route refuses `internal.*`). Agent-
   *  authored (`actor` set) so it does not trigger the requester's own auto-reply. Fail-closed:
   *  a recipient without inbox delivery enabled simply can't receive (the caller drops the error). */
  private async deliverEndeavorOutcomeNotice(fromSa: string, recipient: string, goal: string, outcome: string): Promise<void> {
    const chainId = Number(this.env.CHAIN_ID ?? 84532);
    const fromCaip = caip10(chainId, fromSa.toLowerCase() as Address) as MessageEnvelopeV1['from'];
    const toCaip = caip10(chainId, recipient.toLowerCase() as Address) as MessageEnvelopeV1['from'];
    const now = new Date().toISOString();
    const messageId = generateMessageId();
    const subject = `Your request is complete: ${goal}`.slice(0, 120);
    const bodyText = `Your request has been completed.\n\nRequest: ${goal}\n\nOutcome:\n${outcome}`;
    const bodyBytes = new TextEncoder().encode(bodyText);
    const envelope: MessageEnvelopeV1 = {
      version: 'ap.message.v1',
      id: messageId,
      conversationId: generateConversationId(),
      kind: 'plain',
      from: fromCaip,
      to: [toCaip],
      subject,
      createdAt: now,
      classification: 'internal',
      body: { resource: messageBodyResource(messageId), classification: 'internal', updatedAt: now },
      bodyHash: await sha256Hex32(bodyBytes),
      bodyContentType: 'text/plain',
      actor: fromCaip,
    };
    const errors = validateMessageEnvelope(envelope);
    if (errors.length > 0) throw new Error(`invalid outcome envelope: ${errors.join(', ')}`);
    let bin = '';
    for (const b of bodyBytes) bin += String.fromCharCode(b);
    const stored = { b64: btoa(bin), contentType: 'text/plain', bodyHash: envelope.bodyHash };
    await this.interactionsInternal(recipient, 'internal.dm.body.put', { resource: envelope.body.resource, data: stored });
    await this.interactionsInternal(recipient, 'internal.deliver', { envelope });
  }

  /** Session-wrapped org signature over a consult-rail digest (§3.1): the interactions-session
   *  KMS key signs; the steward-minted org wire authorizes. No raw key at rest. */
  private async signAsOrg(orgWire: IncomingDelegation, digest: Hex): Promise<Hex> {
    const signer = await interactionsSessionAccount(this.env);
    const signRaw = signer.sign;
    if (!signRaw) throw new Error('interactions-session KMS account lacks raw-digest sign');
    return wrapRoutedConsultSignature(orgWire, await signRaw({ hash: digest }));
  }

  /**
   * `ask_member`'s executor: SEND-TIME grant re-read (member revoke is immediate — no grant, no
   * consult, no exception), the bounded ConsultRequest, the org-signed `message/send` to the
   * member's A2A endpoint (the shared demo-a2a host: every agent's endpoint terminates at its own
   * A2aTaskDO — the same dispatch `/api/a2a` performs after Host resolution), and the
   * ConsultationIntent description record. The member's gate re-verifies EVERYTHING on-chain.
   */
  private async submitConsult(args: {
    org: string; orgWire: IncomingDelegation; memberSA: string; question: string;
    channelId: string; questionId: string; topicTitle?: string; tail?: Array<{ author: string; bodyText: string }>;
  }): Promise<{ taskId: string }> {
    const audit = buildAuditSink(this.env);
    const memberSA = args.memberSA.toLowerCase();
    const grantResp = (await this.interactionsInternal(args.org, 'internal.consult.grant', { member: memberSA })) as { wire?: IncomingDelegation | null };
    if (!grantResp.wire) {
      await audit.write({ id: crypto.randomUUID(), timestamp: new Date().toISOString(), action: 'interactions.routing.consultSent', outcome: 'denied', actor: { type: 'service', id: args.org }, subject: { type: 'consult', id: `${args.questionId}:${memberSA}` }, reason: 'consult grant absent at send time (revoked?)' }).catch(() => undefined);
      throw new Error('member consult grant is not present (revoked?) — not asking');
    }
    const request = buildConsultRequest({
      question: args.question, orgSA: args.org, topicId: args.channelId, questionId: args.questionId,
      ...(args.topicTitle ? { topicTitle: args.topicTitle } : {}), ...(args.tail?.length ? { tail: args.tail } : {}),
    });
    const idBytes = new Uint8Array(32);
    crypto.getRandomValues(idBytes);
    const messageId = (`0x${Array.from(idBytes, (b) => b.toString(16).padStart(2, '0')).join('')}`) as Hex;
    const createdAt = Math.floor(Date.now() / 1000);
    const bodyHash = hashBody(request);
    const digest = hashA2aMessage({ messageId, sender: args.org as Address, skill: CONSULT_SKILL_ID, bodyHash, createdAt });
    const signature = await this.signAsOrg(args.orgWire, digest);
    const message = {
      messageId, sender: args.org, skill: CONSULT_SKILL_ID,
      bodyRef: { owner: memberSA, recordType: 'pending' }, bodyHash, createdAt, signature,
    };
    const stub = this.env.A2A_TASKS.get(this.env.A2A_TASKS.idFromName(memberSA));
    const resp = await stub.fetch(new Request(`https://a2a-task-do/rpc?agent=${memberSA}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: messageId, method: 'message/send',
        params: { delegation: grantResp.wire, requester: args.org, message, input: request },
      }),
    }));
    const out = (await resp.json().catch(() => ({}))) as { result?: { taskId?: string }; error?: { message?: string } };
    if (!out.result?.taskId) {
      await audit.write({ id: crypto.randomUUID(), timestamp: new Date().toISOString(), action: 'interactions.routing.consultSent', outcome: 'denied', actor: { type: 'service', id: args.org }, subject: { type: 'consult', id: `${args.questionId}:${memberSA}` }, reason: out.error?.message ?? 'message/send rejected' }).catch(() => undefined);
      throw new Error(out.error?.message ?? 'consult message/send was rejected by the member\'s gate');
    }
    // spec 329 §5 — the ConsultationIntent DESCRIPTION record (expressed at send; the spine
    // describes, the task rail executes). DO-side custody (the W1 §2.1 deviation's rationale:
    // no deployed vault scope covers routing.* and widening forces a fleet re-enable).
    await this.state.storage.put(
      consultationIntentKey(args.questionId, memberSA),
      buildConsultationIntentRecord({ questionId: args.questionId, orgSA: args.org, memberSA, topicId: args.channelId }),
    );
    await audit.write({ id: crypto.randomUUID(), timestamp: new Date().toISOString(), action: 'interactions.routing.consultSent', outcome: 'success', actor: { type: 'service', id: args.org }, subject: { type: 'consult', id: `${args.questionId}:${memberSA}` } }).catch(() => undefined);
    return { taskId: out.result.taskId };
  }

  /** Read one completed consult's answer artifact from the MEMBER's runtime (marker-gated body
   *  fetch AFTER the signed tasks/get proved sender-ship — see /internal/consult-artifact). */
  private async readConsultArtifact(memberSA: string, taskId: Hex, org: string, artifactId: string): Promise<unknown> {
    const secret = this.env.A2A_CUSTODY_BRIDGE_SECRET ?? '';
    const stub = this.env.A2A_TASKS.get(this.env.A2A_TASKS.idFromName(memberSA));
    const resp = await stub.fetch(new Request(`https://a2a-task-do/internal/consult-artifact?agent=${memberSA}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-ap-internal': secret },
      body: JSON.stringify({ taskId, caller: org, artifactId }),
    }));
    const out = (await resp.json().catch(() => ({}))) as { ok?: boolean; body?: unknown; error?: string };
    if (!resp.ok || out.ok !== true) throw new Error(out.error ?? `consult artifact read failed (${resp.status})`);
    return out.body ?? null;
  }

  /**
   * Advance every pending routed question (alarm-driven — spec 329 §4.1 turn 2). Per member:
   * SIGNED `tasks/get` on their runtime (the §3.1 wire authorizes the caller signature) →
   * completed ⇒ artifact read + ConsultAnswer validation + mid-flight-revoke re-check; terminal
   * failure ⇒ failed; past deadline ⇒ timedOut. When all resolve, run the ONE synthesis turn
   * (single tool, attribution + PROV + routed-consultation contextRef) and clear the entry.
   * Returns whether anything remains pending (the alarm re-arms on true).
   */
  private async processRoutingDue(orgSA: string): Promise<boolean> {
    const pendingMap = await this.state.storage.list({ prefix: 'routing.pending:' });
    if (pendingMap.size === 0) return false;
    const audit = buildAuditSink(this.env);
    // Steward disable is immediate: an absent wire (or one cleared mid-flight) cancels everything.
    // BUT a wire READ can also fail TRANSIENTLY (a DO-to-DO hiccup), and this poll re-reads the wire
    // on EVERY cadence tick — a long fan-out (3 slow member turns held for the full deadline) runs
    // dozens of ticks, so a single transient read failure treated as "wire absent" would wrongly
    // CANCEL the whole routed question and no synthesis would ever post (observed live: N=2 finishes
    // in ~12 ticks and synthesizes; N=3 ran ~60 ticks and stalled). So DISTINGUISH a genuine absence
    // (read succeeded, wire null ⇒ steward disabled ⇒ cancel) from a transient read failure (retry
    // next tick, never cancel). Fail-OPEN toward the in-flight consult; steward disable still cancels.
    let orgWire: IncomingDelegation | null = null;
    let wireReadOk = true;
    try {
      orgWire = ((await this.interactionsInternal(orgSA, 'internal.consult.orgWire', {})) as { wire?: IncomingDelegation | null }).wire ?? null;
    } catch { wireReadOk = false; }
    let remain = false;
    for (const [key, value] of pendingMap) {
      const pending = value as PendingRoutingV1;
      if (!wireReadOk) {
        // Transient wire-read failure — do NOT cancel; keep the entry and re-poll on the next alarm.
        remain = true;
        continue;
      }
      if (!orgWire) {
        await this.state.storage.delete(key);
        await audit.write({ id: crypto.randomUUID(), timestamp: new Date().toISOString(), action: 'interactions.routing.cancelled', outcome: 'success', actor: { type: 'service', id: orgSA }, subject: { type: 'routing-pending', id: key }, reason: 'org consult wire absent (routing disabled)' }).catch(() => undefined);
        continue;
      }
      const now = Date.now();
      for (const m of pending.members) {
        if (m.status !== 'sent') continue;
        try {
          const issuedAt = Math.floor(now / 1000);
          const digest = hashA2aTaskRequest({ method: 'tasks/get', taskId: m.taskId, agentSA: m.memberSA as Address, chainId: Number(this.env.CHAIN_ID ?? 84532), issuedAt });
          const signature = await this.signAsOrg(orgWire, digest);
          const stub = this.env.A2A_TASKS.get(this.env.A2A_TASKS.idFromName(m.memberSA));
          const resp = await stub.fetch(new Request(`https://a2a-task-do/rpc?agent=${m.memberSA}`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: m.taskId, method: 'tasks/get', params: { taskId: m.taskId, caller: orgSA, signature, issuedAt } }),
          }));
          const out = (await resp.json().catch(() => ({}))) as { result?: { state?: string; artifactRefs?: VaultRef[] }; error?: { message?: string } };
          const state = out.result?.state;
          if (state === 'completed') {
            const ref = (out.result?.artifactRefs ?? []).find((r) => r.recordType?.startsWith('a2a:artifact:'));
            const artifactId = ref?.recordType?.slice('a2a:artifact:'.length);
            if (!artifactId) m.status = 'failed';
            else {
              const body = (await this.readConsultArtifact(m.memberSA, m.taskId, orgSA, artifactId)) as ConsultAnswerV1 | null;
              const valid = !!body && validateConsultAnswer(body).length === 0
                && body.questionId === pending.questionId
                && body.orgSA === orgSA
                && String(body.actor).toLowerCase().endsWith(m.memberSA);
              if (!valid) m.status = 'failed';
              else {
                // Mid-flight revoke (spec 329 W4 rule): grant gone between turn 1 and now ⇒ the
                // answer is DISCARDED and the attribution says so.
                let grantStill = false;
                try { grantStill = !!((await this.interactionsInternal(orgSA, 'internal.consult.grant', { member: m.memberSA })) as { wire?: unknown }).wire; } catch { grantStill = false; }
                if (!grantStill) m.status = 'revoked';
                else { m.status = body.declined === true ? 'declined' : 'answered'; m.answer = body; }
              }
            }
          } else if (state === 'failed' || state === 'rejected' || state === 'canceled') {
            m.status = 'failed';
          } else if (now > m.deadlineAt) {
            m.status = 'timedOut';
          }
        } catch {
          // Transient poll failure — retry until the deadline, then time out honestly.
          if (now > m.deadlineAt) m.status = 'timedOut';
        }
        if (m.status !== 'sent') {
          await audit.write({ id: crypto.randomUUID(), timestamp: new Date().toISOString(), action: 'interactions.routing.consultResolved', outcome: m.status === 'answered' || m.status === 'declined' ? 'success' : 'error', actor: { type: 'service', id: orgSA }, subject: { type: 'consult', id: `${pending.questionId}:${m.memberSA}` }, reason: m.status }).catch(() => undefined);
        }
      }
      const allDone = pending.members.every((m) => m.status !== 'sent');
      if (!allDone) {
        await this.state.storage.put(key, pending);
        remain = true;
        continue;
      }
      // ── TURN 2 — the synthesis turn (tolerates partial failure: whatever resolved is used). ──
      try {
        const outcomes: ConsultOutcomeV1[] = pending.members.map((m) => ({
          memberSA: m.memberSA, displayName: m.displayName, status: m.status as ConsultOutcomeV1['status'],
          ...(m.answer && m.status !== 'revoked' ? { answer: m.answer } : {}),
        }));
        const ctxRef = routedConsultationContextRef(orgSA, pending.channelId, pending.questionId);
        const prov = buildConsultProvenance(pending.questionId, outcomes);
        const turn = await handleConsultSynthesis(this.env, {
          principal: orgSA, channelId: pending.channelId, topicTitle: pending.topicTitle,
          displayName: pending.displayName, question: pending.question, questionId: pending.questionId, outcomes,
        }, {
          readTopic: () => this.interactionsInternal(orgSA, 'internal.channels.read', { channelId: pending.channelId }),
          post: async (bodyText) => (await this.interactionsInternal(orgSA, 'internal.channels.post', { channelId: pending.channelId, bodyText, contextRefs: [ctxRef], prov })) as { messageId?: string },
        });
        if (turn.result.outcome !== 'completed' || !turn.posted) throw new Error(turn.result.error ?? 'synthesis turn completed without posting');
        // Spine lifecycle (spec 329 §5): fulfilled for contributing consults, abandoned otherwise.
        for (const o of outcomes) {
          const ikey = consultationIntentKey(pending.questionId, o.memberSA);
          const rec = (await this.state.storage.get(ikey)) as ConsultationIntentV1 | undefined;
          if (rec) {
            await this.state.storage.put(ikey, {
              ...rec,
              status: o.status === 'answered' ? 'fulfilled' as const : 'abandoned' as const,
              object: o.status === 'answered' ? ikey : rec.object,
            });
          }
        }
        await audit.write({ id: crypto.randomUUID(), timestamp: new Date().toISOString(), action: 'interactions.routing.synthesisPost', outcome: 'success', actor: { type: 'service', id: orgSA }, subject: { type: 'channel-post', id: turn.messageId ?? pending.questionId } }).catch(() => undefined);
        await this.state.storage.delete(key);
      } catch (e) {
        const attempts = (pending.synthesisAttempts ?? 0) + 1;
        if (attempts >= ROUTING_SYNTHESIS_MAX_ATTEMPTS) {
          await audit.write({ id: crypto.randomUUID(), timestamp: new Date().toISOString(), action: 'interactions.routing.synthesisPost', outcome: 'error', actor: { type: 'service', id: orgSA }, subject: { type: 'routing-pending', id: key }, reason: `dropped after ${attempts} attempts: ${e instanceof Error ? e.message : String(e)}` }).catch(() => undefined);
          await this.state.storage.delete(key);
        } else {
          pending.synthesisAttempts = attempts;
          await this.state.storage.put(key, pending);
          remain = true;
        }
      }
    }
    return remain;
  }
}
