// Discovery authority — appoint someone to issue discovery grants for your agent (spec 338 W6-c).
//
// NAMING NOTE: this is deliberately NOT called `stewardship`. `src/home/stewardship.ts` already means
// "the things a member helps oversee" (the dashboard's `Steward` model), and one word carrying two
// meanings in one directory is how vocabulary drift starts. Here the appointed party is a *discovery
// steward*, always qualified.
//
// THE PROBLEM THIS SOLVES. Until now the Home could only self-issue: to make an agent discoverable,
// whoever clicked the button had to hold that agent's key. A treasury administered by a foundation, an
// org agent run by an ops team, a service agent whose key is deliberately cold — none of those could
// be made discoverable by the party that actually operates them.
//
// WHAT THE APPOINTMENT IS. Exactly a delegation: the agent signs, once, that a named party may perform
// `agent.discovery.grant.issue` FOR IT, inside a time window. No new authority mechanism was invented
// for discovery — same EIP-712 hashing, same deployed caveat enforcers, same on-chain revocation as
// every other authority here. The resolver checks it with `delegation.authorizeMethodDelegation`.
//
// WHAT IT IS NOT. Not permission to use the agent, to spend, or to custody. It authorizes ONE method:
// minting grants that let a third party FIND the agent. Discovery is not authority (ADR-0056), so the
// appointee's power stops at "you may tell people where this agent is".
//
// WHY THE BUNDLE IS NOT A SECRET THE WAY A GRANT ID IS. It names a scoped, expiring, revocable
// authority rather than being a bearer capability. Holding it resolves nothing; only the NAMED
// appointee, proving its own key on every grant it signs, can use it. Send it over a channel you trust
// anyway — it reveals that this agent exists and who administers it.

import {
  buildMethodAuthorityCaveats,
  hashDelegation,
  ROOT_AUTHORITY,
  type Caveat,
  type Delegation,
} from '@agenticprimitives/delegation';
import { delegationAuthorityRef } from '@agenticprimitives/agent-resolution';
import type { Address, Hex } from '@agenticprimitives/types';
import { CHAIN_ID, CONTRACTS } from '../lib/chain';
import type { SignHash } from './resolution';

/**
 * The ONE method this appointment authorizes.
 *
 * The resolver reduces this exact string to a `bytes4` for ALLOWED_METHODS. A typo cannot widen
 * anything — it produces a different selector, and the resolver denies.
 */
export const DISCOVERY_ISSUE_ACTION = 'agent.discovery.grant.issue';

/** Wire form: `salt` is a bigint with no JSON representation, so it travels as a decimal string. */
export interface DelegationWire {
  delegator: Address;
  delegate: Address;
  authority: Hex;
  caveats: Caveat[];
  salt: string;
  signature: Hex;
}

/** What the owner hands the appointee, and what the appointee pastes back in. */
export interface DiscoveryAuthorityBundle {
  bundleVersion: 'ap.discovery-authority-bundle/1';
  /** The agent the appointee may issue discovery grants FOR. */
  targetAgent: Address;
  /** The party appointed. Only this address can use the bundle — its own key signs each grant. */
  steward: Address;
  action: typeof DISCOVERY_ISSUE_ACTION;
  chainId: number;
  /** `apdel1:<hashDelegation>` — what the appointee puts in each grant's signed `authorityRef`. */
  authorityRef: string;
  expiresAt: string;
  delegation: DelegationWire;
}

export interface MintDiscoveryAuthorityInput {
  /** The agent granting the authority. Its key signs; it is the delegation's delegator. */
  agentAddress: Address;
  /** The party being appointed. */
  stewardAddress: Address;
  expiresAt: Date;
  sign: SignHash;
}

function randomSalt(): bigint {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let salt = 0n;
  for (const b of bytes) salt = (salt << 8n) | BigInt(b);
  return salt;
}

/**
 * Build, sign, and package a discovery-authority appointment.
 *
 * The agent's OWN key signs the EIP-712 delegation digest through the caller's custody path. The Home
 * never signs on the user's behalf, here or anywhere else.
 */
export async function mintDiscoveryAuthority(
  input: MintDiscoveryAuthorityInput,
): Promise<DiscoveryAuthorityBundle> {
  const validUntil = Math.floor(input.expiresAt.getTime() / 1000);
  const validAfter = Math.floor(Date.now() / 1000) - 60; // small backdate absorbs clock skew
  if (!Number.isFinite(validUntil) || validUntil <= validAfter) {
    throw new Error('the expiry must be in the future');
  }
  if (input.agentAddress.toLowerCase() === input.stewardAddress.toLowerCase()) {
    // Harmless but meaningless — an agent already has full authority over itself, and issuing this
    // would only add an expiry the operator did not intend.
    throw new Error('an agent does not need an appointment to act for itself — issue directly instead');
  }

  const unsigned: Delegation = {
    delegator: input.agentAddress,
    delegate: input.stewardAddress,
    authority: ROOT_AUTHORITY,
    // `target` is the agent being acted FOR — the delegator itself. That is the opposite of the A2A
    // reading, where the allowed target is the agent you are CALLING. The resolver enforces the
    // distinction by insisting `delegator === target`.
    caveats: buildMethodAuthorityCaveats({
      target: input.agentAddress,
      method: DISCOVERY_ISSUE_ACTION,
      enforcers: {
        timestamp: CONTRACTS.timestampEnforcer,
        allowedTargets: CONTRACTS.allowedTargetsEnforcer,
        allowedMethods: CONTRACTS.allowedMethodsEnforcer,
      },
      window: { validAfter, validUntil },
    }),
    salt: randomSalt(),
    signature: '0x',
  };

  const digest = hashDelegation(unsigned, CHAIN_ID, CONTRACTS.delegationManager);
  const signature = await input.sign(digest);

  return {
    bundleVersion: 'ap.discovery-authority-bundle/1',
    targetAgent: input.agentAddress,
    steward: input.stewardAddress,
    action: DISCOVERY_ISSUE_ACTION,
    chainId: CHAIN_ID,
    authorityRef: delegationAuthorityRef(digest),
    expiresAt: input.expiresAt.toISOString(),
    delegation: { ...unsigned, salt: unsigned.salt.toString(), signature },
  };
}

