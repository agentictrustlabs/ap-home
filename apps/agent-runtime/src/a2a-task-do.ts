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
  type A2aAgent,
  type A2aBudgetPort,
  type OnChainChecks,
  type VaultClient,
  type McpClient,
  type SkillHandler,
} from '@agenticprimitives/a2a';
import { createDurableObjectTaskStore } from '@agenticprimitives/a2a/cloudflare';
import { createDurableObjectBudgetStore } from '@agenticprimitives/rate-control-cloudflare';
import { createChainAuthorityReader } from '@agenticprimitives/chain-state';
import { createViemChainProvider } from '@agenticprimitives/chain-state-viem';
// ADR-0044 — the Ring-0 agentic loop. The `orchestrate` skill runs the SHARED orchestration core (tools +
// planner selection live in ./orchestration, reused by the /a2a/intent relayer); the LLM binding stays
// behind the Planner port (the chain-state-viem pattern), selected by env at request time.
import { runOrchestration } from './orchestration.js';
import { makeMessagingSkills } from './messaging-skills.js';
import { buildA2aReceiptsConfig } from './receipts.js';
// FR-3.4 — deliver artifacts into a principal's demo-mcp vault over their delegation. The value import is
// cyclic with index.ts, but safe: `callMcpToolViaDelegation` is a hoisted function used only at request
// time (never at module-init), and `Env`/`IncomingDelegation` are type-only.
import { callMcpToolViaDelegation, type Env, type IncomingDelegation } from './index.js';

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

// ── The Ring-0 agentic model (ADR-0044) ──────────────────────────────────────────────────────────────
/** The `orchestrate` skill — the intent-task entry point. Reads a GOAL, plans which MCP tool composes to
 *  satisfy it (shared core in ./orchestration), runs it under the TASK's delegation (every call rides
 *  on-chain authority — the invoker wraps `ctx.mcp.callTool`), and emits the result as an artifact. */
function makeOrchestrateSkill(env: Env): SkillHandler {
  return {
    skill: 'orchestrate',
    handle: async (ctx) => {
      const raw = ctx.input as { goal?: unknown } | string | null;
      const goal = typeof raw === 'string' ? raw : typeof raw?.goal === 'string' ? raw.goal : '';
      if (!goal.trim()) return { state: 'failed', error: 'orchestrate requires input.goal (a declarative goal)' };

      const { result, plannerKind } = await runOrchestration(env, {
        goal,
        principal: ctx.principal,
        // The invoker IS the authority boundary: every composed MCP call rides the TASK's delegation.
        invoke: async (toolId, toolArgs) => ctx.mcp.callTool({ tool: toolId, toolArgs, delegation: ctx.delegation }),
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
        },
      });
      return result.outcome === 'completed'
        ? { state: 'completed', artifactIds: [artifactId] }
        : { state: 'failed', artifactIds: [artifactId], error: result.error };
    },
  };
}

const AGENT_SA_KEY = '__a2a_agent_sa';
const ALARM_DELAY_MS = 1500;

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
    const checks: OnChainChecks = {
      // Fail-closed: any throw propagates and the package denies (ADR-0013).
      isRevoked: reader
        ? async (d) => (await reader.isDelegationRevoked(hashDelegation(d, chainId, dm))).revoked
        : async (d) => (await pub.readContract({ address: dm, abi: IS_REVOKED_ABI, functionName: 'isRevoked', args: [hashDelegation(d, chainId, dm)] })) as boolean,
      verifyDelegationSignature: async (d) => verifySig(d.delegator, hashDelegation(d, chainId, dm), d.signature as Hex),
      verifyMessageSignature: async (msg, digest) => verifySig(msg.sender as Address, digest, msg.signature as Hex),
      // AUDIT NEW-A2A-2 — the read/control caller proves control of `caller` via ERC-1271 over the request digest.
      verifyCallerSignature: async (caller, digest, signature) => verifySig(caller as Address, digest, signature as Hex),
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
          const resp = await callMcpToolViaDelegation({ env, toolName: 'set_vault_record', delegation: toWire(delegation), requester: delegation.delegate as Address, toolArgs: { recordType, data } });
          if (!resp.ok) throw new Error(`a2a vault write via delegation failed (HTTP ${resp.status})`);
          return { owner, recordType };
        }
        await this.state.storage.put(`vault:${owner.toLowerCase()}:${recordType}`, data);
        return { owner, recordType };
      },
      read: async (ref, opts) => {
        if (opts?.delegation) {
          const resp = await callMcpToolViaDelegation({ env, toolName: 'get_vault_record', delegation: toWire(opts.delegation), requester: opts.delegation.delegate as Address, toolArgs: { recordType: ref.recordType } });
          if (!resp.ok) return null;
          const j = (await resp.json().catch(() => null)) as { data?: unknown } | null;
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
    type DelegatedToolName = Parameters<typeof callMcpToolViaDelegation>[0]['toolName'];
    const mcp: McpClient = {
      callTool: async ({ tool, toolArgs, delegation }) => {
        if (!ALLOWED_MCP_TOOLS.has(tool)) throw new Error(`mcp tool not exposed by this agent: ${tool}`);
        if (!delegation) throw new Error(`orchestrated MCP call requires a task delegation (tool ${tool})`);
        const resp = await callMcpToolViaDelegation({
          env,
          toolName: tool as DelegatedToolName,
          delegation: toWire(delegation),
          requester: delegation.delegate as Address,
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
      checks, handlers: [echo, makeOrchestrateSkill(this.env), ...makeMessagingSkills(agentSA, async (recipient, envelope, body) => {
        // spec 323 W3.2 — the recipient's InteractionsDO does BOTH admissions with its OWN held
        // delivery wire: the body (internal.dm.body.put) then the inbox.data merge (internal.deliver).
        const stub = this.env.INTERACTIONS.get(this.env.INTERACTIONS.idFromName(recipient.toLowerCase()));
        const call = async (op: string, payload: unknown): Promise<void> => {
          const resp = await stub.fetch(new Request(`https://do/interactions/${recipient.toLowerCase()}/${op}`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
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
    // If anything remains due (e.g. auth-required→resubmit just landed), re-arm.
    const store = createDurableObjectTaskStore(this.state.storage);
    if ((await store.listDue(Date.now())).length > 0) await this.state.storage.setAlarm(Date.now() + ALARM_DELAY_MS);
  }
}
