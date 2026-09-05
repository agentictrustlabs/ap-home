// THE AGENTS SOMEONE HOLDS, read from chain — spec 355 W2.
//
// `ap:charteredUnder` is recorded on the AgentRelationship contract as an edge whose type is the keccak
// of the ontology IRI, so the bytes32 on chain names a term with a definition rather than a short string
// whose meaning lives in whoever wrote it.
//
// PUBLIC BY CONSTRUCTION, and that is the point: the same link in a person's vault is readable only by
// them (ADR-0025), which is why "send alice 20 USDC" could not be routed for anyone but Alice. An edge
// both parties signed is exactly the chain-reproducible fact ADR-0040 admits.
//
// IT GRANTS NOTHING. The edge says a treasury belongs to a person. What lets anyone spend from it is a
// mandate, judged by the verifier, every time.
import type { Address, Hex } from 'viem';

const ZERO32 = `0x${'0'.repeat(64)}` as Hex;
/** ACTIVE — both sides said so and neither has revoked. PROPOSED and CONFIRMED are not yet an answer. */
const ACTIVE = 3;

const EDGES_BY_OBJECT_ABI = [{ type: 'function', name: 'getEdgesByObject', stateMutability: 'view', inputs: [{ name: 'object_', type: 'address' }], outputs: [{ type: 'bytes32[]' }] }] as const;
const GET_EDGE_ABI = [{ type: 'function', name: 'getEdge', stateMutability: 'view', inputs: [{ name: 'edgeId', type: 'bytes32' }], outputs: [
  { type: 'tuple', components: [
    { name: 'edgeId', type: 'bytes32' }, { name: 'subject', type: 'address' }, { name: 'object_', type: 'address' },
    { name: 'relationshipType', type: 'bytes32' }, { name: 'status', type: 'uint8' }, { name: 'createdBy', type: 'address' },
    { name: 'createdAt', type: 'uint64' }, { name: 'updatedAt', type: 'uint64' },
    { name: 'metadataURI', type: 'string' }, { name: 'metadataHash', type: 'bytes32' },
  ] },
] }] as const;

export interface CharteredDeps {
  readContract: (args: never) => Promise<unknown>;
  relationships?: Address;
  relationshipType: Hex;
  /** address → its name, to label a candidate. A nameless agent is still a real answer. */
  reverseName?: (agent: string) => Promise<string | null>;
  /** Bound: an agent with hundreds of children answers with the first page, never a stalled request. */
  maxEdges?: number;
}

/**
 * Every agent chartered under `owner` whose typed name ends in `.<type>`.
 *
 * The TYPE filter is on the name suffix rather than the on-chain agentType record: one read instead of
 * one per edge, and the suffix is a claim the registry already refuses to mint against a mismatched type
 * (ADR-0061). An agent with no name is skipped — it cannot be shown to a person as a choice.
 */
export function charteredAgentsReader(deps: CharteredDeps) {
  return async (owner: string, type: string): Promise<Array<{ agent: string; name?: string }>> => {
    if (!deps.relationships) return [];
    const ids = (await deps.readContract({
      address: deps.relationships, abi: EDGES_BY_OBJECT_ABI, functionName: 'getEdgesByObject', args: [owner],
    } as never).catch(() => [])) as Hex[];
    const out: Array<{ agent: string; name?: string }> = [];
    for (const id of (ids ?? []).slice(0, deps.maxEdges ?? 40)) {
      if (!id || id === ZERO32) continue;
      const e = (await deps.readContract({ address: deps.relationships, abi: GET_EDGE_ABI, functionName: 'getEdge', args: [id] } as never).catch(() => null)) as
        { subject?: string; relationshipType?: string; status?: number } | null;
      if (!e?.subject) continue;
      if ((e.relationshipType ?? '').toLowerCase() !== deps.relationshipType.toLowerCase()) continue;
      if (Number(e.status) !== ACTIVE) continue;
      const name = deps.reverseName ? await deps.reverseName(e.subject).catch(() => null) : null;
      if (!name || name.toLowerCase().split('.').pop() !== type) continue;
      out.push({ agent: e.subject.toLowerCase(), name });
    }
    return out;
  };
}
