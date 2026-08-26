// The viem Chain demo-a2a signs for — derived from CHAIN_ID, never assumed.
//
// Every client used to be built with `chain: baseSepolia` while `transport` followed RPC_URL. Reads
// survive that (the chain object is only metadata to them), but every WRITE is signed with the chain
// object's id, so on anvil / a private chain the node rejected the raw tx with "Wrong chainId" — the
// local mode looked healthy right up to the first Smart Agent deploy.
import { defineChain, type Chain } from 'viem';
import { baseSepolia } from 'viem/chains';

const KNOWN: Record<number, Chain> = { [baseSepolia.id]: baseSepolia };

/** Chain for `env.CHAIN_ID` (default Base Sepolia). Unknown ids get a minimal definition whose only
 *  load-bearing field is `id`; `RPC_URL` is what the transport actually uses. */
export function chainFor(env: { CHAIN_ID?: string; RPC_URL?: string }): Chain {
  const id = Number(env.CHAIN_ID ?? baseSepolia.id);
  if (!Number.isInteger(id) || id <= 0) throw new Error(`CHAIN_ID is not a positive integer: ${env.CHAIN_ID}`);
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
