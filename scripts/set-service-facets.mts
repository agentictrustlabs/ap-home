/**
 * Spec 386 A — THE FIXTURE AGENT'S PUBLIC FACETS, written by its custodian through the Home: the SA-keyed
 * profile strings (atl:capabilities, atl:focusAreas, atl:languages, atl:description), the name records
 * (a2aEndpoint, siteUrl, description, displayName), and the registry entry (RB-01: the subject registers
 * itself) — ONE sponsored userOp from the service's own Smart Agent, signed by the persona that custodies it.
 *
 *   npx tsx scripts/set-service-facets.mts            (reads demo/ligonier.faithnet.json)
 *
 * Every write is public-by-choice (the name-record tier and the SA profile tier of the three-tier model);
 * nothing here grants anything. Then the indexer is asked to project the agents.
 */
import { buildRecordCalls, namehash } from '@agenticprimitives/agent-naming';
import { AgentNamingClient } from '@agenticprimitives/agent-naming';
import { buildExecuteBatchCallData } from '@agenticprimitives/agent-account';
import { agentProfileResolverAbi, buildRegisterProfileCall, hashAgentCard } from '@agenticprimitives/agent-profile';
import { buildRegisterEntryCall, hashBindingProofBody, type RegistryId, type RegistryEntryId } from '@agenticprimitives/registry-kit';
import { urnToBytes32 } from '@agenticprimitives/registry-kit';
import { CONTRACTS } from '@agenticprimitives/contracts/deployments/faithchain';
import { createPublicClient, http, keccak256, toBytes, parseAbi, type Address, type Hex } from 'viem';
import { readFileSync, writeFileSync } from 'node:fs';

const HOME = 'https://www.faithnet.me';
const RPC = 'https://a2a.faithnet.io/rpc';
const CHAIN_ID = 34348;
const INDEXER = 'https://demo-discovery-indexer-faithnet.richardpedersen3.workers.dev';
const REGISTRY_URN = 'urn:ap:registry:faithnet-agents' as RegistryId;
const NOTE = 'demo/ligonier.faithnet.json';
const note = JSON.parse(readFileSync(NOTE, 'utf8')) as { org: { name: string; sa: Address }; service: { name: string; sa: Address } };
const SA = note.service.sa.toLowerCase() as Address;
const NAME = note.service.name;
const HOST = `${NAME.replace(/\.(svc)$/, '-$1')}.faithnet.ai`; // ligonier.svc → ligonier-svc.faithnet.ai (spec 346 §5; the canonical zone's wildcard route)

const FACETS = {
  displayName: 'Ligonier Ministries',
  description: 'Reformed teaching from Ligonier Ministries: series, messages, articles and study plans on justification, sanctification and the doctrines of grace, with discipleship curricula and Reformation Study Bible tools.',
  capabilities: 'gc:CFnDiscipleshipCurricula',
  focusAreas: 'justification,reformed theology,discipleship curricula,bible study',
  languages: 'en',
  a2aEndpoint: `https://${HOST}`, // the *.faithnet.ai wildcard serves every typed host; no custom domain needed
  siteUrl: 'https://www.ligonier.org',
  // Spec 387 W2 — the content catalog beside the agent (AP content-catalog profile v1); the harness binds its
  // catalog.* reads to THIS record, never to a hostname convention.
  mcpEndpoint: 'https://gc-ligonier-catalog.r-pedersen.workers.dev/mcp',
};

const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 250), _status: r.status }; } };
const pred = (name: string): Hex => keccak256(toBytes(name));
const pc = createPublicClient({ transport: http(RPC) });
const profile = CONTRACTS.agentProfileResolver as Address;
// A predicate the estate's ontology registry has not activated reverts the whole batch (PredicateNotActive);
// on faithnet atl:focusAreas / atl:languages / atl:regions / atl:siteUrl wait on the governor
// (`packages/contracts/script/AddDiscoveryFacetPredicates.s.sol`). Written when active, named when not.
const ontology = (await pc.readContract({ address: profile, abi: parseAbi(['function ONTOLOGY() view returns (address)']), functionName: 'ONTOLOGY' })) as Address;
const active = async (name: string) => (await pc.readContract({ address: ontology, abi: parseAbi(['function isActive(bytes32) view returns (bool)']), functionName: 'isActive', args: [pred(name)] })) as boolean;
const skipped: string[] = [];

