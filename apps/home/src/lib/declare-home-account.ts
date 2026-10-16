// Declare which account a name is a name OF (ap-federation spec 440 §C3 / Ring 0 spec 346 §3.8).
//
// A person is a DIFFERENT Smart Agent on each chain, so a name that carries only `addr` says which account it
// points at HERE and nothing about which account is the agent's home. Since 2026-10-15 every claim is born with
// `atl:nativeId` (the home account, CAIP-10) and `atl:accounts` (one entry per chain) in its own userOp. Names
// claimed before that were born with `addr` alone, and the town's naming service says so on their page:
// "Which account is the agent's home is not declared". It refuses to infer it, rightly — on a second chain the
// account the name points at is a satellite, and a reader who guessed would be wrong.
//
// This module is the backfill: for every name an agent HOLDS on this chain, decide what is missing, and write
// it in ONE batched gasless userOp by the agent itself (`msg.sender == owner(node)`) — the same two calls the
// claim path builds (`connect-client.ts` `nameRecordCalls`), run against existing nodes. The decision is pure
// and tested; the write is the one seam every name-record edit already uses.
//
// What it never does: overwrite a declared home (a name whose `nativeId` names another chain is a satellite,
// not undeclared — leave it), or replace this chain's entry in `accounts` with a different address (that is a
// conflict to show, not a thing to fix silently — ADR-0013).
import { buildRecordCalls, namehash, type AgentNameRecords } from '@agenticprimitives/agent-naming';
import type { ContractCall } from '@agenticprimitives/agent-account';
import type { Address } from '@agenticprimitives/types';
import { CHAIN_ID, CONTRACTS } from './chain';
import { executeCalls, type SignHash } from '../connect-client';
import { requestReindex } from './reindex';

export const caip10Of = (chainId: number, address: string): string => `eip155:${chainId}:${address.toLowerCase()}`;

/** One held name, with the records it carries today. */
export interface HeldNameRecords {
  name: string;
  records: Pick<AgentNameRecords, 'nativeId' | 'accounts'>;
}

export type HomeAccountPlan =
  /** Nothing to write: both records already name this account (or the home is declared elsewhere — a satellite). */
  | { name: string; action: 'none'; reason: 'declared' | 'satellite' }
  /** Write what is missing. `records` is exactly what goes on chain for this node. */
  | { name: string; action: 'write'; records: Pick<AgentNameRecords, 'nativeId' | 'accounts'>; missing: Array<'nativeId' | 'accounts'> }
  /** This chain's `accounts` entry names a DIFFERENT address than the agent holding the name. Shown, never overwritten. */
  | { name: string; action: 'conflict'; reason: string };

const chainOf = (caip10: string): string => caip10.split(':').slice(0, 2).join(':');

/**
 * Decide, for one name, what declaring `sa` as its home account on `chainId` requires.
 *
 * - `nativeId` absent → write it as this account.
 * - `nativeId` present and on another chain → SATELLITE: this chain's account is not the home; leave both records.
 * - `nativeId` present, this chain, this account → declared.
 * - `accounts` lacks this chain → append this account (other chains' entries are kept verbatim).
 * - `accounts` has this chain but a different address → conflict.
 */
export function planHomeAccount(held: HeldNameRecords, sa: Address, chainId: number = CHAIN_ID): HomeAccountPlan {
  const me = caip10Of(chainId, sa);
  const here = `eip155:${chainId}`;
  const nativeId = held.records.nativeId?.toLowerCase() ?? null;
  const accounts = (held.records.accounts ?? []).map((a) => a.toLowerCase());

  if (nativeId && chainOf(nativeId) !== here) return { name: held.name, action: 'none', reason: 'satellite' };
  if (nativeId && nativeId !== me) {
    return { name: held.name, action: 'conflict', reason: `atl:nativeId already names ${nativeId} on this chain, not the agent holding the name` };
  }
  const mineHere = accounts.find((a) => chainOf(a) === here);
  if (mineHere && mineHere !== me) {
    return { name: held.name, action: 'conflict', reason: `atl:accounts already lists ${mineHere} for this chain, not the agent holding the name` };
  }

  const missing: Array<'nativeId' | 'accounts'> = [];
  const records: Pick<AgentNameRecords, 'nativeId' | 'accounts'> = {};
  if (!nativeId) { missing.push('nativeId'); records.nativeId = me; }
  if (!mineHere) { missing.push('accounts'); records.accounts = [...accounts.filter((a) => chainOf(a) !== here), me]; }
  if (!missing.length) return { name: held.name, action: 'none', reason: 'declared' };
  return { name: held.name, action: 'write', records, missing };
}

/** The calls for every name that needs writing — one batch, one userOp, signed by the agent that holds them. */
export function buildDeclareHomeCalls(plans: readonly HomeAccountPlan[]): ContractCall[] {
  return plans.flatMap((p) => (p.action === 'write'
    ? buildRecordCalls({ resolver: CONTRACTS.agentNameResolver, node: namehash(p.name), records: p.records })
    : []));
}

/** Declare `sa` as the home account on every held name that lacks it. One prompt, one userOp, then a re-index. */
export async function declareHomeAccount(
  sa: Address,
  plans: readonly HomeAccountPlan[],
  signHash: SignHash,
): Promise<{ ok: true; txHash?: `0x${string}`; written: string[] } | { ok: false; error: string }> {
  const written = plans.filter((p) => p.action === 'write').map((p) => p.name);
  const calls = buildDeclareHomeCalls(plans);
  if (!calls.length) return { ok: true, written };
  const res = await executeCalls(sa, signHash, calls);
  if (!res.ok) return res;
  requestReindex([sa]);
  return { ...res, written };
}
