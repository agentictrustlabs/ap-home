// Every person has a treasury with 1,000 SHQ (ap-town spec 431 D2). Created with the person's Home — through the
// same ceremony every treasury is born by (`createAgentWithBirthrights`) — and funded from the coin's open mint, by
// the person's own agent, so no faucet key exists anywhere. Idempotent: an existing treasury is found, and a balance
// at or above the birthright is left alone. A person's agent never holds coin (assets live only in treasuries).
import { createPublicClient, encodeFunctionData, http, type Address } from 'viem';
import { createAgentWithBirthrights } from '../components/portal/ManagedAgents';
import { executeCalls, listManagedAgents, type SignHash } from '../connect-client';
import { CHAIN, DEFAULT_RPC_URL } from '../lib/chain';
import { NAMING_COIN, TREASURY_BIRTHRIGHT_COINS } from '../lib/naming-price';

const COIN_ABI = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'mint', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [] },
] as const;

export async function treasuryBalance(treasury: Address): Promise<bigint> {
  if (!NAMING_COIN) return 0n;
  const pc = createPublicClient({ chain: CHAIN, transport: http(DEFAULT_RPC_URL) });
  return (await pc.readContract({ address: NAMING_COIN.address, abi: COIN_ABI, functionName: 'balanceOf', args: [treasury] })) as bigint;
}

export const coins = (units: bigint): number => Number(units / 10n ** BigInt(NAMING_COIN?.decimals ?? 6));

/** The person's treasury, found or made; then its birthright, minted if short. Each step says what it did. */
export async function ensurePersonTreasury(
  input: { person: Address; via: string; token: string; signPerson: SignHash },
  onStep?: (s: string) => void,
): Promise<{ ok: true; treasury: Address; created: boolean; balance: bigint; minted: boolean } | { ok: false; error: string }> {
  const { person, via, token, signPerson } = input;
  let treasury: Address | null = null;
  let created = false;
  const mine = (await listManagedAgents(token).catch(() => [])).filter((a) => a.kind === 'person-treasury' && (a.relationship ?? 'steward') === 'steward');
  if (mine[0]) treasury = mine[0].agent;
  else {
    onStep?.('Making your treasury…');
    const made = await createAgentWithBirthrights({ kind: 'person-treasury', parent: person, person, via }, token, (s) => onStep?.(s));
    if (!made.ok) return { ok: false, error: `treasury: ${made.error}` };
    treasury = made.result.agent;
    created = true;
  }
  if (!NAMING_COIN) return { ok: true, treasury, created, balance: 0n, minted: false };
  let balance = await treasuryBalance(treasury);
  const want = BigInt(TREASURY_BIRTHRIGHT_COINS) * 10n ** BigInt(NAMING_COIN.decimals);
  let minted = false;
  if (balance < want) {
    onStep?.(`Minting ${TREASURY_BIRTHRIGHT_COINS - coins(balance)} SHQ into your treasury…`);
    const mint = encodeFunctionData({ abi: COIN_ABI, functionName: 'mint', args: [treasury, want - balance] });
    const res = await executeCalls(person, signPerson, [{ to: NAMING_COIN.address, value: 0n, data: mint }]);
    if (!res.ok) return { ok: false, error: `mint: ${res.error}` };
    minted = true;
    balance = want;
  }
  return { ok: true, treasury, created, balance, minted };
}
