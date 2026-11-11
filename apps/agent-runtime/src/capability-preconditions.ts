// WHAT MUST BE TRUE BEFORE WE ASK A PERSON TO AUTHORIZE SOMETHING — spec 352 §2 (the preview stage).
//
// "send 2 usdc from nathan to alice" was answered with an authority request, a signature ceremony, and
// then a failure — because Nathan's account held nothing. Every step was correct and the person was
// walked through a ceremony whose outcome was knowable before it began. That is the same wrong we fixed
// for custody ("you cannot grant this"), one layer along: do not ask someone to authorize what cannot work.
//
// A precondition is NOT authority and must never be mistaken for it:
//   • it can only REFUSE EARLY. Passing means "nothing known makes this impossible", never "this is
//     allowed" — the mandate and the chain decide that, and the chain re-checks at redemption anyway
//     (351 §2.4.7: never re-implement an on-chain property as the only enforcement).
//   • it is read-only and cheap. A balance read, a code check — nothing that mutates, nothing slow.
//   • its answer is a SENTENCE for a person, naming the actual numbers. "Insufficient funds" is a
//     category; "nathan holds 0.00 USDC and this needs 2.00" is an answer.
//
// State moves between the check and the act, so this is a courtesy, not a guarantee: the invoker checks
// again, and the chain is the one that finally refuses.
import { erc20Abi, formatUnits, type Address } from 'viem';
import { fundingAmount, type HarnessDeps, type HarnessEnv } from './harness-run.js';
import { libraryGrantPlan, libraryGrantTargetRefusal, rawCatalogOf, LIBRARY_GRANT_ISSUE, LIBRARY_GRANT_REVOKE, type LibraryEntry } from './library-tools.js';

export interface PreconditionInput {
  capability: string;
  args: Record<string, unknown>;
  env: HarnessEnv;
  deps: HarnessDeps;
  /** The agent being asked — used to suggest an account of theirs that could cover it. */
  addressee?: Address;
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** Spec 410 §7 — `TreasurySpendPolicy.remaining(account)`: what the current window can still carry, and the ceiling. */
export const REMAINING_ABI = [
  { type: 'function', name: 'remaining', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: 'left', type: 'uint256' }, { name: 'ceiling', type: 'uint256' }] },
] as const;

async function usdcBalance(deps: HarnessDeps, token: Address, who: Address): Promise<bigint | null> {
  return (await deps.readContract({ address: token, abi: erc20Abi as never, functionName: 'balanceOf', args: [who] }).catch(() => null)) as bigint | null;
}

/**
 * A payment needs the payer to actually hold the money. When they do not, say so with the numbers — and,
 * when the payer is a person whose own treasury COULD cover it, say that too: the useful answer to "you
 * cannot do this" is usually "…but this account can".
 */
