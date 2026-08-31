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
  // One round trip per property, awaited in a loop, cost ~150ms EACH — six properties meant the better
  // part of a second of pure waiting on a page that already loads cards and name records. The reads are
  // independent, so they go together; a property that fails still reads as unset, exactly as before.
  const values = await Promise.all(
    SA_PROFILE_KEYS.map(({ key }) =>
      pc
        .readContract({
          address: CONTRACTS.agentProfileResolver,
          abi: agentProfileResolverAbi,
          functionName: 'getStringProperty',
          args: [sa, keccak256(toBytes(`atl:${key}`))],
        })
        .catch(() => '') as Promise<string>,
    ),
  );
  const out: SaProfileMeta = {};
  SA_PROFILE_KEYS.forEach(({ key }, i) => {
    if (values[i]) out[key] = values[i];
  });
  return out;
}
