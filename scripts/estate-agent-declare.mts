// AN ESTATE AGENT DECLARES ITSELF — `atl:homepage` and/or `atl:projectionSigner` on its own profile, signed by a
// CUSTODIAN the operator holds (spec 439 F2.5; the estate half of federation).
//
// Two custody shapes exist for an estate agent and this script serves both:
//   · the runtime-custodied shape (imbnet): the agent is salt 2 over the estate's interactions key — use
//     add-estate-agent.mts / set-projection-signer.mts with `.estate-<estate>.local`;
//   · the PERSONA-custodied shape (faithnet, owner's decision 2026-10-14): the estate agent is an existing agent
//     custodied by a demo persona (`faith-estate.workspace`, custodian demo-admin) — this script, with the
//     persona's key from demo/personas.local.json, a relay key that pays gas, and an RPC.
// Idempotent: a value already equal writes nothing. Registers the profile first when the agent has none.
//
//   RPC_URL=… RELAY_PRIVATE_KEY_FILE=~/.faithchain-deployer.key \
//   npx tsx scripts/estate-agent-declare.mts --agent 0x… --custodian-persona demo-admin [--homepage https://…] [--signer 0x…] [--display "faithnet estate"] [--dry-run]
import { readFileSync } from 'node:fs';
import { AgentAccountClient, buildExecuteCallData } from '@agenticprimitives/agent-account';
import { buildRegisterProfileCall } from '@agenticprimitives/agent-profile';
import { createPublicClient, decodeEventLog, encodeFunctionData, http, keccak256, toBytes, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const arg = (k: string): string | undefined => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const agent = (arg('agent') ?? '').toLowerCase() as Address; const persona = arg('custodian-persona'); const homepage = arg('homepage')?.trim(); const signer = arg('signer')?.toLowerCase(); const dry = process.argv.includes('--dry-run');
if (!/^0x[0-9a-f]{40}$/.test(agent) || !persona || (!homepage && !signer)) { console.error('usage: estate-agent-declare.mts --agent 0x… --custodian-persona <handle> [--homepage https://…] [--signer 0x…] [--display "…"] [--dry-run]'); process.exit(1); }
if (signer && !/^0x[0-9a-f]{40}$/.test(signer)) { console.error('--signer must be an address'); process.exit(1); }
const RPC = process.env.RPC_URL ?? (() => { console.error('RPC_URL is required'); process.exit(1); })();
const relayFile = (process.env.RELAY_PRIVATE_KEY_FILE ?? '').replace(/^~/, process.env.HOME ?? '');
const relayKey = (process.env.RELAY_PRIVATE_KEY ?? (relayFile ? readFileSync(relayFile, 'utf8').trim() : '')) as Hex;
if (!/^0x[0-9a-fA-F]{64}$/.test(relayKey)) { console.error('RELAY_PRIVATE_KEY or RELAY_PRIVATE_KEY_FILE (a funded EOA that submits the userOp) is required'); process.exit(1); }
const roster = JSON.parse(readFileSync('demo/personas.local.json', 'utf8')) as Record<string, { eoaPrivateKey?: string; eoaAddress?: string }>;
const row = roster[persona]; if (!row?.eoaPrivateKey) { console.error(`no persona ${persona} with a key in demo/personas.local.json`); process.exit(1); }
const custodian = privateKeyToAccount(row.eoaPrivateKey as Hex);

const CHAIN_ID = Number(process.env.CHAIN_ID ?? 34348);
const ENTRY_POINT = '0xf7855250B3363AB7649B10957d8908A9AFcdD4B5' as Address; const FACTORY = '0x464eEe7518c3c97DA570592481329E0627E9a3B8' as Address;
const PROFILE_RESOLVER = (process.env.PROFILE_RESOLVER ?? '0xB03F7C06ad3274F584AB72794406D639c02A45e1') as Address; const PAYMASTER = (process.env.PAYMASTER ?? '0xbd93fEC6910ffD74F14709188b5a9B6C6965b2a7') as Address;
const P = { homepage: keccak256(toBytes('atl:homepage')), projectionSigner: keccak256(toBytes('atl:projectionSigner')) };
const ABI = [
  { type: 'function', name: 'isRegistered', stateMutability: 'view', inputs: [{ name: 'agent', type: 'address' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'getStringProperty', stateMutability: 'view', inputs: [{ name: 'agent', type: 'address' }, { name: 'predicate', type: 'bytes32' }], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'getAddressProperty', stateMutability: 'view', inputs: [{ name: 'agent', type: 'address' }, { name: 'predicate', type: 'bytes32' }], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'setStringProperty', stateMutability: 'nonpayable', inputs: [{ name: 'agent', type: 'address' }, { name: 'predicate', type: 'bytes32' }, { name: 'value', type: 'string' }], outputs: [] },
  { type: 'function', name: 'setAddressProperty', stateMutability: 'nonpayable', inputs: [{ name: 'agent', type: 'address' }, { name: 'predicate', type: 'bytes32' }, { name: 'value', type: 'address' }], outputs: [] },
  { type: 'function', name: 'isCustodian', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'bool' }] },
] as const;
const chain = { id: CHAIN_ID, name: 'estate-chain', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } as const;
const pc = createPublicClient({ chain, transport: http(RPC) });
const client = new AgentAccountClient({ rpcUrl: RPC, chainId: CHAIN_ID, entryPoint: ENTRY_POINT, factory: FACTORY });

const isCust = await pc.readContract({ address: agent, abi: ABI, functionName: 'isCustodian', args: [custodian.address] }).catch(() => null);
if (isCust !== true) { console.error(`${persona} (${custodian.address}) is not a custodian of ${agent} — nothing signed`); process.exit(1); }
console.log(`agent ${agent} · custodian ${persona} ${custodian.address} · relay ${privateKeyToAccount(relayKey).address}`);
const registered = await pc.readContract({ address: PROFILE_RESOLVER, abi: ABI, functionName: 'isRegistered', args: [agent] }).catch(() => false);
const calls: { to: Address; value: bigint; data: Hex; what: string }[] = [];
if (!registered) { const r = buildRegisterProfileCall({ profileResolver: PROFILE_RESOLVER, agent, displayName: arg('display') ?? 'estate agent', description: 'An estate agent: the stable identity of an estate; its Home URL in atl:homepage; its projection signer in atl:projectionSigner.' }); calls.push({ to: r.to, value: r.value ?? 0n, data: r.data, what: 'register the profile' }); }
if (homepage) { const cur = registered ? String(await pc.readContract({ address: PROFILE_RESOLVER, abi: ABI, functionName: 'getStringProperty', args: [agent, P.homepage] }).catch(() => '')) : ''; if (cur.trim() === homepage) console.log(`atl:homepage already ${homepage}`); else calls.push({ to: PROFILE_RESOLVER, value: 0n, data: encodeFunctionData({ abi: ABI, functionName: 'setStringProperty', args: [agent, P.homepage, homepage] }), what: `set atl:homepage = ${homepage}` }); }
if (signer) { const cur = registered ? String(await pc.readContract({ address: PROFILE_RESOLVER, abi: ABI, functionName: 'getAddressProperty', args: [agent, P.projectionSigner] }).catch(() => '')).toLowerCase() : ''; if (cur === signer) console.log(`atl:projectionSigner already ${signer}`); else calls.push({ to: PROFILE_RESOLVER, value: 0n, data: encodeFunctionData({ abi: ABI, functionName: 'setAddressProperty', args: [agent, P.projectionSigner, signer as Address] }), what: `set atl:projectionSigner = ${signer}` }); }
if (!calls.length) { console.log('nothing to write'); process.exit(0); }
for (const c of calls) console.log(`${dry ? 'would' : 'will'} ${c.what}`);
if (dry) process.exit(0);

const OP_EVENT = { type: 'event', name: 'UserOperationEvent', inputs: [{ name: 'userOpHash', type: 'bytes32', indexed: true }, { name: 'sender', type: 'address', indexed: true }, { name: 'paymaster', type: 'address', indexed: true }, { name: 'nonce', type: 'uint256' }, { name: 'success', type: 'bool' }, { name: 'actualGasCost', type: 'uint256' }, { name: 'actualGasUsed', type: 'uint256' }] } as const;
// One call per userOp, and the EntryPoint's verdict read back (see add-estate-agent.mts for why).
for (const c of calls) {
  const built = await client.buildCallUserOp({ sender: agent, callData: buildExecuteCallData({ to: c.to, value: c.value, data: c.data }), paymaster: PAYMASTER });
  built.userOp.signature = await custodian.signMessage({ message: { raw: built.userOpHash } });
  const { receipt } = await client.submitCallUserOp(built.userOp, privateKeyToAccount(relayKey));
  if (receipt.status !== 'success') { console.error(`  ${c.what}: the transaction reverted (tx ${receipt.transactionHash})`); process.exit(1); }
  let ok: boolean | null = null;
  for (const log of receipt.logs) { try { ok = decodeEventLog({ abi: [OP_EVENT], data: log.data, topics: log.topics }).args.success as boolean; } catch { /* another event */ } }
  if (ok === false) { console.error(`  ${c.what}: the userOp reverted inside the account (tx ${receipt.transactionHash})`); process.exit(1); }
  console.log(`  ${c.what}: done (tx ${receipt.transactionHash})`);
}
