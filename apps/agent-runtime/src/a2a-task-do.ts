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
import { chainFor } from './chain';
import { hashDelegation, type Delegation } from '@agenticprimitives/delegation';
import { checkSessionWireShape } from '@agenticprimitives/a2a';
import { buildArchetypeCatalog, chooseArchetypeRoute, resolveArchetypeMethod, type ArchetypeHostGrant, type LibraryPackageMeta } from './archetype-skill.js';
import {
  createA2aAgent,
  hashA2aMessage,
  type A2aAgent,
  type A2aBudgetPort,
  type OnChainChecks,
  type VaultClient,
  type McpClient,
  type SkillHandler,
} from '@agenticprimitives/a2a';
import { createAgentBackedServer, createMemoryTaskStore } from '@agenticprimitives/a2a/standard';
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
import { endeavorRequestFromA2aTask, parseEndeavorRequestInput, parseEndeavorStateInput, ENDEAVOR_REQUEST_SKILL_ID, ENDEAVOR_STATE_SKILL_ID } from './endeavor-intake.js';
import { handleDiscussionRespond, topicReplyGuidance, type DiscussionRespondInput } from './discussion-skill.js';
import { draftEndeavorPlan } from './endeavor-plan-skill.js';
import { executeEndeavorStep, synthesizeEndeavorOutcome, gatherReferenceContext } from './endeavor-work-skill.js';
import { handleInboxRespond, type InboxRespondInput } from './inbox-skill.js';
import { handleConsultRespond } from './consult-skill.js';
import { parseSessionWrappedSignature, verifySessionWrappedSignature, wrapSessionSignature } from '@agenticprimitives/a2a';
// spec 341 §7 — the in-Worker marker, split off the custody secret.
import { internalHeaders, internalMarker, isInternalCall } from './internal-marker.js';
import { memberConsultGrant, readConsultArtifact, readDelegatedTask, signAsOrg, submitConsult, submitDelegatedTask } from './consult-rail.js';
import { recordRetention } from './run-export.js';
import { authorityCapabilityOf, checkpointForStep, awaitingAuthorityNote, engagesProvider } from './endeavor-authority-steps.js';
import { runEngagementCampaign, campaignNote } from './engagement-campaign.js';
import { loadPlaybook } from '@agenticprimitives/harness';
import { discoveryFetchFor } from './context-wiring.js';
import { scopedActionTools } from './harness-run.js';
import { messagingScopeCovers, messagingScopeDepsFromEnv } from './messaging-scope.js';
import { fetchDiscoveryFacets } from './discovery-facets.js';
import { MEMBER_CONSULT_TOOL } from './member-consult.js';
import { makeMessagingSkills, makeOrgApplySkill } from './messaging-skills.js';
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
  fixedWindowAllow,
  generateConversationId,
  generateMessageId,
  messageBodyResource,
  parseConsultRequest,
  rankConsultCandidates,
  routedConsultationContextRef,
  sha256Hex32,
  validateMessageEnvelope,
  type ConsultationIntentV1,
  type EligibleConsultMemberV1,
  type FixedWindowState,
  type MessageEnvelopeV1,
  type AnyMessageEnvelope,
  type MessageEnvelopeV2,
} from '@agenticprimitives/fabric/messaging';
// FR-3.4 — deliver artifacts into a principal's demo-mcp vault over their delegation. The value import is
// cyclic with index.ts, but safe: `callMcpToolViaDelegation` is a hoisted function used only at request
// time (never at module-init), and `Env`/`IncomingDelegation` are type-only.
import { buildAuditSink, callMcpToolWithProof, interactionsSessionAccount, runUnattendedAsk, runAgentAsk, fireTriggersAt, harnessDeps, probeSenderFor, candidateSourceFor, type Env, type IncomingDelegation } from './index.js';
import { dueNow, advanced, messageTriggerSource, type TriggerScheduleV1 } from './triggers.js';
import { ERC1271_MAGIC_VALUE as ERC1271_MAGIC } from '@agenticprimitives/types';

/** How long an unfinished harness run stays resumable. A day is well past the point: the mandate a
 *  suspended run holds expires in minutes, so a stale checkpoint offers a resume that would have to ask
 *  for fresh authority anyway. See the `list` op for why they are swept there rather than on a timer. */
const RUN_TTL_MS = 24 * 60 * 60 * 1000;
const ERC1271_ABI = [{ type: 'function', name: 'isValidSignature', stateMutability: 'view', inputs: [{ name: 'hash', type: 'bytes32' }, { name: 'signature', type: 'bytes' }], outputs: [{ name: 'magic', type: 'bytes4' }] }] as const;
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

/**
 * File an A2A task as an EndeavorRequest against the managing principal (spec 334 §4 door 4). ONE
 * path, shared by the two callers that raise coordination work from a task: `orchestrate`'s opt-in
 * (`input.endeavor: true`) and the narrow `endeavor.request` skill. The requester is always the
 * DELEGATION-VERIFIED task sender, and the provenance (`entryPoint`, `intakeContext`) is always
 * built here from the task — never read from caller input, which would let a sender forge which
 * door raised the work.
 */
async function fileEndeavorIntake(
  env: Env,
  args: { principal: Address; sender: Address; taskId: Hex; goal: string },
): Promise<{ ok: true; requestId: string } | { ok: false; error: string }> {
  if (!internalMarker(env)) return { ok: false, error: 'endeavor intake requires A2A_INTERNAL_MARKER' };
  const opBody = endeavorRequestFromA2aTask({ taskId: args.taskId, goal: args.goal });
  const target = args.principal.toLowerCase();
  const stub = env.INTERACTIONS.get(env.INTERACTIONS.idFromName(target));
  const resp = await stub.fetch(new Request(`https://do/interactions/${target}/internal.endeavor.request`, {
    method: 'POST',
    headers: internalHeaders(env),
    body: JSON.stringify({ ...opBody, requester: args.sender.toLowerCase() }),
  }));
  const out = (await resp.json().catch(() => ({}))) as { ok?: boolean; requestId?: string; error?: string };
  if (!resp.ok || !out.ok || !out.requestId) {
    return { ok: false, error: `endeavor intake failed: ${out.error ?? `status ${resp.status}`}` };
  }
  return { ok: true, requestId: out.requestId };
}

/**
 * The `endeavor.request` skill — the NARROW coordination door, and the one the Operational Intent
 * grant (`org → agent`) actually names. Its entire body is the intake: submit a goal, get a
 * requestId. It plans nothing, calls no MCP tool, and touches no vault record.
 *
 * WHY IT EXISTS SEPARATELY FROM `orchestrate`. The A2A gate authorizes a message by the SKILL IT
 * NAMES (`allowedMethods` vs `skillSelector(message.skill)`), so a grant can only be as narrow as
 * the narrowest skill that does the job. Before this handler, the only way to reach coordination
 * intake was `orchestrate` with `input.endeavor: true` — and `orchestrate` runs the planner over the
 * principal's MCP tools under the task's delegation. A dispatcher granted `orchestrate` to submit an
 * intent would also hold general agent execution. That is the over-grant the Operational Intent
 * design refused when it refused `A2A_ANY_SKILL`; this skill is what makes refusing it possible.
 * `discussion.consult` is the same shape one relationship over: one narrow registered skill, one
 * selector, one grant.
 *
 * Registered on EVERY agent's DO, like consult — REACHABILITY is the delegation gate's alone. The
 * belts here are the ones the gate cannot see:
 *   • delegator === THIS agent: the grant must be the org's own (`ctx.principal === agentSA`). A
 *     third party's grant that merely names this agent as a target is not intake authority.
 *   • no caller-supplied provenance: `entryPoint` / `intakeContext` in the body are REFUSED rather
 *     than ignored, because a silently-dropped forgery attempt is still a forgery attempt.
 */
function makeEndeavorRequestSkill(env: Env, agentSA: Address): SkillHandler {
  return {
    skill: ENDEAVOR_REQUEST_SKILL_ID,
    handle: async (ctx) => {
      const audit = buildAuditSink(env);
      const sender = ctx.sender.toLowerCase();
      const auditRow = (outcome: 'success' | 'denied', id: string, reason?: string) =>
        audit.write({
          id: crypto.randomUUID(), timestamp: new Date().toISOString(), action: 'a2a.endeavor.requested', outcome,
          actor: { type: 'service', id: sender }, subject: { type: 'endeavor-request', id },
          ...(reason ? { reason } : {}),
        }).catch(() => undefined);

      // The grant must be the principal's OWN: org → agent, delegated by the org whose endeavor
      // plane this is. `ctx.principal` is the delegator; this DO is the org's agent.
      if (ctx.principal.toLowerCase() !== agentSA.toLowerCase()) {
        await auditRow('denied', ctx.taskId, 'delegation delegator is not this agent');
        return { state: 'failed', error: 'endeavor.request grant must be signed by this agent (delegator mismatch)' };
      }
      const parsed = parseEndeavorRequestInput(ctx.input);
      if (!parsed.ok) {
        await auditRow('denied', ctx.taskId, parsed.error);
        return { state: 'failed', error: parsed.error };
      }
      const { goal } = parsed;

      const filed = await fileEndeavorIntake(env, { principal: ctx.principal, sender: ctx.sender, taskId: ctx.taskId, goal });
      if (!filed.ok) {
        await auditRow('denied', ctx.taskId, filed.error);
        return { state: 'failed', error: filed.error };
      }
      await auditRow('success', filed.requestId);

      // skill-provenance/v1 — the same verifiable-SKILL.md tag the other skills carry (fail-open).
      const provenance = await skillProvenanceMetadata(env, {
        skill: ENDEAVOR_REQUEST_SKILL_ID,
        agentSA,
        taskId: ctx.taskId,
        reason: 'endeavor intake accepted',
      });
      // The requestId is the whole result: it is what `endeavor.state` is later asked about.
      const artifactId = await ctx.emitArtifact({
        artifactKind: 'endeavor.request',
        body: { requestId: filed.requestId, goal, requester: sender },
        bodyContentType: 'application/json',
        ...(provenance ? { metadata: provenance } : {}),
      });
      return { state: 'completed', artifactIds: [artifactId] };
    },
  };
}

