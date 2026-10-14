// The viem Chain demo-a2a signs for — derived from CHAIN_ID, never assumed.
//
// NO FALLBACK TO BASE SEPOLIA (2026-10-14, owner's instruction; ADR-0013). `CHAIN_ID ?? 84532` was written
// 53 times across this runtime and the Home, and every one of them was a wrong answer waiting for an unset
// variable. It cost a real afternoon: an operator script issued four delegation wires whose digests were
// signed over chain 84532 and Base Sepolia's DelegationManager, which looked perfect — right delegator,
// right scope, 65 bytes — and were refused at the vault door as `invalid_invocation_proof`, the catch-all
// for every failure in the authority chain. A chain id is not a preference with a sensible default: it is
// part of what a signature MEANS. Unset is an error, and `chainIdOf` says so.
//
// Every client used to be built with `chain: baseSepolia` while `transport` followed RPC_URL. Reads
// survive that (the chain object is only metadata to them), but every WRITE is signed with the chain
// object's id, so on anvil / a private chain the node rejected the raw tx with "Wrong chainId" — the
// local mode looked healthy right up to the first Smart Agent deploy.
import { defineChain, type Chain } from 'viem';
import { baseSepolia } from 'viem/chains';

const KNOWN: Record<number, Chain> = { [baseSepolia.id]: baseSepolia };

/** THE chain id this deployment is on. Required: there is no default, because a default is how a signature
 *  gets bound to a chain nobody is standing on. Every `wrangler.toml` env sets it. */
export function chainIdOf(env: { CHAIN_ID?: string | number }): number {
  // Some env shapes type it as a number (a Worker var is a string; a test fixture is not), so accept both and
  // normalise here rather than at 43 call sites.
  const raw = typeof env.CHAIN_ID === 'number' ? String(env.CHAIN_ID) : env.CHAIN_ID?.trim();
  if (!raw) throw new Error('CHAIN_ID is unset. There is no default: a chain id is part of what a signature means, and a wrong one is refused with nothing useful to say. Set it on this deployment (faithchain is 34348).');
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new Error(`CHAIN_ID is not a positive integer: ${env.CHAIN_ID}`);
  return id;
}

/** Chain for `env.CHAIN_ID`. Unknown ids get a minimal definition whose only load-bearing field is `id`;
 *  `RPC_URL` is what the transport actually uses. */
export function chainFor(env: { CHAIN_ID?: string; RPC_URL?: string }): Chain {
  const id = chainIdOf(env);
  return (
    KNOWN[id] ??
    defineChain({
      id,
      name: `chain-${id}`,
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: env.RPC_URL ? [env.RPC_URL] : [] } },
    })
  );
}
