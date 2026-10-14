/**
 * RECORD THAT A TREASURY IS SOMEONE'S — the `ap:charteredUnder` edge, proposed, confirmed and activated.
 *
 * WHY A TREASURY CAN EXIST AND STILL NOT BE YOURS. The edge on `AgentRelationship` is the ONLY basis on which this
 * substrate answers "whose treasury is this?" — a countersigned, public, chain-reproducible fact (ADR-0040), which
 * is exactly why "send alice 20 USDC" can be routed for anyone and not only for Alice. Without it a treasury is an
 * account with a balance and no owner, and the Ask says so: *"You have no treasury to be paying from."* That is the
 * ontology refusing to guess, which is right — `ap:charteredUnder` is the relationship `party-roles.ts` traverses,
 * and a name that merely LOOKS like its owner's was the exact wrong answer that rule was written to forbid.
 *
 * maya's treasury (2026-10-14) was in that state: registered at her Home, listed as her `person-treasury`, holding a
 * real balance, and carrying no edge. Her Home believed it; the chain had never been told. So the birthright effect
 * reused it and never made the edge, and she could receive money forever and never spend it.
 *
 * THREE TRANSACTIONS, because the shape is a countersignature and not an assertion (AgentRelationship.sol):
 *   proposeEdge  — only the SUBJECT may propose (the treasury says "I am chartered under her");
 *   confirmEdge  — only the OBJECT may confirm (she says "yes, it is mine");
 *   activateEdge — either party; PROPOSED and CONFIRMED are not yet an answer, only ACTIVE is.
 * Each is a userOp from that account, signed by its custodian. It grants NOTHING: the edge says whose the treasury
 * is, and what lets anyone spend from it is a mandate, judged every time.
 *
 *   RPC_URL=… RELAY_PRIVATE_KEY_FILE=~/.faithchain-deployer.key HOME_URL=https://www.impact-agent.me \
 *   npx tsx scripts/charter-treasury-edge.mts --treasury 0x… --person 0x… --by maya [--dry-run]
 */
import { readFileSync } from 'node:fs';
import { AgentAccountClient, buildExecuteCallData } from '@agenticprimitives/agent-account';
import { createPublicClient, decodeEventLog, encodeFunctionData, http, keccak256, toBytes, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const arg = (k: string): string | undefined => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const treasury = (arg('treasury') ?? '').toLowerCase() as Address;
const person = (arg('person') ?? '').toLowerCase() as Address;
const by = arg('by'); const dry = process.argv.includes('--dry-run');
const HOME = (arg('home') ?? process.env.HOME_URL ?? 'https://www.faithnet.me').replace(/\/$/, '');
const CHAIN_ID = Number(process.env.CHAIN_ID ?? 34348);
const RELATIONSHIP = (arg('relationship') ?? 'https://agenticprimitives.dev/ns/core#charteredUnder');
const addr = (v: string) => /^0x[0-9a-f]{40}$/.test(v);
if (!addr(treasury) || !addr(person) || !by) { console.error('usage: charter-treasury-edge.mts --treasury 0x… --person 0x… --by <steward handle> [--home https://…] [--dry-run]'); process.exit(2); }
const RPC = process.env.RPC_URL ?? process.env.FEDERATION_RPC_URL;
if (!RPC) { console.error('RPC_URL is required'); process.exit(2); }
const relayFile = (process.env.RELAY_PRIVATE_KEY_FILE ?? '').replace(/^~/, process.env.HOME ?? '');
const relayKey = (process.env.RELAY_PRIVATE_KEY ?? (relayFile ? readFileSync(relayFile, 'utf8').trim() : '')) as Hex;
if (!/^0x[0-9a-fA-F]{64}$/.test(relayKey)) { console.error('RELAY_PRIVATE_KEY(_FILE) is required'); process.exit(2); }

const RELATIONSHIPS = (process.env.AGENT_RELATIONSHIP ?? '0x5015bD7d422e003511246f848cDd798cb00BB968') as Address;
const ENTRY_POINT = '0xf7855250B3363AB7649B10957d8908A9AFcdD4B5' as Address;
const FACTORY = '0x464eEe7518c3c97DA570592481329E0627E9a3B8' as Address;
const PAYMASTER = (process.env.PAYMASTER ?? '0xbd93fEC6910ffD74F14709188b5a9B6C6965b2a7') as Address;
const REL_ABI = [
  { type: 'function', name: 'proposeEdge', stateMutability: 'nonpayable', inputs: [{ name: 'subject', type: 'address' }, { name: 'object_', type: 'address' }, { name: 'relationshipType', type: 'bytes32' }, { name: 'initialRoles', type: 'bytes32[]' }, { name: 'metadataURI', type: 'string' }, { name: 'metadataHash', type: 'bytes32' }], outputs: [{ type: 'bytes32' }] },
  { type: 'function', name: 'confirmEdge', stateMutability: 'nonpayable', inputs: [{ name: 'edgeId', type: 'bytes32' }], outputs: [] },
  { type: 'function', name: 'activateEdge', stateMutability: 'nonpayable', inputs: [{ name: 'edgeId', type: 'bytes32' }], outputs: [] },
  { type: 'function', name: 'computeEdgeId', stateMutability: 'pure', inputs: [{ name: 'subject', type: 'address' }, { name: 'object_', type: 'address' }, { name: 'relationshipType', type: 'bytes32' }], outputs: [{ type: 'bytes32' }] },
  { type: 'function', name: 'getEdge', stateMutability: 'view', inputs: [{ name: 'edgeId', type: 'bytes32' }], outputs: [{ type: 'tuple', components: [
    { name: 'edgeId', type: 'bytes32' }, { name: 'subject', type: 'address' }, { name: 'object_', type: 'address' }, { name: 'relationshipType', type: 'bytes32' },
    { name: 'status', type: 'uint8' }, { name: 'createdBy', type: 'address' }, { name: 'createdAt', type: 'uint64' }, { name: 'updatedAt', type: 'uint64' },
    { name: 'metadataURI', type: 'string' }, { name: 'metadataHash', type: 'bytes32' }] }] },
] as const;
const ACC_ABI = [{ type: 'function', name: 'isCustodian', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'bool' }] }] as const;
const OP_EVENT = { type: 'event', name: 'UserOperationEvent', inputs: [{ name: 'userOpHash', type: 'bytes32', indexed: true }, { name: 'sender', type: 'address', indexed: true }, { name: 'paymaster', type: 'address', indexed: true }, { name: 'nonce', type: 'uint256' }, { name: 'success', type: 'bool' }, { name: 'actualGasCost', type: 'uint256' }, { name: 'actualGasUsed', type: 'uint256' }] } as const;