/**
 * The `endeavor.state` skill — the READ half of the Operational Intent grant: follow an intent you
 * submitted. Its selector is already in every minted grant, so shipping this handler makes those
 * grants reach it with no re-mint.
 *
 * THE BELT THAT MAKES THIS SAFE. `internal.endeavor.state` is a RAW, UN-GATED read — it exists for
 * the principal reading its own log, and it will happily return any endeavor of this org. Exposed
 * to a delegate as-is, it would turn "follow the intent you raised" into "read this organization's
 * entire coordination history", which is a far larger authority than the grant describes. So the
 * handler compares the endeavor's RECORDED REQUESTER to the delegation-verified sender and refuses
 * anything the caller did not raise — the same shape as the package's own "not a party to this task".
 */
function makeEndeavorStateSkill(env: Env, agentSA: Address): SkillHandler {
  return {
    skill: ENDEAVOR_STATE_SKILL_ID,
    handle: async (ctx) => {
      // Same delegator check as endeavor.request: the grant must be this org's own.
      if (ctx.principal.toLowerCase() !== agentSA.toLowerCase()) {
        return { state: 'failed', error: 'endeavor.state grant must be signed by this agent (delegator mismatch)' };
      }
      const parsed = parseEndeavorStateInput(ctx.input);
      if (!parsed.ok) return { state: 'failed', error: parsed.error };

      if (!internalMarker(env)) return { state: 'failed', error: 'endeavor.state requires A2A_INTERNAL_MARKER' };
      const target = ctx.principal.toLowerCase();
      const stub = env.INTERACTIONS.get(env.INTERACTIONS.idFromName(target));
      const resp = await stub.fetch(new Request(`https://do/interactions/${target}/internal.endeavor.state`, {
        method: 'POST',
        headers: internalHeaders(env),
        body: JSON.stringify({ endeavorId: parsed.endeavorId }),
      }));
      const out = (await resp.json().catch(() => ({}))) as {
        ok?: boolean; error?: string; requester?: string | null; endeavorId?: string; requestId?: string;
        status?: string; reason?: string; outcome?: string;
        lifecycle?: string | null; goal?: string; plan?: unknown; adoptedPlanRef?: unknown;
      };
      if (!resp.ok || !out.ok) {
        // A missing endeavor and one belonging to someone else read the SAME to the caller — telling
        // a delegate which ids exist is itself a disclosure it has no authority for. The operator
        // still needs to tell them apart, so the REASON is logged rather than returned.
        console.warn('[endeavor.state] internal read failed', {
          asked: parsed.endeavorId, status: resp.status, error: out.error ?? null,
        });
        return { state: 'failed', error: 'no such endeavor for this requester' };
      }
      if ((out.requester ?? '').toLowerCase() !== ctx.sender.toLowerCase()) {
        // The caller is told nothing (an id oracle), but the OPERATOR needs to tell a genuine
        // "not yours" from a state read that lost the requester — they are the same message here,
        // and that ambiguity cost an afternoon.
        console.warn('[endeavor.state] requester mismatch', {
          asked: parsed.endeavorId, recorded: out.requester ?? null, sender: ctx.sender.toLowerCase(),
        });
        return { state: 'failed', error: 'no such endeavor for this requester' };
      }

      const artifactId = await ctx.emitArtifact({
        artifactKind: 'endeavor.state',
        body: {
          // Echo BOTH ids: the caller asked with whichever it had, and a follow-up needs the other.
          asked: parsed.endeavorId,
          ...(out.endeavorId ? { endeavorId: out.endeavorId } : {}),
          ...(out.requestId ? { requestId: out.requestId } : {}),
          status: out.status ?? null,
          lifecycle: out.lifecycle ?? null,
          // What the work produced, when it has finished producing it.
          ...(out.outcome ? { outcome: out.outcome } : {}),
          goal: out.goal ?? '',
          adoptedPlanRef: out.adoptedPlanRef ?? null,
          plan: out.plan ?? null,
          ...(out.reason ? { reason: out.reason } : {}),
        },
        bodyContentType: 'application/json',
      });
      return { state: 'completed', artifactIds: [artifactId] };
    },
  };
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
        const filed = await fileEndeavorIntake(env, { principal: ctx.principal, sender: ctx.sender, taskId: ctx.taskId, goal });
        if (!filed.ok) return { state: 'failed', error: filed.error };
        endeavorRequestId = filed.requestId;
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
            const stub = env.INTERACTIONS.get(env.INTERACTIONS.idFromName(agentSA.toLowerCase()));
            const resp = await stub.fetch(new Request(`https://do/interactions/${agentSA.toLowerCase()}/internal.consult.context`, {
              method: 'POST', headers: internalHeaders(env), body: JSON.stringify({}),
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

/**
 * Injected external seams (the `InteractionsDeps` pattern, applied to the task runtime).
 *
 * `build()` derives every on-chain check from two primitives — signature verification and revocation
 * — and both reach a chain RPC. Injecting exactly those makes the task lifecycle drivable without a
 * node, while leaving the derived logic (session-wrapped signatures, the skill pinning, the party
 * checks) entirely real. That derived logic is the part worth testing; the RPC round trip is not.
 *
 * PRODUCTION NEVER PASSES THIS. The Cloudflare binding constructs `new A2aTaskDO(state, env)`, so
 * `deps` is `undefined` and both fall through to the resilient chain reader (or the inline ERC-1271
 * fallback). No env flag reaches it, deliberately — a runtime switch here would be a way to turn off
 * signature verification in production.
 */
export interface A2aTaskDeps {
  /** Base signature verification. Default: the resilient chain reader, else inline ERC-1271. */
  verifySignature?(signer: Address, digest: Hex, signature: Hex): Promise<boolean>;
  /** Delegation revocation by hash. Default: the chain reader, else a DelegationManager read. */
  isRevoked?(delegationHash: Hex): Promise<boolean>;
}

export class A2aTaskDO {
  private agent: A2aAgent | null = null;
  constructor(private state: DurableObjectState, private env: Env, private deps?: A2aTaskDeps) {}

  private build(agentSA: Address): A2aAgent {
    if (this.agent) return this.agent;
    const pub = createPublicClient({ chain: chainFor(this.env), transport: http(this.env.RPC_URL) });
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
    // The injected seam takes precedence over BOTH the resilient reader and the inline fallback —
    // there is no chain read left underneath it to disagree with.
    const verifySig = this.deps?.verifySignature
      ? this.deps.verifySignature
      : reader
      ? async (signer: Address, digest: Hex, signature: Hex): Promise<boolean> => {
          const r = await reader.verifySmartAgentSignature({ signer, digest, signature });
          return r.valid && r.deployed;
        }
      : erc1271Inline;
    const injectedRevoked = this.deps?.isRevoked;
    const isRevokedFn = injectedRevoked
      ? async (d: Delegation) => injectedRevoked(hashDelegation(d, chainId, dm))
      : reader
      ? async (d: Delegation) => (await reader.isDelegationRevoked(hashDelegation(d, chainId, dm))).revoked
      : async (d: Delegation) => (await pub.readContract({ address: dm, abi: IS_REVOKED_ABI, functionName: 'isRevoked', args: [hashDelegation(d, chainId, dm)] })) as boolean;
    const verifyDelegationSigFn = async (d: Delegation) => verifySig(d.delegator, hashDelegation(d, chainId, dm), d.signature as Hex);
    // spec 329 §3.1, generalized — accept a SESSION-WRAPPED signature alongside plain ERC-1271: a
    // runtime that holds no key for the identity it acts as signs with a KMS session key and wraps
    // the signature WITH the narrow wire that authorizes it. Two identities do this: an org on the
    // consult rail (no org key at rest, SC-8) and a service agent it must never custody (ADR-0019).
    // Verification is fail-closed per message (wire shape: ONE selector — the requested skill where
    // the request names one — + timestamp; delegator = the claimed signer; ECDSA recovers to the
    // wire's delegate; wire ERC-1271-valid against the delegator; wire UNREVOKED on-chain, so a
    // custodian's revocation kills the authority immediately here). Any other signature shape takes
    // the unchanged ERC-1271 path.
    const wireEnforcers = { timestamp: this.env.TIMESTAMP_ENFORCER ?? '', allowedMethods: this.env.ALLOWED_METHODS_ENFORCER ?? '' };
    const verifySigOrWired = async (signer: Address, digest: Hex, signature: Hex, skill?: string): Promise<boolean> => {
      if (parseSessionWrappedSignature(signature)) {
        return verifySessionWrappedSignature({
          signer, digest, signature,
          enforcers: wireEnforcers,
          verifyDelegationSig: verifyDelegationSigFn,
          isRevoked: isRevokedFn,
          ...(skill ? { skill } : {}),
        });
      }
      return verifySig(signer, digest, signature);
    };
    const checks: OnChainChecks = {
      // Fail-closed: any throw propagates and the package denies (ADR-0013).
      isRevoked: isRevokedFn,
      verifyDelegationSignature: verifyDelegationSigFn,
      // The message NAMES its skill, so the wire is pinned to that rail — a consult wire cannot sign
      // an endeavor message, and vice versa.
      verifyMessageSignature: async (msg, digest) => verifySigOrWired(msg.sender as Address, digest, msg.signature as Hex, msg.skill),
      // AUDIT NEW-A2A-2 — the read/control caller proves control of `caller` via ERC-1271 over the
      // request digest. That digest binds a method and a taskId, never a skill, so there is no
      // selector to pin; the package's own "not a party to this task" check is what bounds it.
      verifyCallerSignature: async (caller, digest, signature) => verifySigOrWired(caller as Address, digest, signature as Hex),
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
      // spec 341 §5.1c — messaging scope classes: an `allowedTargets` entry that is the naming
      // registry covers any NAMED recipient (named sender required); an org SA covers its CURRENT
      // members (both parties). Only the three messaging skills read classes — everything else keeps
      // FR-4.2's exact-address rule. Fail-closed inside the resolver.
      scopeCovers: (i) => messagingScopeCovers(messagingScopeDepsFromEnv(this.env as never), { ...i, recipient: agentSA }),
      taskStore: createDurableObjectTaskStore(this.state.storage),
      // spec 309 §7 / spec 316 §11a — the A2A messaging skills (messaging.deliver / interactions.respond /
      // interactions.deliverCredential): delivery rides standard `message/send`, authorized by the delegation
      // gate, then admitted DIRECTLY into the recipient's vault inbox (no Home callback). Registered on EVERY
      // agent's DO (this IS its inbox gateway).
      // spec 322 W3f: the inbox.data merge rides the recipient's InteractionsDO (in-Worker
      // `internal.deliver` — the serialized single writer; the public route refuses internal.*).
      // spec 329 §3 — the `discussion.consult` skill (person agents; delegation-gated: reachable
      // ONLY under a member-signed consultability grant naming the org + this skill's selector).
      // ADVERTISE the archetypes this org hosts on its agent card, so a steward can discover the
      // METHOD to request a grant for. Served from a CACHE because `agentCard()` is synchronous and
      // the catalog comes from the library — a discovery document tolerates being seconds stale, and
      // the alternative (an async card) is a breaking change to every caller for no gain here.
      // Empty until the first refresh lands, which reads as "advertises no archetypes" — true of
      // most agents, and self-correcting for the ones it is not.
      dynamicSkills: () => { this.refreshArchetypeCatalog(agentSA); return this.archetypeMethods; },
      // THE ARCHETYPE HARNESS. This agent also serves an A2A endpoint for every archetype its OWN
      // library defines — the METHOD `archetype.<slug>` addresses a role, composed from that role's
      // declared SKILL.md packages. Adding a role is a library write, not a redeploy. Consulted only
      // on a registry miss, so it can never shadow a declared skill.
      resolveHandler: resolveArchetypeMethod(this.env, agentSA),
      checks, handlers: [echo,
        // THE RELAY, registered inline because it needs `this` — the dispatch and collect it
        // composes are the same methods the step loop uses, so a relayed call and an endeavor-driven
        // one take exactly one path.
        {
          skill: 'archetype.relay',
          handle: async (ctx) => {
            const out = await this.handleArchetypeRelay(ctx.input);
            if (!out.ok) return { state: 'failed', error: out.error };
            await ctx.emitArtifact({ artifactKind: 'archetype.relay', body: { taskId: out.taskId }, bodyContentType: 'application/json' });
            return { state: 'completed' };
          },
        },
        {
          skill: 'archetype.relayResult',
          handle: async (ctx) => {
            const out = await this.handleArchetypeRelayResult(ctx.input);
            await ctx.emitArtifact({ artifactKind: 'archetype.relayResult', body: out, bodyContentType: 'application/json' });
            return { state: 'completed' };
          },
        },
        makeOrchestrateSkill(this.env, agentSA), makeEndeavorRequestSkill(this.env, agentSA), makeEndeavorStateSkill(this.env, agentSA), makeConsultSkill(this.env, agentSA, this.state.storage), ...makeContentSkills(),
        // spec 341 §5.5a — admission for a stranger: the applicant's grant authorizes ASKING; this
        // org's own grant does the writing, in its own DO.
        makeOrgApplySkill(agentSA, async (application) => {
          const stub = this.env.INTERACTIONS.get(this.env.INTERACTIONS.idFromName(agentSA.toLowerCase()));
          const resp = await stub.fetch(new Request(`https://do/interactions/${agentSA.toLowerCase()}/internal.applications.append`, {
            method: 'POST', headers: internalHeaders(this.env), body: JSON.stringify({ application }),
          }));
          const out = (await resp.json().catch(() => ({}))) as { ok?: boolean; error?: string };
          if (!resp.ok || !out.ok) throw new Error(out.error ?? `application append failed (${resp.status})`);
        }),
        ...makeMessagingSkills(agentSA, async (recipient, envelope, body, admitted) => {
        // spec 323 W3.2 — the recipient's InteractionsDO does BOTH admissions with its OWN held
        // delivery wire: the body (internal.dm.body.put) then the inbox.data merge (internal.deliver).
        const stub = this.env.INTERACTIONS.get(this.env.INTERACTIONS.idFromName(recipient.toLowerCase()));
        const call = async (op: string, payload: unknown): Promise<void> => {
          const resp = await stub.fetch(new Request(`https://do/interactions/${recipient.toLowerCase()}/${op}`, {
            // ARCH-H2 — the in-Worker internal marker the InteractionsDO requires for internal.* ops.
            method: 'POST', headers: internalHeaders(this.env), body: JSON.stringify(payload),
          }));
          const out = (await resp.json().catch(() => ({}))) as { ok?: boolean; error?: string };
          if (!resp.ok || !out.ok) throw new Error(out.error ?? `${op} failed (${resp.status})`);
        };
        await call('internal.dm.body.put', { resource: body.resource, data: body.stored });
        await call('internal.deliver', { envelope });
        // Spec 375 W2 — ADMITTED, so now the playbook may hear about it: the recipient's own `message`
        // triggers fire one unattended run each, this agent as the asker holding nothing (P5). Detached from
        // the delivery: the sender's receipt says "admitted", never "reacted to", and a run that takes a
        // planner's time must not hold the sender's delivery open. An inbound message never performs an act
        // (spec 365): the run may draft the reply, which parks for a steward.
        const senderAddr = (envelope.from.match(/0x[0-9a-fA-F]{40}$/)?.[0] ?? '').toLowerCase();
        const fromName = admitted && senderAddr ? await harnessDeps(this.env, buildAuditSink(this.env)).nameOf?.(senderAddr).catch(() => null) ?? null : null;
        const source = admitted ? messageTriggerSource(envelope, admitted.skill, admitted.bodyText, fromName) : null;
        if (source) {
          void fireTriggersAt(this.env, recipient.toLowerCase() as Address, source)
            .then((fired) => { if (fired.length) console.log(`[triggers] message ${envelope.id} fired at ${recipient}: ${fired.map((f) => `${f.triggerId}→${f.outcome}`).join(', ')}`); })
            .catch((e: unknown) => console.warn('[triggers] message firing failed:', e instanceof Error ? e.message : String(e)));
        }
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
    // ── spec 350 W3 — the harness run checkpoint. An ask that stopped to ask a person outlives the tab
    // it was asked in. Serving-plane memory of an unfinished conversation (ADR-0055: wiping it costs a
    // rebuild, never a bereavement — the receipts are the evidence, the mandate is re-mintable, and an
    // agent an ask created is on chain the moment it exists). Internal-only: the run's own authority is
    // re-verified on every resume, so this store decides nothing.
    if (url.pathname.startsWith('/internal/harness-run/')) {
      if (!isInternalCall(req, this.env)) return Response.json({ ok: false, error: 'internal op — not authorized' }, { status: 403 });
      const op = url.pathname.slice('/internal/harness-run/'.length);
      const body = (await req.json().catch(() => null)) as { runRef?: string; checkpoint?: { runRef?: string }; asker?: string; line?: Record<string, unknown> & { seq?: number; terminal?: boolean }; after?: number } | null;
      const key = (ref: string) => `harness:run:${ref}`;
      // Spec 370 P2 — the run's PROGRESS LINES: a short list per run, appended by the ask route as the loop
      // narrates itself, long-polled by the surface. Rebuildable, TTL'd, and read only by the asker whose
      // run it is (recorded on the first append — a runRef is a client-chosen string).
      const pkey = (ref: string) => `harness:progress:${ref}`;
      // Spec 370 P5 — THE AGENT'S OWN SCHEDULE, under its single alarm. Rows are rebuildable from the
      // playbook (a sync replaces what the digest no longer declares, keeps timing for what it still does).
      const tkey = (id: string) => `harness:trigger:${id}`;
      if (op === 'trigger-sync') {
        const rows = (body as { rows?: Array<{ triggerId: string; playbookDigest: string; nextAt: number }> } | null)?.rows ?? [];
        const existing = await this.state.storage.list<{ triggerId: string; playbookDigest: string; nextAt: number }>({ prefix: 'harness:trigger:' });
        const keep = new Set(rows.map((r) => tkey(r.triggerId)));
        const stale = [...existing.keys()].filter((k) => !keep.has(k));
        if (stale.length) await this.state.storage.delete(stale);
        const out: unknown[] = [];
        if (rows[0] && (rows[0] as { agent?: string }).agent) await this.state.storage.put(AGENT_SA_KEY, String((rows[0] as { agent?: string }).agent).toLowerCase());
        for (const r of rows) {
          const prior = existing.get(tkey(r.triggerId));
          // Same playbook ⇒ the row keeps its clock; a new digest starts the interval over.
          const row = prior && prior.playbookDigest === r.playbookDigest ? { ...r, nextAt: prior.nextAt, ...(prior as Record<string, unknown>) } : r;
          await this.state.storage.put(tkey(r.triggerId), row);
          out.push(row);
        }
        await this.armTriggerAlarm();
        return Response.json({ ok: true, rows: out });
      }
      // Spec 372 S3c — THE ASSERTION LEDGER: a wire-signed caller's assertion, spent once. The standard
      // surface's own memory is per isolate, which on a fanned-out edge is no protection at all (a replay
      // landing on a second isolate was accepted, live, 2026-09-08). The agent's object is the estate's
      // single writer, so the claim happens here: first caller wins, the rest are refused. Rows are pruned
      // by their own expiry and are a rebuild, never a bereavement (ADR-0055).
      if (op === 'assertion-claim') {
        const b = body as { digest?: string; expiresAt?: number } | null;
        const digest = String(b?.digest ?? '').toLowerCase();
        if (!/^0x[0-9a-f]{64}$/.test(digest)) return Response.json({ ok: false, error: 'digest required' }, { status: 400 });
        const akey = `a2a:assertion:${digest}`;
        const now = Date.now();
        if (await this.state.storage.get(akey)) return Response.json({ ok: true, claimed: false });
        await this.state.storage.put(akey, { at: now, expiresAt: Number(b?.expiresAt ?? now + 300_000) });
        // Opportunistic prune: an expired row proves nothing and costs storage.
        const rows = await this.state.storage.list<{ expiresAt?: number }>({ prefix: 'a2a:assertion:', limit: 200 });
        const dead = [...rows.entries()].filter(([, v]) => Number(v?.expiresAt ?? 0) < now).map(([k]) => k);
        if (dead.length) await this.state.storage.delete(dead);
        return Response.json({ ok: true, claimed: true });
      }
      if (op === 'trigger-list') {
        const rows = [...(await this.state.storage.list<unknown>({ prefix: 'harness:trigger:' })).values()];
        return Response.json({ ok: true, rows });
      }
      // Spec 375 — a firing from OUTSIDE the alarm (an event, a webhook, a message) records its outcome on
      // the row, the way the alarm does for a schedule. The row must already exist: a firing cannot mint one.
      if (op === 'trigger-advance') {
        const row = (body as { row?: { triggerId?: string } } | null)?.row;
        if (!row?.triggerId || !(await this.state.storage.get(tkey(row.triggerId)))) return Response.json({ ok: false, error: 'no such trigger' }, { status: 404 });
        await this.state.storage.put(tkey(row.triggerId), row);
        return Response.json({ ok: true });
      }
      // Spec 375 W3 — ROTATE a webhook row's token: the old one stops opening the door the moment the new one
      // is minted. Admission, never authority (375 §4), so rotating it revokes nothing else. Webhooks only:
      // no other kind carries a token.
      if (op === 'trigger-rotate') {
        const triggerId = String((body as { triggerId?: string } | null)?.triggerId ?? '');
        const row = (await this.state.storage.get(tkey(triggerId))) as { kind?: string; token?: string } | undefined;
        if (!triggerId || !row) return Response.json({ ok: false, error: 'no such trigger' }, { status: 404 });
        if (row.kind !== 'webhook') return Response.json({ ok: false, error: 'only a webhook trigger carries a token' }, { status: 400 });
        const token = `0x${[...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
        const next = { ...row, token };
        await this.state.storage.put(tkey(triggerId), next);
        return Response.json({ ok: true, row: next });
      }
      // Spec 370 P6 — THE RUN RECORD: what a finished run observed, decided and received, kept for a week
      // on the agent's own object for looking back and replaying. Listed WITHOUT its mandates.
      const rkey = (ref: string) => `harness:record:${ref}`;
      if (op === 'record-put') {
        const rec = (body as { record?: { runRef?: string } } | null)?.record;
        if (!rec?.runRef) return Response.json({ ok: false, error: 'record.runRef required' }, { status: 400 });
        await this.state.storage.put(rkey(rec.runRef), rec);
        return Response.json({ ok: true });
      }
      if (op === 'record-get') {
        if (!body?.runRef) return Response.json({ ok: false, error: 'runRef required' }, { status: 400 });
        return Response.json({ ok: true, record: (await this.state.storage.get(rkey(body.runRef))) ?? null });
      }
      if (op === 'record-list') {
        const rows = [...(await this.state.storage.list<Record<string, unknown>>({ prefix: 'harness:record:' })).values()];
        const now = Date.now();
        // Spec 381 — THE RETENTION POLICY, declared: the DO copy lives `HARNESS_RECORD_RETENTION_DAYS` (7 by
        // default) and is swept on listing; the run's provenance is in the acting agent's vault for good.
        const ttl = recordRetention(this.env).doDays * 24 * 3600_000;
        const stale = rows.filter((r) => now - Number(r.at ?? 0) > ttl).map((r) => rkey(String(r.runRef)));
        if (stale.length) await this.state.storage.delete(stale);
        const live = rows.filter((r) => now - Number(r.at ?? 0) <= ttl)
          .map(({ presented: _p, events: _e, ...rest }): Record<string, unknown> => ({ ...rest, steps: (rest.steps as unknown[] | undefined)?.length ?? 0, receipts: (rest.receipts as unknown[] | undefined)?.length ?? 0 }))
          .sort((a, b) => Number(b.at ?? 0) - Number(a.at ?? 0));
        return Response.json({ ok: true, records: live, retention: recordRetention(this.env) });
      }
      if (op === 'progress-append') {
        if (!body?.runRef || !body.line || !body.asker) return Response.json({ ok: false, error: 'runRef, asker and line required' }, { status: 400 });
        const cur = (await this.state.storage.get<{ asker: string; at: number; lines: unknown[] }>(pkey(body.runRef))) ?? { asker: body.asker, at: Date.now(), lines: [] };
        if (cur.asker !== body.asker) return Response.json({ ok: false, error: 'this run belongs to someone else' }, { status: 403 });
        // ONE SEQUENCE PER RUN, assigned here. A run is several turns and every turn narrates from its
        // start; a reader keeps its cursor across turns, so a seq that restarted per turn re-read the
        // earlier turns' lines ("checking your authority…" three times over).
        if (cur.lines.length < 400) cur.lines.push({ ...body.line, seq: cur.lines.length + 1 });
        cur.at = Date.now();
        await this.state.storage.put(pkey(body.runRef), cur);
        return Response.json({ ok: true, seq: cur.lines.length });
      }
      if (op === 'progress-read') {
        if (!body?.runRef || !body.asker) return Response.json({ ok: false, error: 'runRef and asker required' }, { status: 400 });
        const cur = await this.state.storage.get<{ asker: string; at: number; lines: Array<{ seq: number; terminal?: boolean }> }>(pkey(body.runRef));
        if (!cur) return Response.json({ ok: true, known: false, lines: [], terminal: false });
        if (cur.asker !== body.asker) return Response.json({ ok: false, error: 'this run belongs to someone else' }, { status: 403 });
        const after = Number(body.after ?? 0);
        // Terminal = the LAST line says so: a new turn's lines after a reply make the run live again.
        const last = cur.lines[cur.lines.length - 1];
        return Response.json({ ok: true, known: true, lines: cur.lines.filter((l) => l.seq > after), terminal: !!last?.terminal });
      }
      if (op === 'save') {
        const cp = body?.checkpoint;
        if (!cp?.runRef) return Response.json({ ok: false, error: 'checkpoint.runRef required' }, { status: 400 });
        await this.state.storage.put(key(cp.runRef), cp);
        return Response.json({ ok: true });
      }
      if (op === 'load') {
        if (!body?.runRef) return Response.json({ ok: false, error: 'runRef required' }, { status: 400 });
        return Response.json({ ok: true, checkpoint: (await this.state.storage.get(key(body.runRef))) ?? null });
      }
      if (op === 'drop') {
        if (!body?.runRef) return Response.json({ ok: false, error: 'runRef required' }, { status: 400 });
        await this.state.storage.delete(key(body.runRef));
        return Response.json({ ok: true });
      }
      // spec 350 W3 — ENUMERATE the unfinished runs on this agent. A checkpoint already records what a run
      // is `awaiting` and whether it is `openToStewards`, and until now nothing could read that back: a
      // payment waiting on a signature was invisible to everyone including the person who owes it. The DO
      // returns them all; WHOSE they are is decided by the caller's session at the route (a person sees
      // their own; a steward additionally sees the unclaimed work items).
      if (op === 'list') {
        const rows = await this.state.storage.list<Record<string, unknown>>({ prefix: 'harness:run:' });
        // AN UNFINISHED RUN EXPIRES. A checkpoint was only ever dropped on a terminal outcome, so every
        // ask a person walked away from stayed forever — one estate reached 167 of them and the list
        // buried the conversation it was supposed to sit beside.
        //
        // A day is well past the point of resumability: the mandate a suspended run holds has long since
        // expired (they are minted for the request, minutes not days), so resuming would ask for a fresh
        // one anyway — at which point asking again is the same act with less ceremony. Deleting them here
        // rather than on a timer means the cleanup happens wherever the cost is already being paid.
        const now = Date.now();
        const live: Record<string, unknown>[] = [];
        const expired: string[] = [];
        for (const [key, run] of rows) {
          const updatedAt = Number((run as { updatedAt?: number }).updatedAt ?? 0);
          if (updatedAt && now - updatedAt > RUN_TTL_MS) { expired.push(key); continue; }
          // Spec 370 P1 tail — a run past its own window is gone from the list, not shown as unfinished.
          const r = run as { expiresAt?: number; awaiting?: { kind?: string; expiresAt?: number } };
          const window = typeof r.awaiting?.expiresAt === 'number' ? r.awaiting.expiresAt : typeof r.expiresAt === 'number' ? r.expiresAt : r.awaiting?.kind === 'data' ? undefined : updatedAt ? updatedAt + 30 * 60_000 : undefined;
          if (window !== undefined && window < now) { expired.push(key); continue; }
          // Mandates are bearer-shaped wires; enumeration is a LISTING, not a resume, so the keyring
          // never rides along. Loading the run by its ref is what hands those back.
          const { presented: _presented, ...rest } = run;
          live.push(rest);
        }
        // Progress lines outlive their run by an hour at most (a surface reads the tail after the reply).
        const stale = [...(await this.state.storage.list<{ at?: number }>({ prefix: 'harness:progress:' }))].filter(([, v]) => now - Number(v?.at ?? 0) > 3600_000).map(([k]) => k);
        if (expired.length || stale.length) await this.state.storage.delete([...expired, ...stale]);
        live.sort((a, b) => Number((b as { updatedAt?: number }).updatedAt ?? 0) - Number((a as { updatedAt?: number }).updatedAt ?? 0));
        return Response.json({ ok: true, runs: live, expired: expired.length });
      }
      return Response.json({ ok: false, error: `unknown harness-run op: ${op}` }, { status: 404 });
    }

    if (url.pathname === '/internal/discussion-respond') {
      if (!isInternalCall(req, this.env)) return Response.json({ ok: false, error: 'internal op — not authorized' }, { status: 403 });
      const p = (await req.json().catch(() => null)) as (DiscussionRespondInput & { trigger?: string; mentionHandle?: string }) | null;
      if (!p || !/^0x[0-9a-f]{40}$/.test(String(p.principal ?? '')) || !p.channelId) {
        return Response.json({ ok: false, error: 'principal + channelId required' }, { status: 400 });
      }
      const stub = this.env.INTERACTIONS.get(this.env.INTERACTIONS.idFromName(p.principal.toLowerCase()));
      const call = async (op: string, payload: unknown): Promise<Record<string, unknown>> => {
        const resp = await stub.fetch(new Request(`https://do/interactions/${p.principal.toLowerCase()}/${op}`, {
          method: 'POST', headers: internalHeaders(this.env), body: JSON.stringify(payload),
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
      const audit = buildAuditSink(this.env);
      const io = {
        readTopic: () => call('internal.channels.read', { channelId: p.channelId }),
        // spec 334 §6 gather phase for the @ask turn: read ONE of the org's OWN records owner-self
        // through the read-only coordination grant (recordType OPAQUE — the org's playbook names
        // the domain records, never this platform). Non-throwing: a scope-denied / unenabled read
        // maps to { ok:false } so the gather sub-turn degrades gracefully to no reference data.
        readOrgRecord: (recordType: string) =>
          call('internal.coordination.vaultRead', { recordType })
            .then((r) => ({ ok: r.ok === true, data: (r as { data?: unknown }).data, error: (r as { error?: string }).error, needsEnable: (r as { needsEnable?: boolean }).needsEnable }))
            .catch((e) => ({ ok: false, error: e instanceof Error ? e.message : String(e) })),
        post: async (bodyText: string, contextRefs?: unknown[]) => (await call('internal.channels.post', {
          channelId: p.channelId, bodyText, ...(contextRefs?.length ? { contextRefs } : {}),
        })) as { messageId?: string },
      };
      // Spec 380 W3 — THE ROUTED TOPIC TURN IS ONE HARNESS RUN AT THE ORGANIZATION. Eligibility and the
      // 329 ranking still decide WHO (the harness-computed, discovery-ranked, opt-in set); the chosen
      // members become the supplied plan's respondents, one `organization.member.consult` step each. The
      // loop runs them as one batch, each member's own gate re-verifies its grant, and the composer's
      // reply — which names every member's words and every skip — is posted ONCE with the
      // routed-consultation contextRef. No pending record, no alarm, no second turn: a member who has
      // not answered within the step's deadline is said to have not answered.
      try {
        const elig = (await call('internal.consult.eligible', { channelId: p.channelId })) as { enabled?: boolean; maxFanout?: number; members?: EligibleConsultMemberV1[] };
        if (elig.enabled === true && (elig.members?.length ?? 0) > 0) {
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
              const facets = await fetchDiscoveryFacets(this.env, elig.members!.map((m) => m.memberSA));
              const ranking = rankConsultCandidates({ eligible: elig.members!, facets, need: p.triggerBody, max: 5 });
              const evidenceHash = await sha256Hex32(new TextEncoder().encode(JSON.stringify(ranking.candidates)));
              console.log(`[discussion-respond] routing decision ${questionId}: ${ranking.candidates.length} candidate(s), evidence ${evidenceHash.slice(0, 18)}…`);
              await audit.write({ id: crypto.randomUUID(), timestamp: new Date().toISOString(), action: 'interactions.routing.decision', outcome: 'success', actor: { type: 'service', id: p.principal }, subject: { type: 'routing-question', id: questionId } });
              if (ranking.candidates.length > 0) {
                const maxFanout = Math.min(Math.max(Number(elig.maxFanout ?? 3) || 3, 1), 5);
                const chosen = ranking.candidates.slice(0, maxFanout);
                const org = p.principal.toLowerCase() as Address;
                const runRef = `topic-${questionId}`;
                let topicGuidance = '';
                try { topicGuidance = String(((await io.readTopic()) as { skillMarkdown?: string }).skillMarkdown ?? '').trim(); } catch { /* the org's playbook alone */ }
                const run = await runAgentAsk(this.env, {
                  agent: org, addressee: org, ask: p.triggerBody, runRef,
                  context: { channelId: p.channelId, topicTitle: p.topicTitle, triggerAuthor: p.triggerAuthor, questionId },
                  plan: { steps: chosen.map((c, i) => ({ toolId: MEMBER_CONSULT_TOOL.id, args: { org, respondent: c.memberSA, question: p.triggerBody }, id: `s1#${i + 1}` })) },
                  guidance: topicReplyGuidance(p, topicGuidance),
                });
                const text = String(run.reply.text ?? '').trim();
                if (text) {
                  const posted = await io.post(text, [routedConsultationContextRef(p.principal, p.channelId, questionId)]);
                  return Response.json({ ok: true, messageId: posted.messageId, plannerKind: 'harness', asked: chosen.length, runRef });
                }
                await audit.write({ id: crypto.randomUUID(), timestamp: new Date().toISOString(), action: 'interactions.routing.degraded', outcome: 'error', actor: { type: 'service', id: p.principal }, subject: { type: 'routing-question', id: questionId } });
              }
            }
          }
        }
      } catch (e) {
        // fail-open: the plain 327 turn (the org answers alone). Audited, never retried into another mechanism.
        await audit.write({ id: crypto.randomUUID(), timestamp: new Date().toISOString(), action: 'interactions.routing.degraded', outcome: 'error', actor: { type: 'service', id: p.principal }, subject: { type: 'channel', id: p.channelId } }).catch(() => undefined);
      }

      try {
        const turn = await handleDiscussionRespond(this.env, p, io);
        if (!turn.posted) {
          const cause = turn.result.error ?? 'assistant turn completed without posting a reply';
          console.error(`[discussion-respond] 502 — no reply posted (step=turn outcome=${turn.result.outcome} planner=${turn.plannerKind}): ${cause}`);
          return Response.json({ ok: false, error: cause, plannerKind: turn.plannerKind }, { status: 502 });
        }
        return Response.json({ ok: true, messageId: turn.messageId, plannerKind: turn.plannerKind, asked: 0 });
      } catch (e) {
        console.error(`[discussion-respond] 502 — dispatch threw (step=dispatch): ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
        return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 502 });
      }
    }
    // ── spec 329 §7 — steward routing disable: cancel this topic's pending consults (in-Worker,
    // marker-gated; called by the org's InteractionsDO). Cancellation is a DROP + audit — the
    // member-side tasks run to completion on their own store; their answers are simply never read.
    if (url.pathname === '/internal/routing-cancel') {
      if (!isInternalCall(req, this.env)) return Response.json({ ok: false, error: 'internal op — not authorized' }, { status: 403 });
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
      if (!isInternalCall(req, this.env)) return Response.json({ ok: false, error: 'internal op — not authorized' }, { status: 403 });
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
      if (!isInternalCall(req, this.env)) return Response.json({ ok: false, error: 'internal op — not authorized' }, { status: 403 });
      const p = (await req.json().catch(() => null)) as InboxRespondInput | null;
      if (!p || !/^0x[0-9a-f]{40}$/.test(String(p.principal ?? '')) || !p.conversationId) {
        return Response.json({ ok: false, error: 'principal + conversationId required' }, { status: 400 });
      }
      const stub = this.env.INTERACTIONS.get(this.env.INTERACTIONS.idFromName(p.principal.toLowerCase()));
      const call = async (op: string, payload: unknown): Promise<Record<string, unknown>> => {
        const resp = await stub.fetch(new Request(`https://do/interactions/${p.principal.toLowerCase()}/${op}`, {
          method: 'POST', headers: internalHeaders(this.env), body: JSON.stringify(payload),
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
      if (!isInternalCall(req, this.env)) return Response.json({ ok: false, error: 'internal op — not authorized' }, { status: 403 });
      const p = (await req.json().catch(() => null)) as { principal?: string; endeavorId?: string; goal?: string; autoWork?: boolean } | null;
      if (!p || !/^0x[0-9a-f]{40}$/.test(String(p.principal ?? '')) || !String(p.endeavorId ?? '').startsWith('end_') || !String(p.goal ?? '').trim()) {
        return Response.json({ ok: false, error: 'principal + endeavorId + goal required' }, { status: 400 });
      }
      const principal = p.principal!.toLowerCase();
      const endeavorId = p.endeavorId!;
      try {
        const playbook = await this.readOrgPlaybook(principal);
        const draft = await draftEndeavorPlan(this.env, { principal, endeavorId, goal: String(p.goal).trim(), playbook });
        const proposedSteps = draft.steps.map((s, i) => ({
            stepId: `step_${i + 1}_${crypto.randomUUID().slice(0, 8)}`,
            kind: s.kind,
            description: s.description,
            // Carried onto the plan step so the capability survives adoption — it is what a later
            // router matches an archetype agent against. 'declared' is the honest strength here:
            // the planner is asserting what the step NEEDS, not that anyone has demonstrated it.
            ...(s.capabilityIri
              ? { capabilityRequirements: [{ capabilityIri: s.capabilityIri, minAssertionStrength: 'declared' as const }] }
              : {}),
          }));
        // Boundary 1 of 2: what we SEND to proposePlan. Bracketed with the parse-side log so the
        // side that receives the field and returns it stripped is identifiable in one dispatch.
        console.log('[plan propose] sending capabilityRequirements:',
          JSON.stringify(proposedSteps.map((s) => (s as Record<string, unknown>).capabilityRequirements ?? null)));
        const out = (await this.interactionsInternal(principal, 'internal.endeavor.proposePlan', {
          endeavorId,
          steps: proposedSteps,
        })) as { ok?: boolean; error?: string; planId?: string; revision?: number };
        // Auto-work: the SAME turn that drafted the plan now adopts + executes it (the agent does the
        // work). Off ⇒ draft-only, a steward reviews/adopts. Autopilot failures never fail the draft.
        let autopilot: { adopted?: boolean; stepsDone?: number; satisfied?: boolean; error?: string } | undefined;
        if (p.autoWork) {
          // The draft must still succeed if the work run fails — but a DISCARDED reason made every
          // autopilot failure look identical to "the plan drafted and nothing ran yet". That was
          // survivable while the work was in-worker; it is not once a step can be dispatched to
          // another organization, where a wrong grant, a revoked grant and a host missing the role
          // all fail here and all used to vanish.
          autopilot = await this.runEndeavorWork(principal, endeavorId).catch((e) => {
            const error = e instanceof Error ? e.message : String(e);
            console.error('[endeavor autopilot] run failed:', endeavorId, error);
            return { adopted: false, stepsDone: 0, satisfied: false, error };
          });
        }
        return Response.json({ ok: true, planId: out.planId, revision: out.revision, steps: draft.steps.length, plannerKind: draft.plannerKind, ...(autopilot ? { autopilot } : {}) });
      } catch (e) {
        return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 502 });
      }
    }
    // spec 334 §6 auto-work — the org agent auto-triages (ADOPTS) a pending request, then the
    // adoption seeds the plan draft (which, being auto-work, chains into execute).
    if (url.pathname === '/internal/endeavor-adopt') {
      if (!isInternalCall(req, this.env)) return Response.json({ ok: false, error: 'internal op — not authorized' }, { status: 403 });
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
      if (!isInternalCall(req, this.env)) return Response.json({ ok: false, error: 'internal op — not authorized' }, { status: 403 });
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
    // THE FOLDED WIRE (spec 372 S4). One set of method names — A2A 1.0's — and the delegation-authorized
    // runtime behind `SendMessage` carrying the delegated-task extension. This used to be a second wire of
    // our own (`message/send`, `tasks/get`); the authority it carried moved into the extension and the
    // gates behind it are unchanged. The caller is authenticated at the Worker's door and passed in;
    // absent, only the message's own signature speaks for it, which is what a peer agent presents.
    const agentSA = (url.searchParams.get('agent') ?? (await this.state.storage.get<string>(AGENT_SA_KEY))) as Address | null;
    if (!agentSA) return Response.json({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'agent not bound to this task store' } }, { status: 400 });
    await this.state.storage.put(AGENT_SA_KEY, agentSA); // remember for alarm() rehydration

    let envelope: { rpc?: unknown; principal?: { agent?: string } | null };
    try { envelope = await req.json(); } catch { return Response.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); }
    const rpc = (envelope?.rpc ?? envelope) as { method?: string };
    const who = envelope?.principal?.agent ? { agent: String(envelope.principal.agent).toLowerCase() } : null;

    const server = this.standardServer(agentSA, who);
    const res = await server.handle(new Request('https://a2a-task-do/', {
      method: 'POST', headers: { 'content-type': 'application/json', 'a2a-version': '1.0' }, body: JSON.stringify(rpc),
    }));
    const resp = await res.json().catch(() => ({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'the folded wire returned no JSON' } }));
    // Schedule the runtime to advance any newly-due task (alarm() runs processDue()).
    if (rpc?.method === 'SendMessage') await this.state.storage.setAlarm(Date.now() + ALARM_DELAY_MS);
    return Response.json(resp);
  }

  /** The A2A 1.0 server over this object's runtime + store (spec 372 S4). Built per request so the
   *  authenticated caller is the one this request proved, never a cached one. */
  private standardServer(agentSA: Address, principal: { agent: string } | null) {
    const agent = this.build(agentSA);
    return createAgentBackedServer({
      agent,
      runtimeStore: createDurableObjectTaskStore(this.state.storage),
      ownStore: createMemoryTaskStore(),
      // Internal, never served: the PUBLIC card is the Worker's, and it advertises the same extension.
      card: {
        name: agentSA, description: 'delegation-authorized tasks', version: '1',
        supportedInterfaces: [{ url: 'https://a2a-task-do/', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
        capabilities: { streaming: false, pushNotifications: true },
        defaultInputModes: ['application/json'], defaultOutputModes: ['application/json'], skills: [],
      },
      ...(principal ? { principal: async () => principal } : {}),
    });
  }

  /** Spec 370 P5 — arm the single alarm for the earliest due trigger, unless something sooner is set. */
  private async armTriggerAlarm(): Promise<void> {
    const rows = [...(await this.state.storage.list<{ nextAt?: number }>({ prefix: 'harness:trigger:' })).values()];
    const next = rows.length ? Math.min(...rows.map((r) => Number(r.nextAt ?? 0)).filter((n) => n > 0)) : null;
    if (next === null || !Number.isFinite(next)) return;
    const current = await this.state.storage.getAlarm();
    if (current === null || current > next) await this.state.storage.setAlarm(Math.max(next, Date.now() + 1000));
  }

  /** Spec 370 P5 — run every due trigger once: the agent asks as itself, presenting nothing. */
  private async fireDueTriggers(): Promise<void> {
    const rows = [...(await this.state.storage.list<TriggerScheduleV1>({ prefix: 'harness:trigger:' })).values()];
    for (const row of dueNow(rows)) {
      let outcome: TriggerScheduleV1['lastOutcome'] = 'failed';
      let said: string | undefined;
      let runRef = `trigger-${row.triggerId}-${Date.now().toString(36)}`;
      try {
        const r = await runUnattendedAsk(this.env, row, runRef);
        outcome = r.outcome; said = r.said; runRef = r.runRef;
      } catch (e) {
        said = e instanceof Error ? e.message : String(e);
      }
      await this.state.storage.put(`harness:trigger:${row.triggerId}`, advanced(row, outcome, runRef, said));
    }
  }

  async alarm(): Promise<void> {
    const agentSA = await this.state.storage.get<string>(AGENT_SA_KEY);
    // Spec 370 P5 — triggers fire even for an agent that has never run a task here: the schedule was
    // synced by an ask, and the ask route stored the SA for exactly this rehydration.
    try { await this.fireDueTriggers(); } catch (e) { console.warn('[triggers] firing failed:', e instanceof Error ? e.message : String(e)); }
    try { await this.armTriggerAlarm(); } catch { /* re-armed on the next sync */ }
    if (!agentSA) return;
    const agent = this.build(agentSA as Address);
    await agent.processDue();
    // Spec 380 W3 — a routed topic turn is one harness run; there are no pending fan-outs to advance here.
    const routingRemain = false;
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
    const stub = this.env.INTERACTIONS.get(this.env.INTERACTIONS.idFromName(principal.toLowerCase()));
    const resp = await stub.fetch(new Request(`https://do/interactions/${principal.toLowerCase()}/${op}`, {
      method: 'POST', headers: internalHeaders(this.env), body: JSON.stringify(payload),
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
    type PlanStep = {
      stepId: string; kind: string; description: string; satisfied: boolean;
      capabilityRequirements?: Array<{ capabilityIri: string }>;
    };
    type StateOut = {
      lifecycle: string | null; goal: string; requester: string | null;
      adoptedPlanRef: { planId: string; revision: number; hash: string } | null;
      latestPlan: { planId: string; revision: number; contentHash: string } | null;
      plan: { planId: string; revision: number; contentHash: string; steps: PlanStep[] } | null;
      /** Spec 382 — active commitments: a step somebody else promised is theirs to run, not this turn's. */
      commitments?: Array<{ commitmentId: string; participant: string; steps: string[] }>;
    };
    let state = (await this.interactionsInternal(principal, 'internal.endeavor.state', { endeavorId })) as StateOut & { ok?: boolean };
    if (state.lifecycle !== 'adopted' && state.lifecycle !== 'active') return { adopted: false, stepsDone: 0, satisfied: state.lifecycle === 'satisfied' };

    // The org's playbook applies to every step turn and the synthesis, so read it ONCE for the run
    // (spec 327 §4b / 334 §6). '' when the steward authored none — the turns keep their built-ins.
    const playbook = await this.readOrgPlaybook(principal);

    // ROUTING INPUTS, read ONCE per run: the grants we hold (which hosts may we ask, for what) and
    // the wire that lets this org sign as itself. Both fail soft to "run every step locally", which
    // is exactly today's behaviour — so an org with no grants, or one whose steward has not widened
    // its wire, is unaffected rather than broken.
    const archetypeHosts = await this.interactionsInternal(principal, 'internal.archetype.hosts', {})
      .then((r) => ((r as { hosts?: ArchetypeHostGrant[] }).hosts ?? []))
      .catch(() => [] as ArchetypeHostGrant[]);
    const orgWire = archetypeHosts.length
      ? await this.interactionsInternal(principal, 'internal.consult.orgWire', {})
          .then((r) => ((r as { wire?: IncomingDelegation | null }).wire ?? null))
          .catch(() => null)
      : null;

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
      // Spec 382 — A COMMITTED STEP IS THE PARTICIPANT'S. Somebody signed a promise to do this one; it was
      // handed to their agent when they committed (`parkCommittedSteps`) and it is finished with THEIR
      // mandate. The organization running it for them would be allocation acting as authority.
      const promised = (state.commitments ?? []).find((c) => c.steps.includes(step.stepId) && c.participant.toLowerCase() !== principal.toLowerCase());
      if (promised) { console.log(`[endeavor step] ${endeavorId} ${step.stepId} is committed to ${promised.participant} (${promised.commitmentId}) — theirs to run`); continue; }
      if (!firstTurn) await pace();
      firstTurn = false;
      // AUTHORITY BEFORE WORK. A step that names a capability this substrate can exercise is not a
      // writing task: it must not be satisfied by a paragraph saying it happened, and it must not be
      // executed by an agent nobody authorized. It becomes work waiting on a person — a durable run
      // (spec 350 W3) a steward finishes by granting the mandate — and the step stays OPEN until it does.
      const needsAuthority = authorityCapabilityOf(step);
      if (needsAuthority) {
        const runRef = `run-${crypto.randomUUID()}`;
        // Spec 384 W3 — A STEP THE ORGANIZATION ENGAGES ANOTHER PARTY FOR. The plan made it an interaction, or the
        // capability is outside this agent's own offer set (its playbook, else the bare harness — the same set the
        // Ask sees). Then candidates are found in the public tier, each probed once as the organization within a
        // disclosure budget, the offers judged by named rules, the selection RECORDED on the endeavor, and the run
        // parked bound to the selected provider and its offer: the steward's mandate must NAME that offer. No
        // offer ⇒ the step still parks, open, and the note says who was asked and what each said.
        let engagement: Awaited<ReturnType<typeof runEngagementCampaign>> | null = null;
        let because: ReturnType<typeof engagesProvider> = null;
        try {
          const deps = harnessDeps(this.env, buildAuditSink(this.env));
          const playbook = await loadPlaybook(deps.readSubjectRecord, principal, console.log).catch(() => null);
          const own = new Set(scopedActionTools(undefined, playbook).map((t) => t.capability?.id ?? t.id));
          because = engagesProvider(step, needsAuthority, own);
          if (because) {
            engagement = await runEngagementCampaign(
              { requester: principal as Address, source: candidateSourceFor(this.env, principal as Address), sendProbe: probeSenderFor(this.env, principal as Address), fetchDiscovery: discoveryFetchFor(this.env), ...(deps.nameOf ? { nameOf: deps.nameOf } : {}), ...(deps.resolveName ? { resolveName: deps.resolveName } : {}) },
              { campaignId: `camp_${runRef}`, capability: needsAuthority, words: step.description.trim(), budget: { maxCandidates: 5, offersWanted: 1, deadlineMs: 10 * 60_000 } },
            );
            console.log(`[endeavor step] ${endeavorId} ${step.stepId}: campaign for ${needsAuthority} (${because}) asked ${engagement.campaign.candidates.length}, selected ${engagement.selection?.selected.provider ?? 'nobody'}`);
          }
        } catch (e) {
          // The campaign failed to run: the step still parks to the stewards, and the endeavor is told why.
          console.error('[endeavor step] campaign failed:', endeavorId, step.stepId, e);
          await this.interactionsInternal(principal, 'internal.endeavor.post', { endeavorId, bodyText: `[agent] could not ask other agents about "${step.description}" — ${e instanceof Error ? e.message : String(e)}` }).catch(() => undefined);
        }
        const checkpoint = checkpointForStep({ runRef, principal: principal as Address, endeavorId, step, goal, ...(engagement?.binding ? { engagement: engagement.binding } : {}) });
        try {
          await this.state.storage.put(`harness:run:${runRef}`, checkpoint);
          await this.interactionsInternal(principal, 'internal.endeavor.post', {
            endeavorId, bodyText: engagement && because
              ? campaignNote({ capability: needsAuthority, principal: principal as Address, outcome: engagement, runRef, stepDescription: step.description, because })
              : awaitingAuthorityNote({ capability: needsAuthority, principal: principal as Address, runRef, step }),
          });
        } catch (e) {
          console.error('[endeavor step] could not park an authority-bearing step:', endeavorId, step.stepId, e);
        }
        continue; // NOT satisfied: an agent that cannot be authorized to do a thing must not report it done.
      }

      let output: string;
      try {
        // A SPECIALIST FIRST when the step declared a capability and some host granted it. Null
        // means this step is ours; a throw means a dispatch is in flight and unfinished, which the
        // catch below records so the next window collects rather than re-dispatching.
        const specialist = await this.tryArchetypeStep({
          principal, endeavorId, step,
          hosts: archetypeHosts, orgWire,
          material: { currentTurtle: priorOutputs.map((x) => x.output).join('\n\n').slice(0, 40_000) },
        });
        if (specialist) {
          output = specialist;
        } else {
          const turn = await executeEndeavorStep(this.env, {
            principal, endeavorId, goal, stepKind: step.kind, stepDescription: step.description, priorOutputs, playbook, references,
          });
          output = turn.output;
        }
      } catch (e) {
        // Left open for a human — but WHY is posted to the endeavor rather than discarded. A step
        // that silently stays open is indistinguishable from one nobody reached yet, and that is
        // exactly the confusion a cross-org dispatch failure would otherwise cause.
        const why = e instanceof Error ? e.message : String(e);
        console.error('[endeavor step] failed:', endeavorId, step.stepId, why);
        await this.interactionsInternal(principal, 'internal.endeavor.post', {
          endeavorId, bodyText: `[agent] could not complete "${step.description}" — ${why}`,
        }).catch(() => undefined);
        continue;
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
    const fromCaip = caip10(chainId, fromSa.toLowerCase() as Address) as AnyMessageEnvelope['from'];
    const toCaip = caip10(chainId, recipient.toLowerCase() as Address) as AnyMessageEnvelope['from'];
    const now = new Date().toISOString();
    const messageId = generateMessageId();
    const subject = `Your request is complete: ${goal}`.slice(0, 120);
    const bodyText = `Your request has been completed.\n\nRequest: ${goal}\n\nOutcome:\n${outcome}`;
    const bodyBytes = new TextEncoder().encode(bodyText);
    const envelope: MessageEnvelopeV2 = {
      version: 'ap.message.v2',
      id: messageId,
      conversationId: generateConversationId(),
      performative: 'INFORM',
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
  private signAsOrg(orgWire: IncomingDelegation, digest: Hex): Promise<Hex> {
    return signAsOrg(this.env, orgWire, digest);
  }

  /** Methods this agent advertises for the archetypes its library defines. Last good value: a
   *  failed refresh keeps the previous list rather than un-advertising roles that still exist. */
  private archetypeMethods: string[] = [];
  private archetypeCacheAt = 0;

  /** Fire-and-forget catalog refresh, rate-limited. Never awaited by the card — a discovery read
   *  must not make serving the card depend on the library being reachable. */
  private refreshArchetypeCatalog(agentSA: string): void {
    if (Date.now() - this.archetypeCacheAt < 60_000) return;
    this.archetypeCacheAt = Date.now();
    void (async () => {
      try {
        const r = await this.interactionsInternal(agentSA, 'internal.library.packages', {});
        const packages = ((r as { packages?: LibraryPackageMeta[] }).packages ?? []);
        this.archetypeMethods = buildArchetypeCatalog(packages).archetypes.map((a) => a.method);
      } catch { /* keep the last good list — an unreachable library is not evidence a role is gone */ }
    })();
  }

  /**
   * THE ARCHETYPE RELAY — this org dispatching to a specialist ON BEHALF of a caller it trusts.
   *
   * A platform tool needs to reach a specialist to time it, but a service identity has no Durable
   * Object and so cannot hold a grant of its own. Rather than mint one, the call flows through the
   * DOMAIN ORG: it is already an organization, it already holds the host's grant, and everything
   * stays org-to-org with no platform-level authority anywhere.
   *
   * THE CONFUSED-DEPUTY BOUND, which is the whole risk of a relay: this org will only forward to a
   * host+archetype it ALREADY HOLDS A GRANT FOR. The relay therefore cannot exceed what this org
   * could do itself — a caller who reaches it gains this org's reach, never more than it. The A2A
   * gate has already verified the caller may invoke `archetype.relay` before we get here; this is
   * the second bound, on what the relay may then do.
   */
  private async handleArchetypeRelay(input: unknown): Promise<{ ok: true; taskId: Hex } | { ok: false; error: string }> {
    const o = (input ?? {}) as Record<string, unknown>;
    const archetype = String(o.archetype ?? '').trim().toLowerCase();
    const host = String(o.host ?? '').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{1,60}$/.test(archetype)) return { ok: false, error: 'archetype required' };
    if (!/^0x[0-9a-f]{40}$/.test(host)) return { ok: false, error: 'host (agent address) required' };
    if (!String(o.stepGoal ?? '').trim()) return { ok: false, error: 'stepGoal required' };

    // AGENT_SA_KEY, the key the DO actually rehydrates from for alarm() — not a guessed literal.
    const principal = ((await this.state.storage.get<string>(AGENT_SA_KEY)) ?? '').toLowerCase();
    if (!principal) return { ok: false, error: 'this agent has no identity' };

    // Bound 1: do we hold a grant from that host, for that archetype?
    const hosts = await this.interactionsInternal(principal, 'internal.archetype.hosts', {})
      .then((r) => ((r as { hosts?: Array<{ host: string; archetypes: string[] }> }).hosts ?? []))
      .catch(() => [] as Array<{ host: string; archetypes: string[] }>);
    const held = hosts.find((h) => h.host.toLowerCase() === host);
    if (!held) return { ok: false, error: `this organization holds no dispatch grant from ${host}` };
    if (held.archetypes.length && !held.archetypes.includes(archetype)) {
      return { ok: false, error: `the grant from ${host} does not name "${archetype}" (has: ${held.archetypes.join(', ')})` };
    }

    const orgWire = await this.interactionsInternal(principal, 'internal.consult.orgWire', {})
      .then((r) => ((r as { wire?: IncomingDelegation | null }).wire ?? null))
      .catch(() => null);
    if (!orgWire) return { ok: false, error: 'this organization has no signing wire — re-run routing-enable' };

    try {
      const sent = await this.dispatchArchetypeWork({
        org: principal as Address, orgWire, host: host as Address, archetype,
        input: {
          stepGoal: String(o.stepGoal), 
          ...(o.extra ? { extra: String(o.extra) } : {}),
          ...(o.currentTurtle ? { currentTurtle: String(o.currentTurtle) } : {}),
          ...(o.specDigest ? { specDigest: String(o.specDigest) } : {}),
          ...(Array.isArray(o.specPaths) ? { specPaths: (o.specPaths as unknown[]).map(String) } : {}),
        },
      });
      return { ok: true, taskId: sent.taskId };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** The RESULT half. The caller is not a party to the task the host created — this org is — so it
   *  cannot poll the host directly and the relay has to read it back too. */
  private async handleArchetypeRelayResult(input: unknown): Promise<Record<string, unknown>> {
    const o = (input ?? {}) as Record<string, unknown>;
    const host = String(o.host ?? '').trim().toLowerCase();
    const taskId = String(o.taskId ?? '').trim();
    if (!/^0x[0-9a-f]{40}$/.test(host) || !/^0x[0-9a-f]{64}$/i.test(taskId)) {
      return { ok: false, error: 'host and taskId required' };
    }
    const principal = ((await this.state.storage.get<string>(AGENT_SA_KEY)) ?? '').toLowerCase();
    const orgWire = await this.interactionsInternal(principal, 'internal.consult.orgWire', {})
      .then((r) => ((r as { wire?: IncomingDelegation | null }).wire ?? null))
      .catch(() => null);
    if (!orgWire) return { ok: false, error: 'this organization has no signing wire' };
    try {
      const deliverable = await this.collectArchetypeWork({
        org: principal as Address, orgWire, host: host as Address, taskId: taskId as Hex,
      });
      return { ok: true, state: 'completed', deliverable };
    } catch (e) {
      // "not finished yet" is a normal answer here, not a failure — the caller polls.
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: true, state: /not finished yet/.test(msg) ? 'running' : 'failed', error: msg };
    }
  }

  /**
   * Try to have a SPECIALIST do this step, on another organization's agent.
   *
   * Returns the deliverable when a specialist produced one, or null when the step is ours to run —
   * no capability, no archetype for it, or no host that granted us one. Those are different
   * situations with different fixes (a plan wanting no specialist, a modelling gap, a missing
   * ceremony); only the last is a surprise worth logging.
   *
   * THROWS when a dispatch is IN FLIGHT but unfinished. Not a failure — the honest answer for work
   * someone else is still doing. The step loop posts the reason and leaves the step open, so the
   * next window COLLECTS instead of re-dispatching.
   */
  private async tryArchetypeStep(args: {
    principal: string;
    endeavorId: string;
    step: { stepId: string; description: string; capabilityRequirements?: Array<{ capabilityIri: string }> };
    hosts: ArchetypeHostGrant[];
    orgWire: IncomingDelegation | null;
    material: { specDigest?: string; specPaths?: string[]; currentTurtle?: string };
  }): Promise<string | null> {
    const decision = chooseArchetypeRoute(args.step.capabilityRequirements, args.hosts);
    if (!decision.route) {
      if (/no host has granted/.test(decision.reason)) {
        console.log('[archetype route] unroutable:', args.endeavorId, args.step.stepId, decision.reason);
      }
      return null;
    }
    if (!args.orgWire) {
      // The org cannot sign as itself, so it cannot dispatch. Run locally rather than fail the step
      // — but say so: the fix is a ceremony, and nothing else would surface it.
      console.log('[archetype route] no org wire — running locally:', args.endeavorId, args.step.stepId);
      return null;
    }
    const { host, archetype } = decision.route;

    // DOES THE WIRE ACTUALLY COVER THIS METHOD? Presence is not scope. An org whose wire still names
    // only `discussion.consult` — every org that has not re-run routing-enable since the wire was
    // widened — would otherwise dispatch and be refused at the HOST's gate, turning a local
    // ceremony gap into a failed step on someone else's agent. The same membership check the host
    // will apply, applied here first, so the answer is "run it locally" rather than a rejection.
    const tsEnf = (this.env.TIMESTAMP_ENFORCER ?? '').toLowerCase();
    const amEnf = (this.env.ALLOWED_METHODS_ENFORCER ?? '').toLowerCase();
    const scopeErr = [tsEnf, amEnf].every((a) => /^0x[0-9a-f]{40}$/.test(a))
      ? checkSessionWireShape(args.orgWire, { timestamp: tsEnf, allowedMethods: amEnf },
          Math.floor(Date.now() / 1000), { skill: `archetype.${archetype}` })
      : 'enforcers not configured — cannot check the wire scope';
    if (scopeErr) {
      // Named loudly: the fix is a ceremony (re-enable routing to widen the wire) and nothing else
      // would surface it — the step would just quietly keep running locally forever.
      console.log('[archetype route] org wire does not cover this method — running locally:',
        args.endeavorId, args.step.stepId, `archetype.${archetype}`, scopeErr);
      return null;
    }

    const key = this.archetypeDispatchKey(args.endeavorId, args.step.stepId);
    const prior = (await this.state.storage.get(key)) as { taskId?: Hex } | undefined;

    let taskId = prior?.taskId;
    if (!taskId) {
      const sent = await this.dispatchArchetypeWork({
        org: args.principal as Address, orgWire: args.orgWire, host: host as Address, archetype,
        input: {
          stepGoal: args.step.description, endeavorId: args.endeavorId, stepId: args.step.stepId,
          capabilityIri: decision.route.capabilityIri,
          ...(args.material.specDigest ? { specDigest: args.material.specDigest } : {}),
          ...(args.material.specPaths?.length ? { specPaths: args.material.specPaths } : {}),
          ...(args.material.currentTurtle ? { currentTurtle: args.material.currentTurtle } : {}),
        },
      });
      taskId = sent.taskId;
      // Recorded BEFORE collecting: a crash between send and record re-dispatches next window and
      // charges the host twice for the same step.
      await this.state.storage.put(key, { host, archetype, taskId, sentAt: new Date().toISOString() });
    }
    return this.collectArchetypeWork({
      org: args.principal as Address, orgWire: args.orgWire, host: host as Address, taskId,
    });
  }


  /**
   * The per-step dispatch record: `(endeavor, step)` → the task we raised on the host.
   *
   * THIS IS THE CORRECTNESS PIECE, not bookkeeping. Work runs one continuation per window, so a step
   * whose host has not finished yet WILL be revisited. Without a record the revisit dispatches
   * again — a second task, a second turn, and a second charge against another organization's agent
   * budget for work already in flight. With one, a revisit COLLECTS.
   */
  private archetypeDispatchKey(endeavorId: string, stepId: string): string {
    return `archetype.dispatch:${endeavorId}:${stepId}`;
  }

  /**
   * Read a dispatched archetype step's result, or say why it is not ready.
   *
   * Mirrors the consult rail's turn-2 collection (`processRoutingDue`): a SIGNED `tasks/get` on the
   * host's runtime, then the artifact. The distinctions it makes are the ones that cost the consult
   * rail to learn — a terminal failure and a still-running task are different answers, and a
   * transient poll failure is neither, so it must not be recorded as either.
   *
   * Returns the deliverable text when complete; throws with a reason otherwise, which the step loop
   * posts to the endeavor and leaves the step open for the next window.
   */
  private async collectArchetypeWork(args: {
    org: Address;
    orgWire: IncomingDelegation;
    host: Address;
    taskId: Hex;
  }): Promise<string> {
    const host = args.host.toLowerCase();
    // The folded wire (spec 372 S4): GetTask as the org — a party to the task — not a signed poll.
    const read = await readDelegatedTask(this.env, { org: args.org, target: host, taskId: args.taskId });
    const state = read.state;
    if (state === 'failed' || state === 'rejected' || state === 'canceled') {
      // Terminal on the host's side — surfaced with ITS reason, so "the specialist declined" does
      // not read as "we could not reach it".
      throw new Error(`archetype task ${state} on ${host}${read.error ? `: ${read.error}` : ''}`);
    }
    if (state !== 'completed') throw new Error(`archetype task not finished yet (${state ?? 'unknown'}) — collecting next window`);
    const artifactId = read.artifactIds[0];
    if (!artifactId) throw new Error('archetype task completed with no artifact to read');

    const body = (await this.readConsultArtifact(host, args.taskId, args.org, artifactId)) as
      | { deliverable?: string; declined?: boolean; declineReason?: string; citedSpecs?: string[] }
      | null;
    if (!body) throw new Error('archetype artifact was unreadable');
    if (body.declined) {
      // A decline is a RESULT, not a failure to retry: the specialist judged the step outside its
      // remit. Re-dispatching would ask the same question and get the same answer.
      throw new Error(`archetype declined the step: ${body.declineReason ?? 'no reason given'}`);
    }
    const text = String(body.deliverable ?? '').trim();
    if (!text) throw new Error('archetype returned an empty deliverable');
    return body.citedSpecs?.length ? `${text}\n\n(cited: ${body.citedSpecs.join(', ')})` : text;
  }

  /**
   * DISPATCH ONE PLAN STEP TO A HOST ORG'S ARCHETYPE.
   *
   * The cross-org half of the archetype rail: this org asks another org's specialist to carry out
   * one step, over standard `message/send`, addressed to the METHOD `archetype.<slug>`.
   *
   * SEND-TIME GRANT RE-READ, for the same reason consult does it: the host's opt-in is fetched fresh
   * per send, so an on-chain revocation stops the NEXT dispatch rather than one after a cache
   * expires. No grant, no dispatch, no exception (ADR-0013).
   *
   * What travels is MATERIAL — the step, the requesting domain's spec excerpts, the ontology so far.
   * Never the specialist's instructions: the host composes those from its own library, and a caller
   * that could supply them would be writing its own reviewer.
   */
  private async dispatchArchetypeWork(args: {
    org: Address;
    orgWire: IncomingDelegation;
    host: Address;
    archetype: string;
    input: Record<string, unknown>;
  }): Promise<{ taskId: Hex }> {
    const grantResp = (await this.interactionsInternal(
      args.org, 'internal.archetype.grant', { host: args.host.toLowerCase() },
    )) as { wire?: IncomingDelegation };
    if (!grantResp.wire) {
      throw new Error(`no archetype dispatch grant from ${args.host} — the host organization has not opted in (or revoked)`);
    }
    const method = `archetype.${args.archetype}`;
    const body = { ...args.input, version: 'ap.archetype.work.v1', archetype: args.archetype };
    // The folded wire (spec 372 S4): SendMessage carrying the delegated-task extension, signed as the org.
    let sent: { taskId: Hex };
    try {
      sent = await submitDelegatedTask(this.env, { org: args.org, orgWire: args.orgWire, grant: grantResp.wire, target: args.host, skill: method, input: body });
    } catch (e) {
      throw new Error(`archetype dispatch rejected by ${args.host}: ${e instanceof Error ? e.message : String(e)}`);
    }
    return { taskId: sent.taskId };
  }

  /** Read one completed consult's answer artifact from the MEMBER's runtime (marker-gated body
   *  fetch AFTER the signed tasks/get proved sender-ship — see /internal/consult-artifact). */
  private readConsultArtifact(memberSA: string, taskId: Hex, org: string, artifactId: string): Promise<unknown> {
    return readConsultArtifact(this.env, memberSA, taskId, org, artifactId);
  }

}
