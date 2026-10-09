// A SELF-HOSTED AGENT'S READ WIRE — spec 433 W2. The Home sends this runtime every `/harness/*` read, and for an agent that
// keeps its runs at its OWN host (scripture-resolver.svc on its Worker) the read must be forwarded there under a credential
// THAT host can verify. A Home session is not one: the token is this estate's. What a self-hosted agent verifies is its
// own wire — a delegation FROM the agent TO this runtime's interactions-session key, signed by the agent's custodian at its
// charter (the same persona-sign ceremony as its storage grant), time-boxed, pinned to `harness.read` and nothing else,
// revocable on chain. This runtime presents it per read as an `A2A-Session` assertion by that key over the exact bytes.
//
// Stored on the agent's own object here (serving plane — a wipe is a rebuild: run the ceremony again), never in a vault:
// it is THIS runtime's credential at another host, not a record of the agent's. Admitted into the store only after it
// verifies the way the host will verify it (shape, delegate = our key, delegator = the agent, ERC-1271, unrevoked), so a
// wire that could never open the door is never kept as if it could.
import type { Address, Hex } from 'viem';
import { checkSessionWireShape, type DelegationWireV1 } from '@agenticprimitives/a2a';
import { hashDelegation, type Delegation } from '@agenticprimitives/delegation';
import { HARNESS_READ_SKILL, wireReadRequest } from '@agenticprimitives/service-host';
import { internalHeaders } from './internal-marker.js';

export const SELF_HOST_WIRE_KEY = 'harness:self-host-wire';

export interface SelfHostWireChain {
  chainId: number;
  delegationManager: Address;
  validator: Address;
  enforcers: { timestamp: string; allowedMethods: string };
  readContract: (args: { address: Address; abi: readonly unknown[]; functionName: string; args: readonly unknown[] }) => Promise<unknown>;
  validatorAbi: readonly unknown[];
  isRevokedAbi: readonly unknown[];
}

export const wireToDelegation = (w: DelegationWireV1): Delegation => ({
  delegator: w.delegator, delegate: w.delegate, authority: w.authority,
  caveats: w.caveats.map((c) => ({ enforcer: c.enforcer, terms: c.terms, args: (c.args ?? '0x') as Hex })),
  salt: BigInt(w.salt), signature: w.signature,
});

export function isDelegationWire(x: unknown): x is DelegationWireV1 {
  const w = x as Partial<DelegationWireV1> | null;
  return !!w && typeof w === 'object' && /^0x[0-9a-fA-F]{40}$/.test(String(w.delegator)) && /^0x[0-9a-fA-F]{40}$/.test(String(w.delegate))
    && typeof w.authority === 'string' && Array.isArray(w.caveats) && typeof w.salt === 'string' && typeof w.signature === 'string';
}

/** Verify a read wire the way its host will: shape (bounded, pinned `harness.read` only), delegate is OUR key, delegator is
 *  the agent it is kept for, ERC-1271 against that agent (its custodian signed), unrevoked. Returns the failing leg in words. */
export async function verifySelfHostReadWire(chain: SelfHostWireChain, agent: Address, delegate: Address, wire: DelegationWireV1): Promise<string | null> {
  if (wire.delegator.toLowerCase() !== agent.toLowerCase()) return `the wire's delegator is ${wire.delegator}, not ${agent}`;
  if (wire.delegate.toLowerCase() !== delegate.toLowerCase()) return `the wire's delegate is ${wire.delegate}; this runtime's read key is ${delegate}`;
  const shape = checkSessionWireShape(wire, chain.enforcers, Math.floor(Date.now() / 1000), { skill: HARNESS_READ_SKILL });
  if (shape) return shape;
  const d = wireToDelegation(wire);
  const hash = hashDelegation(d, chain.chainId, chain.delegationManager);
  if ((await chain.readContract({ address: chain.delegationManager, abi: chain.isRevokedAbi, functionName: 'isRevoked', args: [hash] })) === true) return 'the wire is revoked on chain';
  const ok = await chain.readContract({ address: chain.validator, abi: chain.validatorAbi, functionName: 'isValidSig', args: [d.delegator, hash, d.signature] });
  return ok === true ? null : 'the wire does not verify against the agent (ERC-1271)';
}

export interface SelfHostWireEnv { A2A_TASKS: DurableObjectNamespace; [k: string]: unknown }

export async function putSelfHostWire(env: SelfHostWireEnv, agent: Address, wire: DelegationWireV1): Promise<boolean> {
  const stub = env.A2A_TASKS.get(env.A2A_TASKS.idFromName(agent.toLowerCase()));
  const res = await stub.fetch(new Request('https://a2a-task-do/internal/harness-run/self-host-wire-put', { method: 'POST', headers: internalHeaders(env as never, { 'content-type': 'application/json' }), body: JSON.stringify({ wire }) }));
  return ((await res.json().catch(() => ({}))) as { ok?: boolean }).ok === true;
}

export async function getSelfHostWire(env: SelfHostWireEnv, agent: Address): Promise<DelegationWireV1 | null> {
  const stub = env.A2A_TASKS.get(env.A2A_TASKS.idFromName(agent.toLowerCase()));
  const res = await stub.fetch(new Request('https://a2a-task-do/internal/harness-run/self-host-wire-get', { method: 'POST', headers: internalHeaders(env as never, { 'content-type': 'application/json' }), body: '{}' }));
  const out = (await res.json().catch(() => ({}))) as { ok?: boolean; wire?: unknown };
  return out.ok && isDelegationWire(out.wire) ? out.wire : null;
}

/** The read, signed: the body as the bytes the host hashes and the `A2A-Session` headers by our key over them. */
export function signedSelfHostRead(wire: DelegationWireV1, body: Record<string, unknown>, audience: string, signDigest: (digest: Hex) => Promise<Hex>): Promise<{ raw: string; headers: Record<string, string> }> {
  const { session: _session, ...rest } = body;
  return wireReadRequest({ wire, body: rest, audience, signDigest });
}
