// THE ASK — one conversation with the agent whose realm you are standing in (spec 350 §3.5 / §3.6).
//
// The Ask does what the buttons do. Where a settings ceremony collects its inputs in a form and then acts,
// the Ask acts and asks for what it turns out to need — a name, the credential that will custody what it
// makes, a signature, or the AUTHORITY nobody has granted yet. Four replies, and the panel renders each:
//
//   answer              — it only had to read
//   authority_required  — the plan reached a step nobody authorized. The agent says exactly what would
//                         have to be signed; the person signs a MANDATE (one capability, one parent, THIS
//                         ask, one hour) with the credential that custodies the parent, and we come back.
//   prompt              — the tool needs something. `credential` fields are answered HERE, from the
//                         connected session — the person is never asked which key they are holding.
//   done                — it happened; the receipts say under what authority.
//
// WHO IS ASKED vs WHOSE AUTHORITY. The addressee is the realm you are standing in (the workspace switcher's
// active agent). The authority is whatever the step names — the parent whose namespace the action enters:
// a team's workspace, an organization's person. They are usually the same agent and never assumed to be.
// The mandate is signed by the credential that custodies the DELEGATOR, which for everything a person
// steward does is their own credential (an SA validates its custodians' signatures, ERC-1271).
import {
  buildDigestBindingCaveat, capabilityHandler, hashDelegation, paymentHandler, ROOT_AUTHORITY,
  type Caveat, type Delegation, type MandateRequirementV1,
} from '@agenticprimitives/delegation';
import type { Address, Hex } from '@agenticprimitives/types';
import { CHAIN_ID, CONTRACTS } from '../lib/chain';
import { toWire, type DelegationWire } from '../lib/delegation';
import { ensureCsrfToken, csrfHeaders } from '../csrf';
import type { SignHash } from './resolution';

/** A field the agent wants filled. `credential` is filled by this surface, never shown to the person. */
export interface AskField {
  name: string;
  label: string;
  type: 'text' | 'address' | 'number' | 'boolean' | 'choice' | 'credential';
  required?: boolean;
  choices?: Array<{ value: string; label: string }>;
  pattern?: string;
  hint?: string;
}

export type AskPrompt =
  | { kind: 'data'; stepRef: string; toolId: string; prompt: string; fields: AskField[] }
  | { kind: 'signature'; stepRef: string; toolId: string; prompt: string; digest: Hex; signer: string; payload?: unknown }
  | { kind: 'confirmation'; stepRef: string; toolId: string; prompt: string; summary: unknown };

export type AskReply =
  | { kind: 'answer'; text: string; runRef: string }
  | { kind: 'authority_required'; runRef: string; requirement: MandateRequirementV1; delegate: Address; delegator: Address; capability: string; stepRef: string; summary: string }
  | { kind: 'prompt'; runRef: string; resumeToken: string; prompt: AskPrompt }
  | { kind: 'done'; runRef: string; result: unknown; receipts: unknown[] }
  | { kind: 'refused'; runRef: string; outcome: string; error: string; receipts: unknown[] };

/** Answers carried into the next turn of the SAME ask. */
export interface SuppliedInput {
  stepRef: string;
  data?: Record<string, unknown>;
  signature?: { digest: string; signer: string; signature: string; payload?: unknown };
  confirmed?: boolean;
}

/** The state one ask carries between turns: the sentence, the run, the mandate, and the answers so far.
 *  Every turn re-sends all of it — the agent re-plans and re-verifies from scratch each time, which is
 *  the point: a resume is never a continuation past a gate. */
export interface AskTurnState {
  message: string;
  addressee: Address;
  runRef: string;
  presented: DelegationWire | null;
  supplied: SuppliedInput[];
}

