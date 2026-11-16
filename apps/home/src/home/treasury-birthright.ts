// Every person has a treasury with 1,000 SHQ (ap-town spec 431 D2). Created with the person's Home — through the
// same ceremony every treasury is born by (`createAgentWithBirthrights`) — and funded from the coin's open mint, by
// the person's own agent, so no faucet key exists anywhere. Idempotent: an existing treasury is found, and a balance
// at or above the birthright is left alone. A person's agent never holds coin (assets live only in treasuries).
import { createPublicClient, encodeFunctionData, http, type Address } from 'viem';
import { createAgentWithBirthrights } from '../components/portal/ManagedAgents';
import { executeCalls, listManagedAgentsStrict, type SignHash } from '../connect-client';
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
async function ensurePersonTreasuryOnce(
  input: { person: Address; via: string; token: string; signPerson: SignHash },
  onStep?: (s: string) => void,
): Promise<{ ok: true; treasury: Address; created: boolean; balance: bigint; minted: boolean } | { ok: false; error: string }> {
  const { person, via, token, signPerson } = input;
  let treasury: Address | null = null;
  let created = false;
  const mine = (await listManagedAgentsStrict(token)).filter((a) => a.kind === 'person-treasury' && (a.relationship ?? 'steward') === 'steward');
  if (mine[0]) treasury = mine[0].agent;
  else {
    const marker = `ap-treasury-creation:${person.toLowerCase()}`;
    if (typeof localStorage !== 'undefined') {
      if (localStorage.getItem(marker)) return { ok: false, error: 'A treasury creation was started but its vault link is unconfirmed. Repair it at Home before retrying; no second treasury was created.' };
      localStorage.setItem(marker, 'creation-started');
    }
    onStep?.('Making your treasury…');
    const made = await createAgentWithBirthrights({ kind: 'person-treasury', parent: person, person, via }, token, (s) => onStep?.(s));
    if (!made.ok) return { ok: false, error: `treasury: ${made.error}` };
    treasury = made.result.agent;
    created = true;
    if (typeof localStorage !== 'undefined') localStorage.removeItem(marker);
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

// The session effect and a relying-app ceremony can arrive together. Share that operation; browser
// Web Locks serialize tabs. The memo is a setup receipt only, never a source for balances or authority.
const treasuryInFlight = new Map<string, ReturnType<typeof ensurePersonTreasuryOnce>>();
export function ensurePersonTreasury(input: Parameters<typeof ensurePersonTreasuryOnce>[0], onStep?: (s: string) => void): ReturnType<typeof ensurePersonTreasuryOnce> {
  const key = input.person.toLowerCase();
  const running = treasuryInFlight.get(key);
  if (running) return running;
  const run = async () => {
    const memo = `ap-treasury-birthright:${key}`;
    if (typeof localStorage !== 'undefined' && localStorage.getItem(memo) === '1') {
      const existing = (await listManagedAgentsStrict(input.token)).find(a => a.kind === 'person-treasury' && a.relationship === 'steward');
      if (!existing) return { ok: false as const, error: 'Treasury receipt exists but its vault link is unavailable. Repair it at Home; a second treasury was not created.' };
      return { ok: true as const, treasury: existing.agent, created: false, balance: await treasuryBalance(existing.agent), minted: false };
    }
    const result = await ensurePersonTreasuryOnce(input, onStep);
    if (result.ok && typeof localStorage !== 'undefined') localStorage.setItem(memo, '1');
    return result;
  };
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  const promise = (locks ? locks.request(`ap-treasury-birthright:${key}`, run) : run()).finally(() => treasuryInFlight.delete(key));
  treasuryInFlight.set(key, promise);
  return promise;
}
