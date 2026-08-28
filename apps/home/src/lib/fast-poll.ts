// Local-chain-aware poll cadence. The onboarding/org-create paths poll RPC state (deploy visible,
// bytecode present) between ceremony steps; the 1–2.5s cadences are tuned for public RPCs and
// Alchemy quotas, but on a local chain (anvil/faithchain, ~1s blocks, localhost RPC) they quantize
// every wait to whole seconds. Local chains poll at 300ms; production keeps the caller's cadence.
import { CHAIN_ID } from './chain';

const LOCAL = CHAIN_ID === 31337 || CHAIN_ID === 1337;

/** The caller's production cadence, floored to 300ms on a local chain. */
export function fastPollMs(productionMs: number): number {
  return LOCAL ? Math.min(productionMs, 300) : productionMs;
}