async function post(body: unknown): Promise<{ ok: boolean; reply?: AskReply; error?: string; detail?: string }> {
  await ensureCsrfToken();
  const r = await fetch('/a2a/harness/ask', {
    method: 'POST', credentials: 'include',
    headers: { 'content-type': 'application/json', ...csrfHeaders() },
    body: JSON.stringify(body),
  });
  return (await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }))) as never;
}

/** Ask once. The first turn carries only the sentence; later turns carry what the agent asked for. */
export async function ask(session: { token: string }, state: AskTurnState): Promise<AskReply> {
  const res = await post({
    session: session.token, addressee: state.addressee, message: state.message, runRef: state.runRef,
    presented: state.presented, supplied: state.supplied,
  });
  if (!res.ok || !res.reply) {
    return { kind: 'refused', runRef: state.runRef, outcome: 'failed', error: res.detail ?? res.error ?? 'the agent could not be reached', receipts: [] };
  }
  return res.reply;
}

const PAYMENT_TYPE = 'urn:ap:rar:treasury.payment.execute';

/**
 * Mint the mandate the agent said it would need, and sign it as the DELEGATOR.
 *
 * The caveats are built HERE from the requirement — not accepted from the server — so what the person's
 * credential signs is what this surface computed from what it showed them. The enforcers are the deployed
 * ones this build targets; a deployment with no `DigestBindingEnforcer` cannot bind a mandate to one ask,
 * and we refuse rather than mint a broader authority than the person was shown (ADR-0013: no fallback).
 */
export async function mintMandate(
  reply: Extract<AskReply, { kind: 'authority_required' }>,
  signHash: SignHash,
): Promise<DelegationWire> {
  const enforcers = {
    delegationManager: CONTRACTS.delegationManager,
    timestamp: CONTRACTS.timestampEnforcer,
    allowedTargets: CONTRACTS.allowedTargetsEnforcer,
    allowedMethods: CONTRACTS.allowedMethodsEnforcer,
    value: CONTRACTS.valueEnforcer,
    payment: CONTRACTS.paymentEnforcer,
    digestBinding: CONTRACTS.digestBindingEnforcer,
  };
  if (/^0x0{40}$/i.test(enforcers.digestBinding)) {
    throw new Error('This deployment cannot grant a mandate: the enforcer that binds authority to one request is not deployed here.');
  }
  const handler = reply.requirement.type === PAYMENT_TYPE ? paymentHandler : capabilityHandler;
  const caveats: Caveat[] = [
    ...handler.toCaveats(reply.requirement, enforcers as never),
    buildDigestBindingCaveat(enforcers.digestBinding, 'intent', reply.requirement.intentDigest as Hex),
  ];
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let salt = 0n;
  for (const b of bytes) salt = (salt << 8n) | BigInt(b);
  const mandate: Delegation = {
    delegator: reply.delegator, delegate: reply.delegate,
    authority: ROOT_AUTHORITY, caveats, salt, signature: '0x',
  };
  mandate.signature = await signHash(hashDelegation(mandate, CHAIN_ID, CONTRACTS.delegationManager));
  return toWire(mandate);
}

/** What the person is told they are granting. Deliberately plain: a capability, a parent, this request,
 *  and how long — the four things that make a mandate narrower than a login. */
export function describeRequirement(reply: Extract<AskReply, { kind: 'authority_required' }>): {
  capability: string; delegator: Address; expiresInMinutes: number;
} {
  const now = Math.floor(Date.now() / 1000);
  return {
    capability: reply.capability,
    delegator: reply.delegator,
    expiresInMinutes: Math.max(1, Math.round(((reply.requirement.validUntil ?? now) - now) / 60)),
  };
}

/** Human words for the capabilities an Ask can need. Unknown ids fall back to the id itself — an
 *  unfamiliar capability must still be readable, never silently blank. */
export const CAPABILITY_WORDS: Record<string, string> = {
  'organization.team.create': 'create teams',
  'organization.create': 'create organizations',
  'organization.membership.invite': 'invite members',
  'treasury.payment.execute': 'make payments',
};
