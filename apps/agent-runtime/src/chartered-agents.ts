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
const EDGES_BY_SUBJECT_ABI = [{ type: 'function', name: 'getEdgesBySubject', stateMutability: 'view', inputs: [{ name: 'subject', type: 'address' }], outputs: [{ type: 'bytes32[]' }] }] as const;
const HAS_ROLE_ABI = [{ type: 'function', name: 'hasRole', stateMutability: 'view', inputs: [{ name: 'edgeId', type: 'bytes32' }, { name: 'role', type: 'bytes32' }], outputs: [{ type: 'bool' }] }] as const;
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
  /** The modelled ROLES to read per edge, as `{ iri: bytes32 }` — `ap:primaryPayee` (which account
   *  receives) and `ap:primaryPayer` (which one spends) are the two today, and they are deliberately
   *  different questions. Read only when there is a CHOICE to disambiguate, which is the only time the
   *  answer changes anything. Absent ⇒ nothing is marked and the person is asked, which always worked. */
  roles?: Readonly<Record<string, Hex>>;
}

/**
 * Every agent chartered under `owner` whose typed name ends in `.<type>`.
 *
 * The TYPE filter is on the name suffix rather than the on-chain agentType record: one read instead of
 * one per edge, and the suffix is a claim the registry already refuses to mint against a mismatched type
 * (ADR-0061). An agent with no name is skipped — it cannot be shown to a person as a choice.
 */
export function charteredAgentsReader(deps: CharteredDeps) {
  return async (owner: string, type: string): Promise<Array<{ agent: string; name?: string; primary?: boolean }>> => {
    if (!deps.relationships) return [];
    const ids = (await deps.readContract({
      address: deps.relationships, abi: EDGES_BY_OBJECT_ABI, functionName: 'getEdgesByObject', args: [owner],
    } as never).catch(() => [])) as Hex[];
    // EVERY EDGE IS CHAIN READS, and this runs inside one request that also verifies mandates and
    // resolves grants. Reading the edge, reverse-resolving its name and asking for a role — three reads
    // apiece over forty edges — spent the request's whole budget and left the person watching "Working…"
    // forever. So: a tighter cap, and the role is asked ONLY when there is a choice to disambiguate,
    // which is the only time the answer changes anything.
    const matched: Array<{ id: Hex; agent: string; name: string }> = [];
    for (const id of (ids ?? []).slice(0, deps.maxEdges ?? 12)) {
      if (!id || id === ZERO32) continue;
      const e = (await deps.readContract({ address: deps.relationships, abi: GET_EDGE_ABI, functionName: 'getEdge', args: [id] } as never).catch(() => null)) as
        { subject?: string; relationshipType?: string; status?: number } | null;
      if (!e?.subject) continue;
      if ((e.relationshipType ?? '').toLowerCase() !== deps.relationshipType.toLowerCase()) continue;
      if (Number(e.status) !== ACTIVE) continue;
      const name = deps.reverseName ? await deps.reverseName(e.subject).catch(() => null) : null;
      if (!name || name.toLowerCase().split('.').pop() !== type) continue;
      matched.push({ id, agent: e.subject.toLowerCase(), name });
    }
    const roleEntries = Object.entries(deps.roles ?? {});
    if (matched.length < 2 || !roleEntries.length) return matched.map(({ agent, name }) => ({ agent, name }));

    // WHICH ONES THEY MARKED — asked only now, when there is more than one and the answer decides
    // whether a person is questioned about their own (or somebody else's) accounts.
    const out: Array<{ agent: string; name?: string; primary?: boolean; roles?: string[] }> = [];
    for (const m of matched) {
      const carried: string[] = [];
      for (const [iri, role] of roleEntries) {
        const has = (await deps.readContract({ address: deps.relationships, abi: HAS_ROLE_ABI, functionName: 'hasRole', args: [m.id, role] } as never).catch(() => false)) === true;
        if (has) carried.push(iri);
      }
      out.push({
        agent: m.agent, name: m.name,
        ...(carried.length ? { roles: carried } : {}),
        // `primary` stays for the payee short-circuit that predates the roles list — same fact, older name.
        ...(carried.some((i) => i.endsWith('#primaryPayee')) ? { primary: true } : {}),
      });
    }
    return out;
  };
}

/**
 * The OWNER an agent is chartered under — the inverse read (`getEdgesBySubject`), for delivering a
 * consequence to the person behind a treasury. A treasury's inbox is not a place anyone looks; the
 * `ap:charteredUnder` edge both parties signed says whose it is, and that edge is the ONLY basis —
 * never a name resemblance (spec 355). Returns null when no ACTIVE edge exists: an unchartered agent
 * has no owner to tell, and null is the answer, not a trigger for a weaker lookup (ADR-0013).
 */
export function charteredOwnerReader(deps: CharteredDeps) {
  return async (agent: string): Promise<string | null> => {
    if (!deps.relationships) return null;
    const ids = (await deps.readContract({
      address: deps.relationships, abi: EDGES_BY_SUBJECT_ABI, functionName: 'getEdgesBySubject', args: [agent],
    } as never).catch(() => [])) as Hex[];
    for (const id of ids.slice(0, deps.maxEdges ?? 12)) {
      if (id === ZERO32) continue;
      const edge = (await deps.readContract({
        address: deps.relationships, abi: GET_EDGE_ABI, functionName: 'getEdge', args: [id],
      } as never).catch(() => null)) as { object_?: string; relationshipType?: string; status?: number } | null;
      if (edge && edge.status === ACTIVE && String(edge.relationshipType).toLowerCase() === deps.relationshipType.toLowerCase()) {
        return String(edge.object_).toLowerCase();
      }
    }
    return null;
  };
}
