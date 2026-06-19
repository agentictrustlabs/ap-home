// Discovery-registry reads for the Registry tab: every named agent under the home's TLD(s) + whether it
// has an AgentRegistryBase entry (spec 279). Storage-view reads only (childLabelhashes / getEntry /
// isActive) — no log scans (ADR-0012). Browser-safe (viem over the public RPC).

import { createPublicClient, http, keccak256, toBytes, encodePacked, type Abi, type Address, type Hex, type PublicClient } from 'viem';
import { CHAIN_ID, CONTRACTS, DEFAULT_RPC_URL } from './chain';
import { AGENT_NAME_PARENT } from './domain';

const RPC = (process.env.NEXT_PUBLIC_RPC_URL as string | undefined) ?? DEFAULT_RPC_URL;
/** The registry named agents are registered into (entryId convention: `urn:ap:registry-entry:<name>`). */
export const DISCOVERY_REGISTRY_ID = 'urn:ap:registry:impact-agents';

let _client: PublicClient | null = null;
const client = (): PublicClient => (_client ??= createPublicClient({ transport: http(RPC) }));

const NAME_REGISTRY_ABI = [
  { type: 'function', name: 'childLabelhashes', stateMutability: 'view', inputs: [{ name: 'p', type: 'bytes32' }], outputs: [{ type: 'bytes32[]' }] },
  { type: 'function', name: 'childNode', stateMutability: 'view', inputs: [{ name: 'p', type: 'bytes32' }, { name: 'lh', type: 'bytes32' }], outputs: [{ type: 'bytes32' }] },
] as const satisfies Abi;
const RESOLVER_ABI = [
  { type: 'function', name: 'resolveName', stateMutability: 'view', inputs: [{ name: 'node', type: 'bytes32' }], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'reverseResolveString', stateMutability: 'view', inputs: [{ name: 'agent', type: 'address' }], outputs: [{ type: 'string' }] },
] as const satisfies Abi;
const REGISTRY_ABI = [
  {
    type: 'function', name: 'getEntry', stateMutability: 'view', inputs: [{ name: 'r', type: 'bytes32' }, { name: 'e', type: 'bytes32' }],
    outputs: [{ type: 'tuple', components: [
      { name: 'subjectAgent', type: 'address' }, { name: 'cardHash', type: 'bytes32' }, { name: 'bindingProofHash', type: 'bytes32' },
      { name: 'claimsRoot', type: 'bytes32' }, { name: 'status', type: 'uint8' }, { name: 'registeredAtBucket', type: 'uint64' }, { name: 'expiresAt', type: 'uint64' },
    ] }],
  },
  { type: 'function', name: 'isActive', stateMutability: 'view', inputs: [{ name: 'r', type: 'bytes32' }, { name: 'e', type: 'bytes32' }], outputs: [{ type: 'bool' }] },
] as const satisfies Abi;

const ZERO = '0x0000000000000000000000000000000000000000';
const STATUS = ['none', 'active', 'suspended', 'revoked'] as const;
const ROOT = `0x${'00'.repeat(32)}` as Hex;
const labelhash = (l: string): Hex => keccak256(toBytes(l));
function namehash(name: string): Hex {
  let node: Hex = ROOT;
  for (const l of name.split('.').reverse()) node = keccak256(encodePacked(['bytes32', 'bytes32'], [node, labelhash(l)]));
  return node;
}
const urn = (s: string): Hex => keccak256(toBytes(s));
const toSha256 = (b: Hex): string => `sha256:${b.slice(2)}`;

export interface AgentRegistryRow {
  name: string | null;
  subjectAgent: Address;
  node: Hex;
  registered: boolean;
  status: (typeof STATUS)[number];
  live: boolean;
  cardHash?: string;
  bindingProofHash?: string;
  expiresAt?: number;
}

async function pool<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) || 1 }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]!); }
  }));
  return out;
}

async function entryFor(name: string): Promise<Pick<AgentRegistryRow, 'registered' | 'status' | 'live' | 'cardHash' | 'bindingProofHash' | 'expiresAt'>> {
  const r = urn(DISCOVERY_REGISTRY_ID);
  const e = urn(`urn:ap:registry-entry:${name}`);
  try {
    const ent = (await client().readContract({ address: CONTRACTS.agentRegistryBase, abi: REGISTRY_ABI, functionName: 'getEntry', args: [r, e] })) as {
      cardHash: Hex; bindingProofHash: Hex; status: number; expiresAt: bigint;
    };
    const live = (await client().readContract({ address: CONTRACTS.agentRegistryBase, abi: REGISTRY_ABI, functionName: 'isActive', args: [r, e] })) as boolean;
    return { registered: true, status: STATUS[ent.status] ?? 'none', live, cardHash: toSha256(ent.cardHash), bindingProofHash: toSha256(ent.bindingProofHash), expiresAt: Number(ent.expiresAt) };
  } catch {
    return { registered: false, status: 'none', live: false };
  }
}

/** Every named agent under the configured TLDs, with its registry-entry status. Recurses sub-names. */
export async function loadRegistry(tlds: string[] = [AGENT_NAME_PARENT], maxDepth = 3): Promise<AgentRegistryRow[]> {
  const acc = new Map<string, AgentRegistryRow>();
  const visit = async (parent: Hex, depth: number): Promise<void> => {
    const lhs = (await client().readContract({ address: CONTRACTS.agentNameRegistry, abi: NAME_REGISTRY_ABI, functionName: 'childLabelhashes', args: [parent] }).catch(() => [] as readonly Hex[])) as readonly Hex[];
    const nodes = await pool([...lhs], 4, (lh) => client().readContract({ address: CONTRACTS.agentNameRegistry, abi: NAME_REGISTRY_ABI, functionName: 'childNode', args: [parent, lh] }) as Promise<Hex>);
    await pool(nodes, 4, async (node) => {
      const sa = (await client().readContract({ address: CONTRACTS.agentNameUniversalResolver, abi: RESOLVER_ABI, functionName: 'resolveName', args: [node] }).catch(() => ZERO)) as Address;
      if (sa && sa !== ZERO && !acc.has(sa.toLowerCase())) {
        const name = ((await client().readContract({ address: CONTRACTS.agentNameUniversalResolver, abi: RESOLVER_ABI, functionName: 'reverseResolveString', args: [sa] }).catch(() => '')) as string) || null;
        const entry = name ? await entryFor(name) : { registered: false, status: 'none' as const, live: false };
        acc.set(sa.toLowerCase(), { name, subjectAgent: sa, node, ...entry });
      }
      if (depth < maxDepth) await visit(node, depth + 1);
    });
  };
  for (const tld of tlds) await visit(namehash(tld), 1);
  return [...acc.values()].sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
}

export const REGISTRY = { address: CONTRACTS.agentRegistryBase, chainId: CHAIN_ID, registryId: DISCOVERY_REGISTRY_ID };
