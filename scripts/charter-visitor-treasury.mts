// A TREASURY FOR A VISITING AGENT — money moves only between treasuries (spec 420: appr:ValueHolder ≡ ap:Treasury), so a
// visitor that is to be paid needs one on this chain: a Smart Agent custodied by a key the visitor holds, typed
// `treasury` on its own profile (spec 346 §3.6 step 1b, `buildDeclareAgentTypeCalls`). No name is bought here — a
// name is a facet and the harness reads the TYPE record, not a suffix. The relay pays gas; the paymaster sponsors the
// declaration userOps. Idempotent: an existing account and an existing declaration are left as they are.
//
//   RPC_URL=… RELAY_PRIVATE_KEY_FILE=~/.faithchain-deployer.key CUSTODIAN_KEY_ENV_FILE=…/f3-visitor-payee.env CUSTODIAN_KEY_VAR=F3_VISITOR_PAYEE_KEY \
//   npx tsx scripts/charter-visitor-treasury.mts [--salt 0] [--display "visitor treasury"] [--dry-run]
import { readFileSync } from 'node:fs';
import { AgentAccountClient, buildExecuteCallData } from '@agenticprimitives/agent-account';
import { buildDeclareAgentTypeCalls } from '@agenticprimitives/agent-naming';
import { createPublicClient, decodeEventLog, http, keccak256, toBytes, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const arg = (k: string): string | undefined => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const salt = BigInt(arg('salt') ?? '0'); const display = arg('display') ?? 'visitor treasury'; const dry = process.argv.includes('--dry-run');
const RPC = process.env.RPC_URL ?? (() => { console.error('RPC_URL is required'); process.exit(1); })();
const relayFile = (process.env.RELAY_PRIVATE_KEY_FILE ?? '').replace(/^~/, process.env.HOME ?? '');
const relayKey = (process.env.RELAY_PRIVATE_KEY ?? (relayFile ? readFileSync(relayFile, 'utf8').trim() : '')) as Hex;
const envFile = process.env.CUSTODIAN_KEY_ENV_FILE ?? ''; const varName = process.env.CUSTODIAN_KEY_VAR ?? 'CUSTODIAN_PRIVATE_KEY';
const custodianKey = (process.env.CUSTODIAN_PRIVATE_KEY ?? (envFile ? (new RegExp(`^${varName}=(0x[0-9a-fA-F]{64})`, 'm').exec(readFileSync(envFile, 'utf8'))?.[1] ?? '') : '')) as Hex;
if (!/^0x[0-9a-fA-F]{64}$/.test(relayKey) || !/^0x[0-9a-fA-F]{64}$/.test(custodianKey)) { console.error('RELAY_PRIVATE_KEY(_FILE) and the custodian key (CUSTODIAN_PRIVATE_KEY or CUSTODIAN_KEY_ENV_FILE + CUSTODIAN_KEY_VAR) are required'); process.exit(1); }
const CHAIN_ID = Number(process.env.CHAIN_ID ?? 34348);
const ENTRY_POINT = '0xf7855250B3363AB7649B10957d8908A9AFcdD4B5' as Address; const FACTORY = '0x464eEe7518c3c97DA570592481329E0627E9a3B8' as Address;
const PROFILE_RESOLVER = (process.env.PROFILE_RESOLVER ?? '0xB03F7C06ad3274F584AB72794406D639c02A45e1') as Address; const PAYMASTER = (process.env.PAYMASTER ?? '0xbd93fEC6910ffD74F14709188b5a9B6C6965b2a7') as Address;
const custodian = privateKeyToAccount(custodianKey); const relay = privateKeyToAccount(relayKey);
const chain = { id: CHAIN_ID, name: 'c', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } as const;
const pc = createPublicClient({ chain, transport: http(RPC) });
const client = new AgentAccountClient({ rpcUrl: RPC, chainId: CHAIN_ID, entryPoint: ENTRY_POINT, factory: FACTORY });
const spec = { custodians: [custodian.address] as readonly Address[], salt };
const agent = await client.getAddressForAgentAccount(spec);
let deployed = await client.isDeployed(agent).catch(() => false);
console.log(`treasury: ${agent} (salt ${salt} over ${custodian.address}) — ${deployed ? 'deployed' : 'not deployed'}`);
if (!deployed) {
  if (dry) { console.log('would deploy'); } else {
    await client.createAgentAccountFromPrivateKey(spec, relayKey);
    for (let i = 0; i < 10 && !deployed; i++) { deployed = await client.isDeployed(agent).catch(() => false); if (!deployed) await new Promise((r) => setTimeout(r, 1500)); }
    if (!deployed) { console.error('the deploy did not take'); process.exit(1); }
    console.log('  deployed');
  }
}
const ABI = [{ type: 'function', name: 'isRegistered', stateMutability: 'view', inputs: [{ name: 'agent', type: 'address' }], outputs: [{ type: 'bool' }] }, { type: 'function', name: 'getBytes32Property', stateMutability: 'view', inputs: [{ name: 'agent', type: 'address' }, { name: 'predicate', type: 'bytes32' }], outputs: [{ type: 'bytes32' }] }] as const;
const registered = deployed ? await pc.readContract({ address: PROFILE_RESOLVER, abi: ABI, functionName: 'isRegistered', args: [agent] }).catch(() => false) : false;
const typeNow = registered ? await pc.readContract({ address: PROFILE_RESOLVER, abi: ABI, functionName: 'getBytes32Property', args: [agent, keccak256(toBytes('atl:agentType'))] }).catch(() => '0x') : '0x';
if (registered && typeNow && !/^0x0*$/.test(String(typeNow))) { console.log(`  atl:agentType already declared (${typeNow}) — nothing to write\n${agent}`); process.exit(0); }
const calls = buildDeclareAgentTypeCalls({ profileResolver: PROFILE_RESOLVER, agent, agentType: 'treasury', registered, displayName: display });
for (const c of calls) console.log(`${dry ? 'would send' : 'sending'} ${c.data.slice(0, 10)} → ${c.to}`);
if (dry) process.exit(0);
const OP_EVENT = { type: 'event', name: 'UserOperationEvent', inputs: [{ name: 'userOpHash', type: 'bytes32', indexed: true }, { name: 'sender', type: 'address', indexed: true }, { name: 'paymaster', type: 'address', indexed: true }, { name: 'nonce', type: 'uint256' }, { name: 'success', type: 'bool' }, { name: 'actualGasCost', type: 'uint256' }, { name: 'actualGasUsed', type: 'uint256' }] } as const;
for (const c of calls) {
  const built = await client.buildCallUserOp({ sender: agent, callData: buildExecuteCallData({ to: c.to, value: c.value ?? 0n, data: c.data }), paymaster: PAYMASTER });
  built.userOp.signature = await custodian.signMessage({ message: { raw: built.userOpHash } });
  const { receipt } = await client.submitCallUserOp(built.userOp, relay);
  let ok: boolean | null = null;
  for (const log of receipt.logs) { try { ok = decodeEventLog({ abi: [OP_EVENT], data: log.data, topics: log.topics }).args.success as boolean; } catch { /* another event */ } }
  if (receipt.status !== 'success' || ok === false) { console.error(`  a declaration userOp failed (tx ${receipt.transactionHash})`); process.exit(1); }
  console.log(`  done (tx ${receipt.transactionHash})`);
}
console.log(agent);
