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

const CHECKS: Record<string, (i: PreconditionInput) => Promise<string | null>> = {
  'treasury.payment.execute': paymentPrecondition,
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
