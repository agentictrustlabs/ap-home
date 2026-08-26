// Tier-3 reader (docs/architecture/agent-metadata-tiers.md): the SA-keyed ERC-4337 account
// metadata on AgentProfileResolver. READ-ONLY by design — this tier is public, system-managed
// (authOrigin at onboarding, declared capabilities by the spec-282 ceremony), and the home deliberately ships no
// editor for it. One mechanism: direct readContract of the `atl:` predicates (ADR-0012-safe views).
import { createPublicClient, http, keccak256, toBytes } from 'viem';
import { agentProfileResolverAbi } from '@agenticprimitives/agent-profile';
import type { Address } from '@agenticprimitives/types';
import { CONTRACTS, DEFAULT_RPC_URL, CHAIN } from './chain';

export const SA_PROFILE_KEYS = [
  { key: 'displayName', label: 'Display name' },
  { key: 'description', label: 'Description' },
  // `skills` → `atl:skills` — the DECLARED CAPABILITY projection (capability-architecture.md §1); the key
  // name is legacy and immutable (it derives the on-chain predicate id), the label is canonical.
  { key: 'skills', label: 'Declared capabilities' },
  { key: 'authOrigin', label: 'Auth origin' },
] as const;

export type SaProfileMeta = Partial<Record<(typeof SA_PROFILE_KEYS)[number]['key'], string>>;

export async function readSaProfileMeta(sa: Address): Promise<SaProfileMeta> {
  const pc = createPublicClient({ chain: CHAIN, transport: http(DEFAULT_RPC_URL) });
  const out: SaProfileMeta = {};
  for (const { key } of SA_PROFILE_KEYS) {
    const v = (await pc
      .readContract({
        address: CONTRACTS.agentProfileResolver,
        abi: agentProfileResolverAbi,
        functionName: 'getStringProperty',
        args: [sa, keccak256(toBytes(`atl:${key}`))],
      })
      .catch(() => '')) as string;
    if (v) out[key] = v;
  }
  return out;
}