const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t) as Record<string, unknown>; } catch { return { _raw: t.slice(0, 200) }; } };
const chain = { id: CHAIN_ID, name: 'c', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } as const;
const pc = createPublicClient({ chain, transport: http(RPC) });
const client = new AgentAccountClient({ rpcUrl: RPC, chainId: CHAIN_ID, entryPoint: ENTRY_POINT, factory: FACTORY });

// the steward, and PROOF they may speak for BOTH accounts — the treasury proposes and the person confirms
const si = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: by, client_id: 'demo-jp' }) }));
const token = String(si.homeSession ?? '');
if (!token) { console.error(`no session for ${by} at ${HOME}`); process.exit(1); }
const sign = async (d: Hex): Promise<Hex> => {
  const b = await j(await fetch(`${HOME}/connect/persona-sign`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ digest: d }) }));
  if (!b.signature) throw new Error(`persona-sign: ${JSON.stringify(b).slice(0, 140)}`);
  return b.signature as Hex;
};
const { recoverMessageAddress } = await import('viem');
const probe = keccak256(toBytes(`charter-treasury-edge probe ${Date.now()}`));
const eoa = (await recoverMessageAddress({ message: { raw: probe }, signature: await sign(probe) })).toLowerCase() as Address;
for (const [what, a] of [['the treasury', treasury], ['the person', person]] as const) {
  const ok = await pc.readContract({ address: a, abi: ACC_ABI, functionName: 'isCustodian', args: [eoa] }).catch(() => false);
  if (ok !== true) { console.error(`${by} (${eoa}) is not a custodian of ${what} ${a} — both sides must be able to sign their own half`); process.exit(1); }
}

const relType = keccak256(toBytes(RELATIONSHIP));
const edgeId = await pc.readContract({ address: RELATIONSHIPS, abi: REL_ABI, functionName: 'computeEdgeId', args: [treasury, person, relType] });
const existing = await pc.readContract({ address: RELATIONSHIPS, abi: REL_ABI, functionName: 'getEdge', args: [edgeId] }).catch(() => null);
const STATUS = ['NONE', 'PROPOSED', 'CONFIRMED', 'ACTIVE', 'REVOKED'];
const status = existing && Number(existing.createdAt) !== 0 ? Number(existing.status) : 0;
console.log(`${RELATIONSHIP.split('#')[1]}: ${treasury} → ${person}\n  edge ${edgeId}\n  status ${STATUS[status] ?? status}, steward ${by} (${eoa}) custodies both`);
if (status === 3) { console.log('  already ACTIVE — nothing to do'); process.exit(0); }
if (dry) { console.log('  would propose (as the treasury), confirm (as the person), activate'); process.exit(0); }

const send = async (from: Address, data: Hex, what: string): Promise<void> => {
  const built = await client.buildCallUserOp({ sender: from, callData: buildExecuteCallData({ to: RELATIONSHIPS, value: 0n, data }), paymaster: PAYMASTER });
  built.userOp.signature = await sign(built.userOpHash);
  const { receipt } = await client.submitCallUserOp(built.userOp, privateKeyToAccount(relayKey));
  let ok: boolean | null = null;
  for (const log of receipt.logs) { try { ok = decodeEventLog({ abi: [OP_EVENT], data: log.data, topics: log.topics }).args.success as boolean; } catch { /* another event */ } }
  if (receipt.status !== 'success' || ok === false) throw new Error(`${what} failed (tx ${receipt.transactionHash})`);
  console.log(`  ${what}: done (tx ${receipt.transactionHash})`);
};

if (status === 0) await send(treasury, encodeFunctionData({ abi: REL_ABI, functionName: 'proposeEdge', args: [treasury, person, relType, [], '', `0x${'0'.repeat(64)}` as Hex] }), 'proposed by the treasury (only the subject may)');
if (status <= 1) await send(person, encodeFunctionData({ abi: REL_ABI, functionName: 'confirmEdge', args: [edgeId] }), 'confirmed by the person (only the object may)');
await send(person, encodeFunctionData({ abi: REL_ABI, functionName: 'activateEdge', args: [edgeId] }), 'activated');

const after = await pc.readContract({ address: RELATIONSHIPS, abi: REL_ABI, functionName: 'getEdge', args: [edgeId] });
console.log(`\n${Number(after.status) === 3 ? '✓' : '✗'} status ${STATUS[Number(after.status)]} — ${Number(after.status) === 3 ? 'the chain now says whose treasury this is; it still grants nothing' : 'not active'}`);
process.exit(Number(after.status) === 3 ? 0 : 1);
