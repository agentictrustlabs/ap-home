// DURABLE RUNS — spec 350 W3. A run that stopped to ask a person outlives the tab it was asked in.
//
// Through W2 the run lived in the browser: the surface held the intent, the mandate wire and every answer,
// and re-sent all of it each turn. That works and it is honest — a resume is a full re-run through every
// gate — but it makes a suspended run a property of one open page. Close it and the authority you granted
// is gone with the run that asked for it; nobody else can see that a payment is waiting on a signature;
// and the mandate sits in browser memory between turns for no reason.
//
// So the checkpoint lives in the ASKED AGENT'S OWN DurableObject, keyed by runRef.
//
// WHY DO-LOCAL IS RIGHT HERE (ADR-0055's test: if this DO were wiped, is the loss a rebuild or a
// bereavement?). A suspended run is a REBUILD: you ask again and grant again. Nothing here is the record
// of anything — the receipts are the evidence and go to the audit sink, the mandate is re-mintable by the
// person who minted it, and the agent an ask creates is on chain the moment it exists. A checkpoint is
// the serving plane's memory of an unfinished conversation, which is exactly what DO storage is for.
//
// WHAT A RESUME IS NOT. It is not a continuation past a gate. The stored intent is re-planned, the stored
// mandate is re-verified (on chain: signature, revocation, intent binding, limits), the ladder is
// re-applied and the approval re-checked — every turn, exactly as the first. The checkpoint holds only
// what the person already gave us; it grants nothing and it decides nothing.
import type { SuppliedInputV1 } from '@agenticprimitives/orchestration';
import type { Address } from 'viem';
import type { DelegationWireV1 } from '@agenticprimitives/a2a';
import { internalHeaders } from './internal-marker.js';

/** One unfinished ask. Small on purpose: what the person said, what they granted, what they answered. */
export interface HarnessRunCheckpointV1 {
  runRef: string;
  /** The sentence. An ask is ONE thing — a different sentence is a different ask and a different intent
   *  digest, so it may not inherit this run's mandate. */
  message: string;
  /** The realm the ask was addressed to. */
  addressee: Address;
  /** WHO asked. Only they may resume: a run carries their session's authority and their answers. */
  asker: Address;
  /** The mandate they granted, if they have. Re-verified on every turn — never trusted because it is here. */
  presented?: DelegationWireV1 | null;
  /** Everything answered so far, by stepRef. */
  supplied: SuppliedInputV1[];
  /** What the run is waiting for, for a surface that lists pending work. */
  awaiting?: { kind: 'data' | 'signature' | 'confirmation'; prompt: string; stepRef: string };
  /** Set when the run is a WORK ITEM nobody has picked up: `asker` is the principal rather than a person,
   *  and any steward who can mint the mandate may claim it (`endeavor-authority-steps.claimableBy`). */
  openToStewards?: boolean;
  /** The plan step this run exists to satisfy. When it completes, the step's evidence is its RECEIPT. */
  origin?: { endeavorId: string; stepId: string; principal: Address };
  createdAt: number;
  updatedAt: number;
}

export interface RunStoreEnv {
  A2A_TASKS: DurableObjectNamespace;
  [k: string]: unknown;
}

const stubFor = (env: RunStoreEnv, agent: Address) => env.A2A_TASKS.get(env.A2A_TASKS.idFromName(agent.toLowerCase()));

async function call(env: RunStoreEnv, agent: Address, op: 'save' | 'load' | 'drop', body: unknown): Promise<Record<string, unknown>> {
  const res = await stubFor(env, agent).fetch(new Request(`https://a2a-task-do/internal/harness-run/${op}`, {
    method: 'POST', headers: internalHeaders(env as never), body: JSON.stringify(body),
  }));
  const out = (await res.json().catch(() => ({}))) as Record<string, unknown> & { ok?: boolean; error?: string };
  if (!res.ok || out.ok === false) throw new Error(String(out.error ?? `harness-run/${op} failed (${res.status})`));
  return out;
}

export async function saveRun(env: RunStoreEnv, checkpoint: HarnessRunCheckpointV1): Promise<void> {
  await call(env, checkpoint.addressee, 'save', { checkpoint });
}

export async function loadRun(env: RunStoreEnv, addressee: Address, runRef: string): Promise<HarnessRunCheckpointV1 | null> {
  const out = await call(env, addressee, 'load', { runRef });
  return (out.checkpoint as HarnessRunCheckpointV1 | undefined) ?? null;
}

/** A run that reached a terminal outcome leaves nothing behind: done is done, and a denial is terminal
 *  (ADR-0013) — keeping it invites a caller to "try the resume again" as though refusal were weather. */
export async function dropRun(env: RunStoreEnv, addressee: Address, runRef: string): Promise<void> {
  await call(env, addressee, 'drop', { runRef });
}

/** Merge a turn's inputs over the checkpoint. The stored answers come FIRST so a resend of the same
 *  stepRef adds rather than replaces — a person who signs twice has signed twice, and the port picks the
 *  signature that verifies. */
export function mergeTurn(
  stored: HarnessRunCheckpointV1 | null,
  turn: { message?: string; presented?: DelegationWireV1 | null; supplied?: SuppliedInputV1[] },
): { message: string; presented: DelegationWireV1 | null; supplied: SuppliedInputV1[] } | { error: string } {
  const message = (turn.message ?? stored?.message ?? '').trim();
  if (!message) return { error: 'this run has no question and none was given' };
  if (stored && turn.message && turn.message.trim() !== stored.message) {
    // The mandate is bound to the intent digest, so a changed sentence would be denied a step later with
    // `intent-mismatch`. Saying it here names the actual mistake instead of a hash comparison.
    return { error: 'this run was started for a different question — ask it as a new one rather than changing this one mid-way' };
  }
  return {
    message,
    presented: turn.presented ?? stored?.presented ?? null,
    supplied: [...(stored?.supplied ?? []), ...(turn.supplied ?? [])],
  };
}
