// DECLARE AN AGENT'S TYPE, SIGNED THROUGH ITS CUSTODIAN'S HOME — for an agent whose custodian is a demo persona whose
// key lives at a Home (persona-sign), not on this machine. Spec 346 §3.6 step 1b: `atl:agentType` on the agent's own
// profile, written by the agent itself (a userOp its custodian signs). The case that needed it: a person's treasury
// born from the Home's birthright carries no type record, and money moves only between accounts the harness can tell
// are treasuries — so a payment FROM it is refused until the record exists. Idempotent.
//
//   RPC_URL=… RELAY_PRIVATE_KEY_FILE=~/.faithchain-deployer.key HOME_URL=https://www.impact-agent.me \
//   npx tsx scripts/declare-agent-type-via-home.mts --by maya --agent 0x… --type treasury [--display "maya's treasury"] [--dry-run]
import { readFileSync } from 'node:fs';
import { AgentAccountClient, buildExecuteCallData } from '@agenticprimitives/agent-account';
import { buildDeclareAgentTypeCalls } from '@agenticprimitives/agent-naming';
import { createPublicClient, decodeEventLog, http, keccak256, toBytes, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const arg = (k: string): string | undefined => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const by = arg('by'); const agent = (arg('agent') ?? '').toLowerCase() as Address; const type = arg('type') as 'treasury' | 'service' | 'person' | 'org' | undefined; const display = arg('display'); const dry = process.argv.includes('--dry-run');
const HOME = process.env.HOME_URL ?? 'https://www.faithnet.me';
if (!by || !/^0x[0-9a-f]{40}$/.test(agent) || !type) { console.error('usage: declare-agent-type-via-home.mts --by <persona> --agent 0x… --type treasury|service|… [--display "…"] [--dry-run]'); process.exit(1); }
const RPC = process.env.RPC_URL ?? (() => { console.error('RPC_URL is required'); process.exit(1); })();
const relayFile = (process.env.RELAY_PRIVATE_KEY_FILE ?? '').replace(/^~/, process.env.HOME ?? '');
const relayKey = (process.env.RELAY_PRIVATE_KEY ?? (relayFile ? readFileSync(relayFile, 'utf8').trim() : '')) as Hex;
if (!/^0x[0-9a-fA-F]{64}$/.test(relayKey)) { console.error('RELAY_PRIVATE_KEY(_FILE) is required'); process.exit(1); }
const CHAIN_ID = Number(process.env.CHAIN_ID ?? 34348);
const ENTRY_POINT = '0xf7855250B3363AB7649B10957d8908A9AFcdD4B5' as Address; const FACTORY = '0x464eEe7518c3c97DA570592481329E0627E9a3B8' as Address;
const PROFILE_RESOLVER = (process.env.PROFILE_RESOLVER ?? '0xB03F7C06ad3274F584AB72794406D639c02A45e1') as Address; const PAYMASTER = (process.env.PAYMASTER ?? '0xbd93fEC6910ffD74F14709188b5a9B6C6965b2a7') as Address;
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 200) }; } };
const signin = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: by, client_id: 'demo-jp' }) }));
const token: string = signin.homeSession; if (!token) { console.error(`no session for ${by} at ${HOME}`); process.exit(1); }
const sign = async (digest: Hex): Promise<Hex> => { const b = await j(await fetch(`${HOME}/connect/persona-sign`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ digest }) })); if (!b.signature) throw new Error(b.error ?? 'persona-sign refused'); return b.signature as Hex; };
const chain = { id: CHAIN_ID, name: 'c', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } as const;
const pc = createPublicClient({ chain, transport: http(RPC) });
const client = new AgentAccountClient({ rpcUrl: RPC, chainId: CHAIN_ID, entryPoint: ENTRY_POINT, factory: FACTORY });
const ABI = [{ type: 'function', name: 'isRegistered', stateMutability: 'view', inputs: [{ name: 'agent', type: 'address' }], outputs: [{ type: 'bool' }] }, { type: 'function', name: 'getBytes32Property', stateMutability: 'view', inputs: [{ name: 'agent', type: 'address' }, { name: 'predicate', type: 'bytes32' }], outputs: [{ type: 'bytes32' }] }] as const;
const registered = await pc.readContract({ address: PROFILE_RESOLVER, abi: ABI, functionName: 'isRegistered', args: [agent] }).catch(() => false);
const typeNow = registered ? String(await pc.readContract({ address: PROFILE_RESOLVER, abi: ABI, functionName: 'getBytes32Property', args: [agent, keccak256(toBytes('atl:agentType'))] }).catch(() => '0x')) : '0x';
console.log(`agent ${agent} · registered ${registered} · atl:agentType ${/^0x0*$/.test(typeNow) ? '(none)' : typeNow} · signer ${by} via ${HOME}`);
if (!/^0x0*$/.test(typeNow)) { console.log('already declared — nothing to write'); process.exit(0); }
const calls = buildDeclareAgentTypeCalls({ profileResolver: PROFILE_RESOLVER, agent, agentType: type, registered, displayName: display ?? `${by}'s ${type}` });
for (const c of calls) console.log(`${dry ? 'would send' : 'sending'} ${c.data.slice(0, 10)} → ${c.to}`);
if (dry) process.exit(0);
const OP_EVENT = { type: 'event', name: 'UserOperationEvent', inputs: [{ name: 'userOpHash', type: 'bytes32', indexed: true }, { name: 'sender', type: 'address', indexed: true }, { name: 'paymaster', type: 'address', indexed: true }, { name: 'nonce', type: 'uint256' }, { name: 'success', type: 'bool' }, { name: 'actualGasCost', type: 'uint256' }, { name: 'actualGasUsed', type: 'uint256' }] } as const;
for (const c of calls) {
  const built = await client.buildCallUserOp({ sender: agent, callData: buildExecuteCallData({ to: c.to, value: c.value ?? 0n, data: c.data }), paymaster: PAYMASTER });
  built.userOp.signature = await sign(built.userOpHash);
  const { receipt } = await client.submitCallUserOp(built.userOp, privateKeyToAccount(relayKey));
  let ok: boolean | null = null;
  for (const log of receipt.logs) { try { ok = decodeEventLog({ abi: [OP_EVENT], data: log.data, topics: log.topics }).args.success as boolean; } catch { /* another event */ } }
  if (receipt.status !== 'success' || ok === false) { console.error(`  the userOp failed (tx ${receipt.transactionHash}) — is ${by} the custodian of ${agent}?`); process.exit(1); }
  console.log(`  done (tx ${receipt.transactionHash})`);
}
