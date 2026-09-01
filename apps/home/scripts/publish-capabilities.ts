/**
 * Publish an agent's advertised capability IDS on chain (`atl:capabilities`), signed by its custodian.
 *
 * The Home does this for a signed-in owner. This is the operator path — for a service agent whose
 * custodian is a key rather than a session, and for proving the rail end to end: the ids written here
 * are what the A2A card advertises as `skills[]` and what ARD lists as `capabilities[]`.
 *
 *   DEPLOY_NETWORK=faithchain RPC_URL=… CUSTODIAN_KEY=0x… SA=0x… \
 *     CAPABILITIES="registry.search,registry.explore" pnpm tsx scripts/publish-capabilities.ts
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPublicClient, http, keccak256, toBytes, encodeFunctionData, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { AgentAccountClient, buildExecuteBatchCallData, type ContractCall } from '@agenticprimitives/agent-account';

const APP_ROOT = join(import.meta.dirname ?? __dirname, '..');
const REPO_ROOT = join(APP_ROOT, '..', '..');
const NETWORK = process.env.DEPLOY_NETWORK ?? 'anvil';
const RPC_URL = process.env.RPC_URL ?? 'http://127.0.0.1:8545';
const CUSTODIAN_KEY = (process.env.CUSTODIAN_KEY ?? '') as Hex;
const SA = (process.env.SA ?? '') as Address;
const IDS = (process.env.CAPABILITIES ?? '').split(',').map((s) => s.trim()).filter(Boolean);

if (!CUSTODIAN_KEY || !SA) throw new Error('CUSTODIAN_KEY and SA are required');

const d = JSON.parse(readFileSync(join(REPO_ROOT, 'packages/contracts', `deployments-${NETWORK}.json`), 'utf8')) as Record<string, Address>;
const custodian = privateKeyToAccount(CUSTODIAN_KEY);
const pub = createPublicClient({ transport: http(RPC_URL) });
const chainId = await pub.getChainId();

const PROFILE_ABI = [
  { type: 'function', name: 'isRegistered', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'getStringProperty', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'bytes32' }], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'setStringProperty', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'bytes32' }, { type: 'string' }], outputs: [] },
] as const;
const ATL_CAPABILITIES = keccak256(toBytes('atl:capabilities'));

const registered = (await pub.readContract({ address: d.agentProfileResolver, abi: PROFILE_ABI, functionName: 'isRegistered', args: [SA] })) as boolean;
if (!registered) throw new Error(`${SA} has no profile registered — register it before publishing capabilities`);

const before = (await pub.readContract({ address: d.agentProfileResolver, abi: PROFILE_ABI, functionName: 'getStringProperty', args: [SA, ATL_CAPABILITIES] })) as string;
console.log(`chain ${chainId} · ${SA}\n  before: ${JSON.stringify(before)}\n  writing: ${JSON.stringify(IDS.join(', '))}`);

const accounts = new AgentAccountClient({ rpcUrl: RPC_URL, chainId, entryPoint: d.entryPoint, factory: d.agentAccountFactory });
const calls: ContractCall[] = [{
  to: d.agentProfileResolver, value: 0n,
  data: encodeFunctionData({ abi: PROFILE_ABI, functionName: 'setStringProperty', args: [SA, ATL_CAPABILITIES, IDS.join(', ')] }),
}];
const callGasLimit = BigInt(process.env.CALL_GAS_LIMIT ?? 1_500_000);
const { userOp, userOpHash } = await accounts.buildCallUserOp({ sender: SA, callData: buildExecuteBatchCallData(calls), paymaster: d.smartAgentPaymaster, callGasLimit });
userOp.signature = await custodian.signMessage({ message: { raw: userOpHash } });
await accounts.submitCallUserOp(userOp, custodian);

const after = (await pub.readContract({ address: d.agentProfileResolver, abi: PROFILE_ABI, functionName: 'getStringProperty', args: [SA, ATL_CAPABILITIES] })) as string;
console.log(`  after : ${JSON.stringify(after)}`);
if (after !== IDS.join(', ')) throw new Error('write did not land');
console.log('OK');
