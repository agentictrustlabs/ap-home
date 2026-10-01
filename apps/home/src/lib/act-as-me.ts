// ACT-AS-ME (spec 397 §11) — THE SECOND TEMPLATE a Home MCP client may hold, beside ask-as-me, and what it adds: a
// SET of standing wires, ONE PER ACT CAPABILITY the person checked from her compiled playbook, each from her (or,
// for a payment, from her treasury — assets live only in treasuries) to the client's ACT key, caveated to that one
// capability selector and a 30-day window; a payment wire carries its payee, asset and cap. No intent binding: a
// standing wire is a capability, not a mandate (`verifyMandateForStep` refuses it alone), and nothing acts on it
// directly — the Worker DERIVES a mandate bound to a parked run's intent from it, and her agent verifies that
// chain as it verifies a mandate she signed here.
//
// ONE CEREMONY SIGNS THE SET: a demo persona or a KMS custodian signs each digest (prompt-free); a passkey approves
// every digest of ONE delegator in one batch (`approveGrantHashes`) and the wires carry the approved-hash sentinel
// — a person and her treasury are two delegators, so a payment wire is a second prompt, never a hidden one.
// Browser- and server-safe: no fetch here; the signer is injected.
import { buildStandingWire, signedStandingWire, type StandingWireV1 } from '@agenticprimitives/delegation';
import type { AgentHarnessDefinitionV1 } from '@agenticprimitives/capability-claims';
import type { Address, Hex } from '@agenticprimitives/types';
import { CHAIN_ID, CONTRACTS } from './chain';
import { APPROVED_HASH_SENTINEL } from './delegation';

export const ACT_TEMPLATE = 'act-as-me' as const;
export const ACT_VALIDITY_SECONDS = 60 * 60 * 24 * 30;
export const PAYMENT_CAPABILITY = 'treasury.payment.execute' as const;

/** One checked line of the consent: a capability, and for a payment its bounds. */
export interface ActChoice {
  capability: string;
  /** Required for `treasury.payment.execute`: HER treasury (the delegator), one payee, one asset, the cap in atomic units. */
  payment?: { treasury: Address; payee: Address; asset: Address; maxAmount: bigint };
}

/** The act capabilities a playbook offers: every tool with a capability that is not a read and not an instruction. */
export function actCapabilitiesOf(definition: Pick<AgentHarnessDefinitionV1, 'tools'> | null | undefined): Array<{ id: string; description: string; risk: string }> {
  const out = new Map<string, { id: string; description: string; risk: string }>();
  for (const t of definition?.tools ?? []) {
    if (!t.capability?.id || !t.risk || t.risk === 'informational' || t.execution === 'instruction') continue;
    if (!out.has(t.capability.id)) out.set(t.capability.id, { id: t.capability.id, description: t.description, risk: t.risk });
  }
  return [...out.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function enforcers() {
  return {
    delegationManager: CONTRACTS.delegationManager, timestamp: CONTRACTS.timestampEnforcer,
    allowedTargets: CONTRACTS.allowedTargetsEnforcer, allowedMethods: CONTRACTS.allowedMethodsEnforcer,
    value: CONTRACTS.valueEnforcer, payment: CONTRACTS.paymentEnforcer, digestBinding: CONTRACTS.digestBindingEnforcer,
  };
}

/** The UNSIGNED set: one standing wire per choice, grouped by the delegator that must sign. */
export function buildActAsMeSet(person: Address, actDelegate: Address, choices: readonly ActChoice[]): { standing: StandingWireV1[]; byDelegator: Map<string, Hex[]> } {
  if (choices.length === 0) throw new Error('check at least one act');
  if (/^0x0{40}$/i.test(CONTRACTS.digestBindingEnforcer)) throw new Error('This deployment cannot grant an act wire: the enforcer that binds authority to one request is not deployed here.');
  const seen = new Set<string>();
  const standing: StandingWireV1[] = [];
  const byDelegator = new Map<string, Hex[]>();
  for (const c of choices) {
    if (seen.has(c.capability)) throw new Error(`${c.capability} is listed twice — one wire per capability`);
    seen.add(c.capability);
    const isPayment = c.capability === PAYMENT_CAPABILITY;
    if (isPayment && !c.payment) throw new Error('a payment wire needs your treasury, the payee, the asset and a cap');
    const delegator = isPayment ? c.payment!.treasury : person;
    const { standing: s } = buildStandingWire({
      template: ACT_TEMPLATE, delegator, delegate: actDelegate, capability: c.capability,
      ...(isPayment ? { payment: { payee: c.payment!.payee, asset: c.payment!.asset, maxAmount: c.payment!.maxAmount } } : {}),
      validForSeconds: ACT_VALIDITY_SECONDS, enforcers: enforcers() as never, chainId: CHAIN_ID, delegationManager: CONTRACTS.delegationManager,
    });
    standing.push(s);
    const k = delegator.toLowerCase();
    byDelegator.set(k, [...(byDelegator.get(k) ?? []), s.ref]);
  }
  return { standing, byDelegator };
}

export type ActSetSigner =
  /** Prompt-free custodians (a demo persona, a KMS key): sign every digest, one by one, for its delegator. */
  | { mode: 'each'; sign: (delegator: Address, digest: Hex) => Promise<Hex> }
  /** A passkey: ONE batch per delegator approves its digests on chain; the wires carry the sentinel. */
  | { mode: 'batch'; approve: (delegator: Address, digests: Hex[]) => Promise<void> };

/** Sign the set the way the custodian can; the wires come back ready for the Home's `/oidc/grant`. */
export async function signActAsMeSet(set: ReturnType<typeof buildActAsMeSet>, signer: ActSetSigner): Promise<StandingWireV1[]> {
  if (signer.mode === 'each') {
    const out: StandingWireV1[] = [];
    for (const s of set.standing) out.push(signedStandingWire(s, await signer.sign(String(s.wire.delegator) as Address, s.ref)));
    return out;
  }
  for (const [delegator, digests] of set.byDelegator) await signer.approve(delegator as Address, digests);
  return set.standing.map((s) => signedStandingWire(s, APPROVED_HASH_SENTINEL));
}

/** Plain words for a wire's bounds, for the consent and the Connected pane. */
export function actWireWords(s: { capability: string; requirement: { limits?: Record<string, unknown> } }, decimals = 6, symbol = 'USDC'): string {
  const lim = s.requirement.limits as { payee?: string; maxAmount?: string } | undefined;
  if (s.capability === PAYMENT_CAPABILITY && lim?.maxAmount) {
    const n = Number(BigInt(lim.maxAmount)) / 10 ** decimals;
    return `pay ${lim.payee ? `${lim.payee.slice(0, 6)}…${lim.payee.slice(-4)}` : 'the named payee'} up to ${n} ${symbol} per payment`;
  }
  return s.capability;
}
