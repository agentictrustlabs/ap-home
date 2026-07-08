// Naming-record property management (spec 314 W3). The naming records are
// ontology-registered attributes (SHACL-shaped on-chain: the resolver validates
// every write against the OntologyTermRegistry). This module is the app seam:
//   read  — AgentNamingClient.getRecords (universal-resolver reads, one mechanism)
//   write — encodeRecords (TS mirror of the on-chain shape, fail-loud pre-sign)
//           → buildRecordCalls → ONE batched gasless userOp by the name's own SA
//           (`msg.sender == owner(node)`), then the discovery re-index trigger.
import {
  AgentNamingClient,
  buildRecordCalls,
  encodeRecords,
  namehash,
  type AgentNameRecords,
} from '@agenticprimitives/agent-naming';
import type { Address } from '@agenticprimitives/types';
import { CHAIN_ID, CONTRACTS, DEFAULT_RPC_URL } from './chain';
import { executeCalls, type SignHash } from '../connect-client';
import { requestReindex } from './reindex';

/** The steward-editable predicates. System predicates (addr, agentKind, custodyPolicy,
 *  passkeyCredentialDigest, connection records) keep their dedicated ceremonies. */
export const EDITABLE_PROPS = [
  { key: 'displayName', label: 'Display name', hint: 'Human-readable name shown in search and profiles' },
  { key: 'a2aEndpoint', label: 'A2A endpoint', hint: 'HTTPS URL other agents use to reach this agent' },
  { key: 'mcpEndpoint', label: 'MCP endpoint', hint: 'HTTPS URL for this agent\u2019s MCP tools' },
  { key: 'metadataUri', label: 'Metadata URI', hint: 'Link to an extended agent card / metadata document' },
  { key: 'nativeId', label: 'Native id (CAIP-10)', hint: 'e.g. eip155:84532:0x\u2026 \u2014 validated against the CAIP-10 grammar' },
] as const satisfies ReadonlyArray<{ key: keyof AgentNameRecords; label: string; hint: string }>;

export type EditablePropKey = (typeof EDITABLE_PROPS)[number]['key'];

function namingClient(): AgentNamingClient {
  return new AgentNamingClient({
    rpcUrl: DEFAULT_RPC_URL,
    chainId: CHAIN_ID,
    registry: CONTRACTS.agentNameRegistry,
    universalResolver: CONTRACTS.agentNameUniversalResolver,
  });
}

export async function readNameRecords(name: string): Promise<AgentNameRecords> {
  return namingClient().getRecords(name);
}

/** Write ONLY the changed string properties, SHACL-validated twice (TS mirror here,
 *  OntologyTermRegistry on-chain), as one batched sponsored userOp. */
export async function writeNameProperties(
  sa: Address,
  name: string,
  changes: Partial<Record<EditablePropKey, string>>,
  signHash: SignHash,
): Promise<{ ok: true; txHash?: `0x${string}` } | { ok: false; error: string }> {
  const records: AgentNameRecords = {};
  for (const { key } of EDITABLE_PROPS) {
    const v = changes[key];
    if (v !== undefined) records[key] = v.trim() as never;
  }
  if (Object.keys(records).length === 0) return { ok: true };
  try {
    encodeRecords(records); // fail-loud validation (CAIP-10 grammar etc.) BEFORE any prompt
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  const calls = buildRecordCalls({ resolver: CONTRACTS.agentNameResolver, node: namehash(name), records });
  const res = await executeCalls(sa, signHash, calls);
  if (res.ok) requestReindex([sa]); // knowledge base reflects the edit in seconds; cron watcher is backstop
  return res;
}
