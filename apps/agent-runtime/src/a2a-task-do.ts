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
  type OnChainChecks,
  type VaultClient,
  type SkillHandler,
} from '@agenticprimitives/a2a';
import { createDurableObjectTaskStore } from '@agenticprimitives/a2a/cloudflare';
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

export class A2aTaskDO {
  private agent: A2aAgent | null = null;
  constructor(private state: DurableObjectState, private env: Env) {}

  private build(agentSA: Address): A2aAgent {
    if (this.agent) return this.agent;
    const pub = createPublicClient({ chain: baseSepolia, transport: http(this.env.RPC_URL) });
    const chainId = Number(this.env.CHAIN_ID ?? 84532);
    const dm = this.env.DELEGATION_MANAGER as Address;
    const erc1271 = async (account: Address, digest: Hex, signature: Hex): Promise<boolean> => {
      const magic = (await pub.readContract({ address: account, abi: ERC1271_ABI, functionName: 'isValidSignature', args: [digest, signature] })) as Hex;
      return magic.toLowerCase() === ERC1271_MAGIC;
    };
    const checks: OnChainChecks = {
      // Fail-closed: any throw propagates and the package denies (ADR-0013).
      isRevoked: async (d) => (await pub.readContract({ address: dm, abi: IS_REVOKED_ABI, functionName: 'isRevoked', args: [hashDelegation(d, chainId, dm)] })) as boolean,
      verifyDelegationSignature: async (d) => erc1271(d.delegator, hashDelegation(d, chainId, dm), d.signature as Hex),
      verifyMessageSignature: async (msg, digest) => erc1271(msg.sender as Address, digest, msg.signature as Hex),
      // AUDIT NEW-A2A-2 — the read/control caller proves control of `caller` via ERC-1271 over the request digest.
      verifyCallerSignature: async (caller, digest, signature) => erc1271(caller as Address, digest, signature as Hex),
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
    this.agent = createA2aAgent({
      agentSA, chainId, delegationManager: dm,
      enforcers: { timestamp: this.env.TIMESTAMP_ENFORCER as Address, allowedTargets: this.env.ALLOWED_TARGETS_ENFORCER as Address, allowedMethods: this.env.ALLOWED_METHODS_ENFORCER as Address },
      taskStore: createDurableObjectTaskStore(this.state.storage),
      checks, handlers: [echo], vault, mcp: { callTool: async () => null }, hashBody,
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
