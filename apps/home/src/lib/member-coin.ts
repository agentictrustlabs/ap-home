// The two chain reads the app-coin capability needs, and nothing else.
//
// They are here rather than in the setup screen because both are QUESTIONS ABOUT A TOKEN, not about
// a member or a screen: "how much of this does that account hold" and "may anyone mint this". The
// decisions they feed are pure and live in `lib/new-member.ts`; the screen only wires them together.
//
// Both fail CLOSED. An unreadable balance is reported as `null`, which `shouldSeedCoin` treats as
// "do not seed" — an RPC that did not answer is not evidence of an empty account. An unprovable mint
// is reported as `false`, which stops the seeding attempt before it starts.
import { createPublicClient, encodeFunctionData, http } from 'viem';
import type { Address } from '@agenticprimitives/types';
import { CHAIN } from './chain';

const ERC20_BALANCE_ABI = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;

/** The faucet shape: a permissionless `mint(to, amount)`. The same signature `treasury.fund` calls
 *  and the same one the portal's Fund button has always minted demo USDC with. */
const MINT_ABI = [
  { type: 'function', name: 'mint', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [] },
] as const;

/** The browser's RPC. `/a2a/rpc` is this app's own same-origin proxy — the route `home/ask.ts` and
 *  the connect client already read the chain through, so this adds no new network surface. */
const rpc = () => createPublicClient({ chain: CHAIN, transport: http('/a2a/rpc') });

/**
 * How much of `asset` the account holds, or `null` when the chain did not answer.
 *
 * `null` and `0n` are deliberately different values: one is "it has none", which is a fact worth
 * acting on, and the other is "we do not know", which is not.
 */
export async function coinBalanceOf(asset: Address, account: Address): Promise<bigint | null> {
  try {
    return await rpc().readContract({ address: asset, abi: ERC20_BALANCE_ABI, functionName: 'balanceOf', args: [account] });
  } catch (e) {
    console.warn('[member-coin] balance unreadable — treating as unknown (no seeding):', e);
    return null;
  }
}

/**
 * IS THIS TOKEN ACTUALLY PLAY MONEY? — proved on chain, not taken on trust.
 *
 * The registry entry declaring `faucet: true` is an app saying out loud that its coin is a demo
 * token. This is the Home checking. It SIMULATES the mint (`eth_call`, nothing is broadcast, no gas,
 * no signature) and only reports true if it would succeed.
 *
 * WHY THIS GATE IS NON-NEGOTIABLE. The Home can put coin in a member's account only by minting it,
 * and that is possible at all only for a token anyone may mint — which is only ever true of a test
 * token. A real asset has no open `mint`, or has one behind a minter role, and the call reverts. So
 * a misconfigured entry pointing at a real ERC-20 cannot cause the Home to try to conjure it: it is
 * refused here, loudly, before any signature is asked of the member.
 *
 * SIMULATED FROM `caller`, which is the member's own account rather than the agent that will
 * actually broadcast (that is the harness's service SA, whose address the browser does not hold).
 * That is the right sample anyway: the property being tested is "an arbitrary address may mint this",
 * and the member is an arbitrary address.
 */
export async function isOpenMintToken(asset: Address, caller: Address, to: Address, amount: bigint): Promise<boolean> {
  try {
    await rpc().call({
      account: caller,
      to: asset,
      data: encodeFunctionData({ abi: MINT_ABI, functionName: 'mint', args: [to, amount] }),
    });
    return true;
  } catch (e) {
    // LOUD on purpose. This is the branch a real asset lands in, and it is the difference between
    // "the demo did not seed" and "the Home tried to mint something it must never mint".
    console.error(
      `[member-coin] REFUSING to seed ${asset}: it is not open-mint (the simulated mint reverted). ` +
      'Only a faucet test token may be seeded by the Home — check `new_member.currency.asset`.',
      e,
    );
    return false;
  }
}