// ── what is already there ──
const registered = (await pc.readContract({ address: profile, abi: agentProfileResolverAbi, functionName: 'isRegistered', args: [SA] })) as boolean;
const current = async (name: string) => String(await pc.readContract({ address: profile, abi: agentProfileResolverAbi, functionName: 'getStringProperty', args: [SA, pred(name)] }).catch(() => ''));
const calls = [] as Array<{ to: Address; value: bigint; data: Hex }>;
if (!registered) calls.push(buildRegisterProfileCall({ profileResolver: profile, agent: SA, displayName: FACETS.displayName, description: FACETS.description }));
// atl:displayName on the PROFILE (SA-keyed) is what the KB projects as approf:displayName — the ARD entry's
// displayName; the name record's displayName is the name's, a different fact (G8).
for (const [name, value] of [['atl:displayName', FACETS.displayName], ['atl:capabilities', FACETS.capabilities], ['atl:focusAreas', FACETS.focusAreas], ['atl:languages', FACETS.languages], ['atl:description', FACETS.description]] as const) {
  if (!(await active(name))) { skipped.push(name); continue; }
  if ((await current(name)) === value) { console.log(`  · ${name} already set`); continue; }
  const { encodeFunctionData } = await import('viem');
  calls.push({ to: profile, value: 0n, data: encodeFunctionData({ abi: agentProfileResolverAbi, functionName: 'setStringProperty', args: [SA, pred(name), value] }) });
}
const naming = new AgentNamingClient({ rpcUrl: RPC, chainId: CHAIN_ID, registry: CONTRACTS.agentNameRegistry as Address, universalResolver: CONTRACTS.agentNameUniversalResolver as Address });
const before = await naming.getRecords(NAME);
const records: Record<string, string> = {};
if (before.a2aEndpoint !== FACETS.a2aEndpoint) records.a2aEndpoint = FACETS.a2aEndpoint;
if (before.mcpEndpoint !== FACETS.mcpEndpoint) records.mcpEndpoint = FACETS.mcpEndpoint;
if (before.siteUrl !== FACETS.siteUrl) { if (await active('atl:siteUrl')) records.siteUrl = FACETS.siteUrl; else skipped.push('atl:siteUrl (name record)'); }
if (before.description !== FACETS.description) records.description = FACETS.description;
if (before.displayName !== FACETS.displayName) records.displayName = FACETS.displayName;
if (Object.keys(records).length) calls.push(...buildRecordCalls({ resolver: CONTRACTS.agentNameResolver as Address, node: namehash(NAME), records }).map((c) => ({ to: c.to, value: c.value, data: c.data })));
else console.log('  · name records already set');
// the registry entry — the subject registers itself (RB-01); an existing entry is left alone
const registry = CONTRACTS.agentRegistryBase as Address;
const entryId = `urn:ap:registry-entry:${NAME}` as RegistryEntryId;
const issuedAt = new Date().toISOString();
const cardHash = hashAgentCard({ type: 'service', displayName: FACETS.displayName } as never);
const bindingProofHash = await hashBindingProofBody({ registryId: REGISTRY_URN, entryId, subjectAgent: SA, cardHash, claimHashes: [], issuedAt, chainId: CHAIN_ID, registryAddress: registry } as never);
// Idempotent: an entry already active in the registry is left alone (a second registerEntry reverts EntryExists).
const alreadyRegistered = (await pc.readContract({ address: registry, abi: parseAbi(['function isActive(bytes32,bytes32) view returns (bool)']), functionName: 'isActive', args: [urnToBytes32(REGISTRY_URN), urnToBytes32(entryId)] }).catch(() => false)) as boolean;
if (alreadyRegistered) console.log(`  · registry entry ${entryId} already active`);
const REGISTERED = !alreadyRegistered && (process.env.SKIP_REGISTRY ?? '') !== '1';
if (REGISTERED) calls.push((({ to, value, data }) => ({ to, value, data }))(buildRegisterEntryCall({ registry, registryId: REGISTRY_URN, entryId, subjectAgent: SA, cardHash, bindingProofHash, claimHashes: [], expiresAt: 0 })));
console.log(`${NAME} ${SA} · profile ${registered ? 'registered' : 'to register'} · ${calls.length} call(s)${skipped.length ? ` · NOT written (predicate inactive on this chain): ${skipped.join(', ')}` : ''}`);

if (calls.length) {
  const si = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: 'alice', client_id: 'demo-web' }) }));
  const sign = async (digest: Hex): Promise<Hex> => { const b = await j(await fetch(`${HOME}/connect/persona-sign`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${si.homeSession}` }, body: JSON.stringify({ digest }) })); if (!b.signature) throw new Error(`persona-sign: ${JSON.stringify(b).slice(0, 160)}`); return b.signature; };
  const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
  const csrf = (await j(csrfRes)) as { token?: string };
  const H = { 'content-type': 'application/json', origin: HOME, cookie: (csrfRes.headers.get('set-cookie') ?? '').split(';')[0], 'x-csrf-token': csrf.token ?? '' };
  const callData = buildExecuteBatchCallData(calls);
  let txHash: string | undefined; let lastErr = '';
  for (let i = 0; i < 4 && !txHash; i++) {
    if (i) await new Promise((r) => setTimeout(r, 3000));
    const b = await j(await fetch(`${HOME}/a2a/account/build-call-userop`, { method: 'POST', headers: H, body: JSON.stringify({ sender: SA, callData }) }));
    if (!b.ok || !b.userOpHash) { lastErr = `${b.error ?? ''} ${b.detail ?? JSON.stringify(b).slice(0, 200)}`; continue; }
    const s = await j(await fetch(`${HOME}/a2a/account/submit-call-userop`, { method: 'POST', headers: H, body: JSON.stringify({ userOp: { ...b.userOp, signature: await sign(b.userOpHash as Hex) } }) }));
    if (s.ok) txHash = s.transactionHash; else lastErr = `${s.error ?? ''} ${s.detail ?? JSON.stringify(s).slice(0, 200)}`;
  }
  if (!txHash) { console.error(`✗ the facets did not land: ${lastErr}`); process.exit(1); }
  console.log(`  tx ${txHash}`);
}
// ── read back ──
const after = await naming.getRecords(NAME);
console.log(`  records: a2aEndpoint ${after.a2aEndpoint ?? '-'} · siteUrl ${after.siteUrl ?? '-'} · displayName ${after.displayName ?? '-'}`);
console.log(`  profile: capabilities "${await current('atl:capabilities')}" · languages "${await current('atl:languages')}" · focusAreas "${await current('atl:focusAreas')}"`);
const proj = await j(await fetch(`${INDEXER}/project`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agents: [SA, note.org.sa] }) }));
console.log(`  indexer: ${JSON.stringify(proj).slice(0, 200)}`);
const n = JSON.parse(readFileSync(NOTE, 'utf8')); n.service = { ...n.service, host: HOST, facets: FACETS, registry: REGISTRY_URN, facetsAt: new Date().toISOString() }; writeFileSync(NOTE, JSON.stringify(n, null, 2) + '\n');
console.log('✓ facets written and projected');