async function paymentPrecondition(input: PreconditionInput): Promise<string | null> {
  const counterparty = await payeePrecondition(input);
  if (counterparty) return counterparty;
  const token = String(input.args.asset ?? input.env.MOCK_USDC ?? '').toLowerCase() as Address;
  const payer = String(input.args.payer ?? input.addressee ?? '').toLowerCase() as Address;
  // The SAME parser the capability uses, or the check is answering a different question than the act:
  // "send 2 usdc" leaves `amount` unset (it is `usdc`), and reading only `amount` made this pass silently.
  const amount = (() => { try { return fundingAmount(input.args); } catch { return 0n; } })();
  if (!/^0x[0-9a-f]{40}$/.test(token) || !/^0x[0-9a-f]{40}$/.test(payer) || amount <= 0n) return null;

  // Spec 410 §7 — THE AGGREGATE LIMIT AT THE RESOURCE, read before anyone signs: a treasury under a spend policy
  // has a ceiling per window, and `remaining()` says how much of it is left. A payment the window cannot carry
  // is refused here with the numbers, instead of after a signature at `BudgetExceeded`. Honesty, never authority:
  // the hook decides at commit whatever this said. Absent policy (`installed` false ⇒ remaining is the max) or an
  // estate without the contract ⇒ nothing to say.
  const policy = String(input.env.TREASURY_SPEND_POLICY ?? '').toLowerCase();
  if (/^0x[0-9a-f]{40}$/.test(policy)) {
    const rem = (await input.deps.readContract({ address: policy as Address, abi: REMAINING_ABI as never, functionName: 'remaining', args: [payer] }).catch(() => null)) as { left: bigint; ceiling: bigint } | readonly [bigint, bigint] | null;
    const left = rem === null ? null : Array.isArray(rem) ? rem[0] : (rem as { left: bigint }).left;
    const ceiling = rem === null ? null : Array.isArray(rem) ? rem[1] : (rem as { ceiling: bigint }).ceiling;
    if (left !== null && ceiling !== null && ceiling > 0n && left < amount) {
      return `${short(payer)} may spend ${formatUnits(left, 6)} more USDC in this window (its ceiling is ${formatUnits(ceiling, 6)}) and this needs ${formatUnits(amount, 6)}. Nothing was authorized; the window's limit is the treasury's own policy.`;
    }
  }

  const held = await usdcBalance(input.deps, token, payer);
  if (held === null || held >= amount) return null; // unreadable ⇒ do not block; the chain still decides

  const need = formatUnits(amount, 6);
  const has = formatUnits(held, 6);
  let hint = '';
  // The payer's own treasury is a public, on-chain fact (its name resolves); suggesting it is not a
  // search of anybody's private context.
  const treasuryName = typeof input.args.payerName === 'string' ? String(input.args.payerName) : '';
  if (deps_hasResolver(input.deps) && treasuryName) {
    const treasury = await input.deps.resolveName!(`${treasuryName}.treasury`).catch(() => null);
    if (treasury) {
      const t = await usdcBalance(input.deps, token, treasury.toLowerCase() as Address);
      if (t !== null && t >= amount) hint = ` ${treasuryName}.treasury holds ${formatUnits(t, 6)} — ask again naming it as the payer.`;
    }
  }
  return `${short(payer)} holds ${has} USDC and this needs ${need}. Nothing was authorized.${hint}`;
}

const deps_hasResolver = (d: HarnessDeps): boolean => typeof d.resolveName === 'function';

/** Is there an account at this address ON THIS CHAIN? `true` (code answered, even with a revert), `false` (no code —
 *  the call returned no data), `null` (could not tell: the endpoint failed). A Smart Agent answers `entryPoint()`. */
const ENTRY_POINT_ABI = [{ type: 'function', name: 'entryPoint', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] }] as const;
async function accountHere(deps: HarnessDeps, who: Address): Promise<boolean | null> {
  try { await deps.readContract({ address: who, abi: ENTRY_POINT_ABI as never, functionName: 'entryPoint', args: [] }); return true; } catch (e) {
    for (let c: unknown = e, i = 0; c && i < 6; c = (c as { cause?: unknown }).cause, i++) {
      const name = String((c as { name?: string }).name ?? '');
      if (name === 'ContractFunctionZeroDataError' || /returned no data \("0x"\)/.test(String((c as { message?: string }).message ?? ''))) return false;
      if (name === 'ContractFunctionRevertedError') return true;
    }
    return null;
  }
}

/**
 * THE COUNTERPARTY, before a signature (spec 373's value rail, read early). Money moves between treasuries ON ONE CHAIN:
 * the invoker refuses any other payee at execute time (`refuseUnlessTreasury`), but only after the person was walked
 * through a mandate signature for a payment that could never land. The case that made this visible (ap-federation
 * gate:pay-outward, 2026-11-11): maya on hopechain asked to pay a faithnet treasury that lives on faithchain — an
 * address that is NOBODY's on hopechain — and the run parked for authority. The question is asked of THIS chain only,
 * so an address that happens to be an account on another chain (CREATE addresses coincide across chains) is judged by
 * what it is HERE. Unreadable ⇒ say nothing; the invoker and the chain still decide.
 */