export interface BundleProblem {
  field: string;
  message: string;
}

const isAddress = (x: unknown): x is Address =>
  typeof x === 'string' && /^0x[0-9a-fA-F]{40}$/.test(x);

/**
 * Validate a pasted bundle before trying to use it.
 *
 * The resolver would refuse a bad one anyway — but it refuses with `authority_invalid` and a detail
 * the operator has to interpret. Checking here means a mistyped address or a lapsed appointment says
 * so plainly, instead of looking like the protocol rejected them for no reason.
 *
 * These checks are a COURTESY, never the authority. The resolver re-derives the hash and re-verifies
 * the delegation on-chain regardless of what this concluded.
 */
export function validateDiscoveryAuthorityBundle(v: unknown, now = Date.now()): BundleProblem[] {
  const out: BundleProblem[] = [];
  const push = (field: string, message: string) => out.push({ field, message });

  if (!v || typeof v !== 'object') return [{ field: 'bundle', message: 'not an object' }];
  const b = v as Partial<DiscoveryAuthorityBundle>;

  if (b.bundleVersion !== 'ap.discovery-authority-bundle/1') {
    // Nothing below is meaningful if this is some other document.
    return [{ field: 'bundleVersion', message: 'not a discovery-authority bundle' }];
  }

  if (!isAddress(b.targetAgent)) push('targetAgent', 'not a Smart Agent address');
  if (!isAddress(b.steward)) push('steward', 'not a Smart Agent address');
  if (b.action !== DISCOVERY_ISSUE_ACTION) {
    push('action', `authorizes "${String(b.action)}", not ${DISCOVERY_ISSUE_ACTION}`);
  }
  if (b.chainId !== CHAIN_ID) {
    // An agent at the same address on another chain is a different principal.
    push('chainId', `for chain ${String(b.chainId)}, not ${CHAIN_ID}`);
  }
  if (typeof b.authorityRef !== 'string' || !b.authorityRef.startsWith('apdel1:')) {
    push('authorityRef', 'missing or not a delegation commitment');
  }

  const expiry = Date.parse(String(b.expiresAt));
  if (Number.isNaN(expiry)) push('expiresAt', 'unreadable');
  else if (expiry <= now) push('expiresAt', 'this appointment has expired');

  const d = b.delegation;
  if (!d || typeof d !== 'object') {
    push('delegation', 'missing');
    return out;
  }
  if (!isAddress(d.delegator)) push('delegation.delegator', 'not an address');
  if (!isAddress(d.delegate)) push('delegation.delegate', 'not an address');
  if (!Array.isArray(d.caveats) || d.caveats.length === 0) {
    // The resolver refuses an uncaveated delegation outright — say so before they send it.
    push('delegation.caveats', 'unscoped — the resolver refuses an unbounded authority');
  }
  if (typeof d.signature !== 'string' || d.signature.length < 4) {
    push('delegation.signature', 'unsigned');
  }

  // The bundle's labels must agree with the delegation it carries. A mismatch means it was assembled
  // by hand or edited, and the labels — which are what the operator READS — would describe an
  // authority different from the one that actually travels.
  if (isAddress(b.targetAgent) && isAddress(d.delegator) &&
      b.targetAgent.toLowerCase() !== d.delegator.toLowerCase()) {
    push('targetAgent', 'does not match the delegation’s delegator');
  }
  if (isAddress(b.steward) && isAddress(d.delegate) &&
      b.steward.toLowerCase() !== d.delegate.toLowerCase()) {
    push('steward', 'does not match the delegation’s delegate');
  }

  return out;
}

/** Parse a pasted bundle. Returns problems rather than throwing, so the UI can list them all. */
export function parseDiscoveryAuthorityBundle(
  text: string,
  now = Date.now(),
): { ok: true; bundle: DiscoveryAuthorityBundle } | { ok: false; problems: BundleProblem[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, problems: [{ field: 'bundle', message: 'not valid JSON' }] };
  }
  const problems = validateDiscoveryAuthorityBundle(parsed, now);
  return problems.length > 0
    ? { ok: false, problems }
    : { ok: true, bundle: parsed as DiscoveryAuthorityBundle };
}
