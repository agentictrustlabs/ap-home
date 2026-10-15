// DECLARE THE ESTATE'S PROJECTION SIGNER — spec 439 F2.5, the estate's half of closing first-come-wins.
//
// `EstateProjectionRegistry.register(estateId, signer)` on neutral ground is first-come-wins: public ground cannot
// verify who governs an estate on another chain. So the estate agent declares, ON ITS OWN CHAIN, the key that
// anchors its roots — `atl:projectionSigner` on its profile — and a verifier cross-checks `signerOf` against it.
// Signed by the estate agent itself (its custodian is the estate's interactions key, as in add-estate-agent.mts).
// Idempotent: a declaration already equal to this one writes nothing. The value is PUBLIC by construction (the
// registry stores the same address); the key behind it stays the federation operator's.
//
//   npx tsx scripts/set-projection-signer.mts --estate impact-agent --signer 0xAdcd7257De9686061C0838154cA77790C79a9EfD [--dry-run]
import { existsSync, readFileSync } from 'node:fs';
import { AgentAccountClient, buildExecuteCallData } from '@agenticprimitives/agent-account';
import { createPublicClient, decodeEventLog, encodeFunctionData, http, keccak256, toBytes, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const args = process.argv.slice(2);
const flag = (n: string) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : undefined);
const estate = flag('estate'); const signer = (flag('signer') ?? '').toLowerCase(); const dry = args.includes('--dry-run');
if (!estate || !/^0x[0-9a-f]{40}$/.test(signer)) { console.error('usage: set-projection-signer.mts --estate <id> --signer 0x… [--dry-run]'); process.exit(1); }

const file = `.estate-${estate}.local`;
if (!existsSync(file)) { console.error(`${file} not found — this estate's keys are not on this machine, so its agent cannot sign here`); process.exit(1); }
const env = Object.fromEntries(readFileSync(file, 'utf8').split('\n').filter((l) => l.includes('=') && !l.trim().startsWith('#')).map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^'(.*)'$/, '$1')]; })) as Record<string, string>;
const RPC = env.RPC_URL; const relay = env.A2A_MASTER_PRIVATE_KEY as Hex; const interactions = env.A2A_INTERACTIONS_SESSION_PRIVATE_KEY as Hex;
if (!RPC || !relay || !interactions) { console.error(`${file} does not carry RPC_URL + the relay and interactions keys`); process.exit(1); }
const CHAIN_ID = Number(env.CHAIN_ID ?? 34348);
const ENTRY_POINT = '0xf7855250B3363AB7649B10957d8908A9AFcdD4B5' as Address;
const FACTORY = '0x464eEe7518c3c97DA570592481329E0627E9a3B8' as Address;
const PROFILE_RESOLVER = (env.PROFILE_RESOLVER ?? '0xB03F7C06ad3274F584AB72794406D639c02A45e1') as Address;
const PAYMASTER = (env.PAYMASTER ?? '0xbd93fEC6910ffD74F14709188b5a9B6C6965b2a7') as Address;
const ATL_PROJECTION_SIGNER = keccak256(toBytes('atl:projectionSigner'));
const RESOLVER_ABI = [
  { type: 'function', name: 'isRegistered', stateMutability: 'view', inputs: [{ name: 'agent', type: 'address' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'getAddressProperty', stateMutability: 'view', inputs: [{ name: 'agent', type: 'address' }, { name: 'predicate', type: 'bytes32' }], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'setAddressProperty', stateMutability: 'nonpayable', inputs: [{ name: 'agent', type: 'address' }, { name: 'predicate', type: 'bytes32' }, { name: 'value', type: 'address' }], outputs: [] },
] as const;

const chain = { id: CHAIN_ID, name: 'estate-chain', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } as const;
const pc = createPublicClient({ chain, transport: http(RPC) });
const client = new AgentAccountClient({ rpcUrl: RPC, chainId: CHAIN_ID, entryPoint: ENTRY_POINT, factory: FACTORY });
const custodian = privateKeyToAccount(interactions).address;
const agent = await client.getAddressForAgentAccount({ custodians: [custodian] as readonly Address[], salt: 2n });
console.log(`estate: ${estate}\nestate agent: ${agent} (salt 2 over the estate's interactions key)\nsigner to declare: ${signer}`);
if (!(await client.isDeployed(agent).catch(() => false))) { console.error('the estate agent is not deployed — run add-estate-agent.mts first'); process.exit(1); }
if (!(await pc.readContract({ address: PROFILE_RESOLVER, abi: RESOLVER_ABI, functionName: 'isRegistered', args: [agent] }).catch(() => false))) { console.error('the estate agent has no profile — run add-estate-agent.mts first'); process.exit(1); }
const current = String(await pc.readContract({ address: PROFILE_RESOLVER, abi: RESOLVER_ABI, functionName: 'getAddressProperty', args: [agent, ATL_PROJECTION_SIGNER] }).catch(() => '')).toLowerCase();
if (current === signer) { console.log(`atl:projectionSigner already ${signer} — nothing to write`); process.exit(0); }
console.log(`${dry ? 'would write' : 'writing'} atl:projectionSigner = ${signer}${/^0x0{40}$/.test(current) || !current ? ' (undeclared today)' : ` (replacing ${current})`}`);
if (dry) process.exit(0);

const OP_EVENT = { type: 'event', name: 'UserOperationEvent', inputs: [{ name: 'userOpHash', type: 'bytes32', indexed: true }, { name: 'sender', type: 'address', indexed: true }, { name: 'paymaster', type: 'address', indexed: true }, { name: 'nonce', type: 'uint256' }, { name: 'success', type: 'bool' }, { name: 'actualGasCost', type: 'uint256' }, { name: 'actualGasUsed', type: 'uint256' }] } as const;
const call = { to: PROFILE_RESOLVER, value: 0n, data: encodeFunctionData({ abi: RESOLVER_ABI, functionName: 'setAddressProperty', args: [agent, ATL_PROJECTION_SIGNER, signer as Address] }) };
const built = await client.buildCallUserOp({ sender: agent, callData: buildExecuteCallData(call), paymaster: PAYMASTER });
built.userOp.signature = await privateKeyToAccount(interactions).signMessage({ message: { raw: built.userOpHash } });
const { receipt } = await client.submitCallUserOp(built.userOp, privateKeyToAccount(relay));
if (receipt.status !== 'success') { console.error(`the transaction reverted (tx ${receipt.transactionHash})`); process.exit(1); }
let ok: boolean | null = null;
for (const log of receipt.logs) { try { ok = decodeEventLog({ abi: [OP_EVENT], data: log.data, topics: log.topics }).args.success as boolean; } catch { /* another event */ } }
if (ok === false) { console.error(`the userOp reverted inside the account (tx ${receipt.transactionHash}) — is atl:projectionSigner an ACTIVE term on this chain?`); process.exit(1); }
const after = String(await pc.readContract({ address: PROFILE_RESOLVER, abi: RESOLVER_ABI, functionName: 'getAddressProperty', args: [agent, ATL_PROJECTION_SIGNER] }).catch(() => '')).toLowerCase();
console.log(`done (tx ${receipt.transactionHash}) — atl:projectionSigner now ${after}`);