async function payeePrecondition(input: PreconditionInput): Promise<string | null> {
  const { deps, env } = input;
  if (!deps.agentTypeOf) return null;
  const raw = String(input.args.payee ?? '').trim();
  const payee = (/^0[xX][0-9a-fA-F]{40}$/.test(raw) ? raw
    : raw.includes('.') && deps.resolveName ? ((await deps.resolveName(raw.toLowerCase()).catch(() => null)) ?? '') : '').toLowerCase() as Address;
  if (!/^0x[0-9a-f]{40}$/.test(payee)) return null; // nothing to judge yet — the invoker names what is missing
  const type = (await deps.agentTypeOf(payee).catch(() => null))?.toLowerCase() ?? null;
  if (type === 'treasury') return null;
  const chain = `eip155:${env.CHAIN_ID}`;
  const label = (await deps.nameOf?.(payee).catch(() => null)) ?? payee;
  if (type === 'person') return `${label} is a person on ${chain}, and money moves between treasuries — a person is who a payment is FOR, an account is where it GOES. Name their treasury. Nothing was authorized.`;
  if (type) return `${label} is ${type === 'org' ? 'an organization' : `a ${type}`} on ${chain}, and money moves between treasuries — name the treasury it charters. Nothing was authorized.`;
  const here = await accountHere(deps, payee);
  if (here === false) return `${payee} is not an account on ${chain}, where this payment would be made — value does not cross chains, so nothing can be paid to it from here (a treasury on another chain is paid from a treasury on that chain). Nothing was authorized.`;
  if (here === true) return `${label} has no agent type recorded on ${chain}, so it cannot be shown to be a treasury — money only moves between treasuries. Nothing was authorized.`;
  return null;
}

/**
 * Slice S4 — a Library read grant that cannot be issued (no such document or folder, a delegate that is not an agent or is
 * the owner, a window out of range) is refused BEFORE the owner is asked to sign a mandate for it. The addressee is the
 * owner; the owner is the one asking (or her steward), so naming what is missing is fine. The invoker checks again.
 */
async function libraryGrantIssuePrecondition(input: PreconditionInput): Promise<string | null> {
  const owner = String(input.addressee ?? '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(owner)) return null;
  const plan = libraryGrantPlan(owner, input.args);
  if ('refused' in plan) return `No grant was issued: ${plan.refused}. Nothing was authorized.`;
  if (!input.deps.readSubjectRecord) return null;
  const list = await rawCatalogOf({ readSubjectRecord: input.deps.readSubjectRecord }, owner);
  const missing = libraryGrantTargetRefusal(list, plan);
  return missing ? `No grant was issued: ${missing}. Nothing was authorized.` : null;
}

/** Slice S4 — a revoke names a grant this Library recorded; one it never issued is said before any signature. */
async function libraryGrantRevokePrecondition(input: PreconditionInput): Promise<string | null> {
  const owner = String(input.addressee ?? '').toLowerCase();
  const hash = String(input.args.delegationHash ?? '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(owner)) return null;
  if (!/^0x[0-9a-f]{64}$/.test(hash)) return `Nothing was revoked: a grant is named by its digest (0x and 64 hex, from library.grants.list). Nothing was authorized.`;
  if (!input.deps.readSubjectRecord) return null;
  const list: LibraryEntry[] = await rawCatalogOf({ readSubjectRecord: input.deps.readSubjectRecord }, owner);
  const known = list.some((e) => (e.grants ?? []).some((g) => String((g as { delegationHash?: unknown }).delegationHash ?? '').toLowerCase() === hash));
  return known ? null : `Nothing was revoked: no grant ${hash.slice(0, 14)}… was issued from this Library. Nothing was authorized.`;
}

const CHECKS: Record<string, (i: PreconditionInput) => Promise<string | null>> = {
  'treasury.payment.execute': paymentPrecondition,
  [LIBRARY_GRANT_ISSUE]: libraryGrantIssuePrecondition,
  [LIBRARY_GRANT_REVOKE]: libraryGrantRevokePrecondition,
};

/** The reason this cannot work, or null when nothing known makes it impossible. */
export async function preconditionRefusal(input: PreconditionInput): Promise<string | null> {
  const check = CHECKS[input.capability];
  if (!check) return null;
  try {
    return await check(input);
  } catch {
    // A precondition that cannot be evaluated must not become a refusal: it exists to spare a person a
    // pointless ceremony, not to add a new way to fail.
    return null;
  }
}
