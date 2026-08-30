// Set PUBLIC name-node records on a typed agent name the SA owns (spec 222 records + spec 347 §8.3 card
// records) — the AP Naming projection's write path, as an operator tool. One userOp, custodian-signed.
//
//   DEPLOY_NETWORK=faithchain RPC_URL=… HANDLE=discovery.registry CUSTODIAN_KEY=0x… \
//   A2A_ENDPOINT=https://discovery-a2a.faithnet.io [SITE_URL=…] [CARD_URI=…] [CARD_DIGEST=0x…] [DESCRIPTION=…] \
//   pnpm --filter agenticprimitives-demo-sso-next exec tsx scripts/set-typed-name-records.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPublicClient, http, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { AgentAccountClient, buildExecuteBatchCallData, type ContractCall } from '@agenticprimitives/agent-account';
import { parseAgentName, encodeRecords, buildSetStringAttributeCall, buildSetBytes32AttributeCall, agentNameRegistryAbi, type AgentNameRecords } from '@agenticprimitives/agent-naming';

const APP_ROOT = join(import.meta.dirname ?? __dirname, '..');
const REPO_ROOT = join(APP_ROOT, '..', '..');
const NETWORK = process.env.DEPLOY_NETWORK ?? 'anvil';
const RPC_URL = process.env.RPC_URL ?? 'http://127.0.0.1:8545';
const HANDLE = (process.env.HANDLE ?? '').trim().toLowerCase();
const CUSTODIAN_KEY = (process.env.CUSTODIAN_KEY ?? '') as Hex;
if (!HANDLE || !CUSTODIAN_KEY) throw new Error('HANDLE + CUSTODIAN_KEY required');
const d = JSON.parse(readFileSync(join(REPO_ROOT, 'packages', 'contracts', `deployments-${NETWORK}.json`), 'utf8')) as Record<string, Address> & { chainId: number };

const records: AgentNameRecords = {
  ...(process.env.A2A_ENDPOINT ? { a2aEndpoint: process.env.A2A_ENDPOINT } : {}),
  ...(process.env.SITE_URL ? { siteUrl: process.env.SITE_URL } : {}),
  ...(process.env.DESCRIPTION ? { description: process.env.DESCRIPTION } : {}),
  ...(process.env.CARD_URI ? { cardUri: process.env.CARD_URI } : {}),
  ...(process.env.CARD_DIGEST ? { cardDigest: process.env.CARD_DIGEST as Hex } : {}),
};
const encoded = encodeRecords(records);
if (encoded.length === 0) throw new Error('no records given (A2A_ENDPOINT / SITE_URL / DESCRIPTION / CARD_URI / CARD_DIGEST)');

const parsed = parseAgentName(HANDLE);
const node = parsed.node;
const pub = createPublicClient({ transport: http(RPC_URL) });
const chainId = Number(await pub.getChainId());
if (chainId !== d.chainId) throw new Error(`RPC chain ${chainId} ≠ deployments-${NETWORK}.json chain ${d.chainId}`);
const owner = ((await pub.readContract({ address: d.agentNameRegistry, abi: agentNameRegistryAbi, functionName: 'owner', args: [node] })) as Address).toLowerCase();
const custodian = privateKeyToAccount(CUSTODIAN_KEY);
console.log(`${HANDLE} node ${node} owner ${owner}; custodian ${custodian.address}`);
if (owner === '0x0000000000000000000000000000000000000000') throw new Error(`${HANDLE} is not registered`);

const calls: ContractCall[] = encoded.map((r) =>
  r.datatype === 'bytes32'
    ? buildSetBytes32AttributeCall({ resolver: d.agentNameResolver, node, predicate: r.predicate, value: r.value })
    : buildSetStringAttributeCall({ resolver: d.agentNameResolver, node, predicate: r.predicate, value: r.value as string }),
);
const accounts = new AgentAccountClient({ rpcUrl: RPC_URL, chainId, entryPoint: d.entryPoint, factory: d.agentAccountFactory });
const sa = owner as Address;
const callGasLimit = BigInt(process.env.CALL_GAS_LIMIT ?? 1_500_000);
console.log(`submitting ${calls.length} record write(s) as SA ${sa}: ${Object.keys(records).join(', ')}`);
const { userOp, userOpHash } = await accounts.buildCallUserOp({ sender: sa, callData: buildExecuteBatchCallData(calls), paymaster: d.smartAgentPaymaster, callGasLimit });
userOp.signature = await custodian.signMessage({ message: { raw: userOpHash } });
await accounts.submitCallUserOp(userOp, custodian);
console.log('done');
