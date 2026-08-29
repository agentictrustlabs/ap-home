/**
 * provision-typed-service-agent.ts — a SERVICE-CLASS Smart Agent with a TYPED name (spec 346), on any
 * network whose deployment JSON carries the typed roots (`permissionlessSubregistries`).
 *
 * Bootstrap steps 1 → 1b → 2 → 3 (spec 346 §3.6) in ONE custodian-signed, paymaster-sponsored userOp:
 *   1.  derive + deploy the SA ({ mode 0, custodians [CUSTODIAN], salt = keccak(`typed-agent/<handle>/v1`) })
 *   1b. declare the DERIVED type on the SA's own profile subject (`atl:agentType` + `atl:serviceRole`)
 *   2.  claim `<label>.<tld>` through THAT suffix's PermissionlessSubregistry (owner = the SA)
 *   3.  setPrimaryName + name records (`addr`, `agentKind` = the ROOT of the derived type, displayName)
 *   4.  (optional) `createRegistry(keccak(REGISTRY_URN), policy 0)` on AgentRegistryBase — the SA becomes
 *       the registry's controller, i.e. the `.registry` agent OPERATES its registry (apreg:operatesRegistry).
 *
 * Idempotent: an SA that already holds the name / type / registry is left alone. The custodian key is
 * read from the environment only; nothing is written to disk except the summary JSON (gitignored).
 *
 * Usage:
 *   HANDLE=discovery.registry DEPLOY_NETWORK=faithchain RPC_URL=https://… CUSTODIAN_KEY=0x… \
 *   SERVICE_ROLE=registry REGISTRY_URN=urn:ap:registry:faithnet-agents DISPLAY_NAME="…" \
 *     pnpm exec tsx scripts/provision-typed-service-agent.ts
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createPublicClient, http, keccak256, toBytes, toHex, encodeFunctionData, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { AgentAccountClient, buildExecuteBatchCallData, type ContractCall } from '@agenticprimitives/agent-account';
import {
  agentNameRegistryAbi, agentProfileResolverTypeAbi, buildDeclareAgentTypeCalls, buildSetPrimaryNameCall,
  buildSubregistryRegisterCall, buildSetAddressAttributeCall, buildSetBytes32AttributeCall, buildSetStringAttributeCall,
  namehash, parseAgentName, derivedTypeForTld, rootClassForDerivedType, AGENT_KIND_ID, PREDICATE_ID, ROLE_TYPED,
  type AgentTld,
} from '@agenticprimitives/agent-naming';

const APP_ROOT = join(import.meta.dirname ?? __dirname, '..');
const REPO_ROOT = join(APP_ROOT, '..', '..');
const NETWORK = process.env.DEPLOY_NETWORK ?? 'anvil';
const RPC_URL = process.env.RPC_URL ?? process.env.LOCAL_RPC_URL ?? 'http://127.0.0.1:8545';
const HANDLE = (process.env.HANDLE ?? '').trim().toLowerCase();
const CUSTODIAN_KEY = (process.env.CUSTODIAN_KEY ?? '') as Hex;
const DISPLAY_NAME = process.env.DISPLAY_NAME ?? HANDLE;
const REGISTRY_URN = process.env.REGISTRY_URN ?? '';
if (!HANDLE) throw new Error('HANDLE (a typed handle like discovery.registry) is required');
if (!/^0x[0-9a-fA-F]{64}$/.test(CUSTODIAN_KEY)) throw new Error('CUSTODIAN_KEY is required');

const parsed = parseAgentName(HANDLE);
if (parsed.kind !== 'canonical') throw new Error(`HANDLE must be a canonical typed handle <label>.<tld> (got ${parsed.kind})`);
const tld = parsed.handle!.tld as AgentTld;
const agentType = derivedTypeForTld(tld);
const root = rootClassForDerivedType(agentType);
if (root !== 'service') throw new Error(`this script provisions SERVICE-class agents only (${HANDLE} is ${agentType} → ${root})`);
const SERVICE_ROLE = process.env.SERVICE_ROLE ?? (ROLE_TYPED.has(agentType) ? agentType : undefined);

const DEPLOYMENTS = join(REPO_ROOT, 'packages', 'contracts', `deployments-${NETWORK}.json`);
if (!existsSync(DEPLOYMENTS)) throw new Error(`${DEPLOYMENTS} not found`);
const d = JSON.parse(readFileSync(DEPLOYMENTS, 'utf8')) as {
  chainId: number; entryPoint: Address; agentAccountFactory: Address; agentNameRegistry: Address; agentNameResolver: Address;
  agentProfileResolver: Address; smartAgentPaymaster: Address; agentRegistryBase?: Address;
  permissionlessSubregistries?: Partial<Record<AgentTld, Address>>;
};
const subregistry = d.permissionlessSubregistries?.[tld];
if (!subregistry) throw new Error(`deployments-${NETWORK}.json has no permissionlessSubregistries.${tld} — run AddTypedRoots.s.sol first`);

const pub = createPublicClient({ transport: http(RPC_URL) });
const chainId = Number(await pub.getChainId());
if (chainId !== d.chainId) throw new Error(`RPC chain ${chainId} ≠ deployments-${NETWORK}.json chain ${d.chainId}`);
const custodian = privateKeyToAccount(CUSTODIAN_KEY);
const accounts = new AgentAccountClient({ rpcUrl: RPC_URL, chainId, entryPoint: d.entryPoint, factory: d.agentAccountFactory });

// 1. The SA.
const salt = process.env.SALT !== undefined ? BigInt(process.env.SALT) : BigInt(keccak256(toBytes(`typed-agent/${HANDLE}/v1`)));
const spec = { mode: 0, custodians: [custodian.address] as const, salt };
const sa = await accounts.getAddressForAgentAccount(spec);
if (!(await accounts.isDeployed(sa))) { console.log(`deploying SA ${sa} …`); await accounts.createAgentAccountFromAccount(spec, custodian); }
console.log(`SA ${sa} (custodian ${custodian.address})`);

// What is already true on chain (idempotency reads — one mechanism each).
const node = parsed.node;
const owner = ((await pub.readContract({ address: d.agentNameRegistry, abi: agentNameRegistryAbi, functionName: 'owner', args: [node] }).catch(() => null)) as Address | null ?? '0x0000000000000000000000000000000000000000').toLowerCase();
const primary = ((await pub.readContract({ address: d.agentNameRegistry, abi: agentNameRegistryAbi, functionName: 'primaryName', args: [sa] }).catch(() => null)) as Hex | null ?? '0x').toLowerCase();
const registered = (await pub.readContract({ address: d.agentProfileResolver, abi: agentProfileResolverTypeAbi, functionName: 'isRegistered', args: [sa] })) as boolean;
const declared = registered ? ((await pub.readContract({ address: d.agentProfileResolver, abi: agentProfileResolverTypeAbi, functionName: 'getBytes32Property', args: [sa, PREDICATE_ID.agentType] })) as Hex) : ('0x' + '00'.repeat(32)) as Hex;
const typeDeclared = declared.toLowerCase() === keccak256(toHex(agentType)).toLowerCase();

const REGISTRY_ABI = [
  { type: 'function', name: 'createRegistry', stateMutability: 'nonpayable', inputs: [{ name: 'registryId', type: 'bytes32' }, { name: 'policy', type: 'address' }], outputs: [] },
  { type: 'function', name: 'getRegistry', stateMutability: 'view', inputs: [{ name: 'registryId', type: 'bytes32' }], outputs: [{ type: 'tuple', components: [{ name: 'controller', type: 'address' }, { name: 'policy', type: 'address' }, { name: 'exists', type: 'bool' }] }] },
] as const;
const registryId = REGISTRY_URN ? keccak256(toBytes(REGISTRY_URN)) : null;
let registryExists = false;
if (registryId && d.agentRegistryBase) {
  const r = (await pub.readContract({ address: d.agentRegistryBase, abi: REGISTRY_ABI, functionName: 'getRegistry', args: [registryId] }).catch(() => null)) as { controller: Address; exists: boolean } | null;
  registryExists = !!r?.exists;
  if (r?.exists) console.log(`registry ${REGISTRY_URN} exists (controller ${r.controller})`);
}

const calls: ContractCall[] = [];
if (!typeDeclared) {
  calls.push(...buildDeclareAgentTypeCalls({ profileResolver: d.agentProfileResolver, agent: sa, agentType, serviceRole: SERVICE_ROLE, registered, displayName: DISPLAY_NAME }));
}
if (owner === '0x0000000000000000000000000000000000000000') {
  calls.push(buildSubregistryRegisterCall({ subregistry, label: parsed.handle!.label, newOwner: sa }));
} else if (owner !== sa.toLowerCase()) {
  throw new Error(`${HANDLE} is owned by ${owner} — not this SA`);
}
if (primary !== node.toLowerCase()) {
  calls.push(buildSetPrimaryNameCall({ registry: d.agentNameRegistry, node }));
  calls.push(buildSetAddressAttributeCall({ resolver: d.agentNameResolver, node, predicate: PREDICATE_ID.addr, value: sa }));
  calls.push(buildSetBytes32AttributeCall({ resolver: d.agentNameResolver, node, predicate: PREDICATE_ID.agentKind, value: AGENT_KIND_ID[root] }));
  calls.push(buildSetStringAttributeCall({ resolver: d.agentNameResolver, node, predicate: PREDICATE_ID.displayName, value: DISPLAY_NAME }));
}
if (registryId && d.agentRegistryBase && !registryExists) {
  calls.push({ to: d.agentRegistryBase, value: 0n, data: encodeFunctionData({ abi: REGISTRY_ABI, functionName: 'createRegistry', args: [registryId, '0x0000000000000000000000000000000000000000'] }) });
}

if (calls.length === 0) {
  console.log('nothing to do — type declared, name primary, registry present');
} else {
  console.log(`submitting ${calls.length} calls in one userOp (declare type: ${!typeDeclared}, claim: ${owner === '0x0000000000000000000000000000000000000000'}, primary: ${primary !== node.toLowerCase()}, registry: ${!!registryId && !registryExists})`);
  // Nine calls (profile registration + typed claim + records + createRegistry) exceed the client's default
  // callGasLimit; an inner out-of-gas surfaces only as UserOperationEvent.success=false with no reason.
  const callGasLimit = BigInt(process.env.CALL_GAS_LIMIT ?? 3_000_000);
  const { userOp, userOpHash } = await accounts.buildCallUserOp({ sender: sa, callData: buildExecuteBatchCallData(calls), paymaster: d.smartAgentPaymaster, callGasLimit });
  userOp.signature = await custodian.signMessage({ message: { raw: userOpHash } });
  await accounts.submitCallUserOp(userOp, custodian);
}

const after = ((await pub.readContract({ address: d.agentNameRegistry, abi: agentNameRegistryAbi, functionName: 'primaryName', args: [sa] })) as Hex).toLowerCase();
const afterType = (await pub.readContract({ address: d.agentProfileResolver, abi: agentProfileResolverTypeAbi, functionName: 'getBytes32Property', args: [sa, PREDICATE_ID.agentType] })) as Hex;
const summary = { network: NETWORK, chainId, handle: HANDLE, agentType, serviceRole: SERVICE_ROLE ?? null, sa, custodian: custodian.address, primaryNameSet: after === node.toLowerCase(), typeDeclared: afterType.toLowerCase() === keccak256(toHex(agentType)).toLowerCase(), registryUrn: REGISTRY_URN || null, registryId };
console.log(JSON.stringify(summary, null, 2));
writeFileSync(join(REPO_ROOT, 'demo', `${HANDLE.replace(/[^a-z0-9.-]/g, '_')}.${NETWORK}.local.json`), JSON.stringify(summary, null, 2));
