#!/usr/bin/env -S npx tsx
/** Register `<estate>.<estate root>` to that estate's own agent, as the town.
 *
 * Only a root's owner or its subregistry delegate may register a child. When the estate root's delegate is
 * `naming.svc` (the town's naming agent), the town clerk signs the registration through the town relayer, exactly as
 * add-naming-gate.mts approves a gate, so a build needs no deployer key and no contracts checkout. The root's owner
 * delegates once with setSubregistry and keeps the root: the delegate can register children and nothing else, and
 * the owner can take the delegation back. Until then, or when the clerk key does not custody naming.svc, this
 * script changes nothing and exits 3.
 *
 * A name that already exists is never moved: it is verified to point at the given agent, or the script fails.
 * NAMING_CLERK_PRIVATE_KEY comes from the town's protected build environment, or --clerk-key-file from an operator.
 * The clerk key is never written or printed.
 *
 * --check only reads: it prints the registry it read, the root's owner and delegate, naming.svc, and (given the clerk
 * key) whether that key custodies naming.svc. It never fails because the name is free.
 *
 *   npx tsx scripts/add-estate-name.mts --estate <id> --agent 0x<estate agent> [--check] [--clerk-key-file <file>]
 */
import { createPublicClient, http, parseAbi, encodeFunctionData, encodePacked, keccak256, toBytes, zeroHash, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { readFileSync, existsSync } from 'node:fs';
import { buildExecuteBatchCallData } from '@agenticprimitives/agent-account';
import { AgentNamingClient } from '@agenticprimitives/agent-naming';
import { getDeployments } from '@agenticprimitives/contracts/deployments';
import { loadTown } from './estate-oneclick/town.mts';

/** naming.svc may not register here, or the clerk cannot sign for it: nothing was changed and an operator must act. */
const NOT_DELEGATED = 3;

const arg = (n: string) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
const estate = arg('--estate');
if (!estate || !/^[a-z][a-z0-9-]{1,30}$/.test(estate)) throw new Error('--estate <id> is required');
const agent = arg('--agent') as Address | undefined;
if (!agent || !/^0x[0-9a-fA-F]{40}$/.test(agent)) throw new Error('--agent <the estate agent address> is required');
const checkOnly = process.argv.includes('--check');
const town = loadTown();
const tld = town.estateNameRoot;
const file = `.estate-${estate}.local`;
const raw = existsSync(file) ? readFileSync(file, 'utf8') : '';
const estateRpc = /^RPC_URL=(.*)$/m.exec(raw)?.[1]?.trim().replace(/^(['"])(.*)\1$/, '$2');
const rpc = process.env.TOWN_RPC_URL || estateRpc;
if (!rpc) throw new Error('TOWN_RPC_URL or the estate RPC_URL is required');
const d = getDeployments(town.chain.name as Parameters<typeof getDeployments>[0]) as ReturnType<typeof getDeployments> & { agentNameResolver?: Address; contractsGeneration?: number | string };
if (Number(d.chainId) !== town.chain.id) throw new Error('the pinned deployment is not this town\'s chain');
const resolver = d.agentNameResolver;
if (!resolver) throw new Error('the pinned deployment names no agent name resolver');
const pc = createPublicClient({ transport: http(rpc, { retryCount: 0 }) });
if (await pc.getChainId() !== town.chain.id) throw new Error('RPC chain does not match the town');

const registry = d.agentNameRegistry as Address;
const abi = parseAbi([
  'function recordExists(bytes32) view returns (bool)',
  'function owner(bytes32) view returns (address)',
  'function subregistry(bytes32) view returns (address)',
  'function register(bytes32 parentNode, string label, address newOwner, address resolverContract, uint64 expiry) returns (bytes32)',
  'function isCustodian(address) view returns (bool)',
]);
const read = <T,>(functionName: 'recordExists' | 'owner' | 'subregistry', node: Hex) => pc.readContract({ address: registry, abi, functionName, args: [node] }) as Promise<T>;
// The registry's own derivation (namehashRoot, then parent + labelhash), not a precomputed value.
const root = keccak256(encodePacked(['bytes32', 'bytes32'], [zeroHash, keccak256(toBytes(tld))]));
const child = keccak256(encodePacked(['bytes32', 'bytes32'], [root, keccak256(toBytes(estate))]));
const name = `${estate}.${tld}`;
if (!await read<boolean>('recordExists', root)) throw new Error(`.${tld} is not a root on this deployment`);

/** null when the name is free; true when it points at this agent. A name pointing elsewhere is an error, never moved. */
const registered = async (): Promise<true | null> => {
  if (!await read<boolean>('recordExists', child)) return null;
  const owner = await read<Address>('owner', child);
  if (owner.toLowerCase() !== agent.toLowerCase()) throw new Error(`${name} is already registered to ${owner}; an estate name is never moved`);
  return true;
};
const naming = new AgentNamingClient({ rpcUrl: rpc, chainId: town.chain.id, registry, universalResolver: d.agentNameUniversalResolver });
const governor = await naming.resolveName('naming.svc');
if (!governor) throw new Error('naming.svc is not registered on this deployment');
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const rootOwner = await read<Address>('owner', root);
const rootDelegate = await read<Address>('subregistry', root);
const delegated = same(rootOwner, governor) || same(rootDelegate, governor);
const keyFile = arg('--clerk-key-file');
const key = process.env.NAMING_CLERK_PRIVATE_KEY || (keyFile ? JSON.parse(readFileSync(keyFile, 'utf8')).privateKey : '');
if (key && !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error('the town clerk key is malformed');
const clerk = key ? privateKeyToAccount(key as Hex) : null;
const clerkCustodies = clerk ? await pc.readContract({ address: governor, abi, functionName: 'isCustodian', args: [clerk.address] }) : null;
const already = await registered();
// Everything a person needs to act on, read from ONE deployment: the registry named here is the one every address
// below was read from. A checkout with an older contracts pin names an older registry and an older naming.svc.
console.log(JSON.stringify({
  estate, name, agent, chainId: town.chain.id, generation: d.contractsGeneration, registry, root,
  rootOwner, rootDelegate, namingSvc: governor, namingSvcMayRegister: delegated,
  clerk: clerk?.address ?? null, clerkCustodiesNamingSvc: clerkCustodies, registered: already === true,
}, null, 1));
if (already) { console.log(`verified: ${name} -> ${agent}`); process.exit(0); }
if (checkOnly) {
  console.log(delegated && clerkCustodies ? `ready: ${name} is free and the clerk can register it` : `not ready: ${name} is free, but see namingSvcMayRegister and clerkCustodiesNamingSvc above`);
  process.exit(0);
}
if (!delegated) {
  console.error(`naming.svc (${governor}) may not register under .${tld}: the root's owner is ${rootOwner} and its delegate is ${rootDelegate}. The owner delegates once, on registry ${registry} (generation ${d.contractsGeneration}): setSubregistry(${root}, ${governor}). It keeps the root and can undo this. Until then each estate name is registered by the owner.`);
  process.exit(NOT_DELEGATED);
}
if (!clerk) throw new Error('the town clerk key is required (NAMING_CLERK_PRIVATE_KEY or --clerk-key-file)');
if (!clerkCustodies) {
  console.error(`the supplied clerk key (${clerk.address}) does not custody naming.svc (${governor}), so the town cannot sign this registration.`);
  process.exit(NOT_DELEGATED);
}

const home = town.namingGate.relayerHome.replace(/\/$/, '');
const csrfRes = await fetch(`${home}/a2a/auth/csrf`, { headers: { origin: home } });
const csrf = await csrfRes.json() as { token?: string };
if (!csrfRes.ok || !csrf.token) throw new Error('the town relayer did not issue a CSRF token');
const headers = { 'content-type': 'application/json', origin: home, cookie: (csrfRes.headers.get('set-cookie') ?? '').split(';')[0], 'x-csrf-token': csrf.token };
const post = async (path: string, body: unknown) => {
  const r = await fetch(`${home}/a2a${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const result = await r.json() as Record<string, any>;
  if (!r.ok || !result.ok) throw new Error(`${path}: ${r.status} ${String(result.error ?? 'refused')}`);
  return result;
};
// expiry 0 = never: an estate is not a subscription, and a lapsed estate name would orphan every record pointing at it.
const callData = buildExecuteBatchCallData([{ to: registry, value: 0n, data: encodeFunctionData({ abi, functionName: 'register', args: [root, estate, agent, resolver, 0n] }) }]);
const built = await post('/account/build-call-userop', { sender: governor, callData });
const signature = await clerk.signMessage({ message: { raw: built.userOpHash as Hex } });
const submitted = await post('/account/submit-call-userop', { userOp: { ...built.userOp, signature } });
if (!submitted.transactionHash) throw new Error('the town relayer returned no transaction hash');
console.log(`register transaction: ${submitted.transactionHash}`);
// The relayer's transaction succeeds even when the call inside the account reverted, so read the name back.
for (let i = 0; i < 15; i++) {
  if (await registered()) { console.log(`verified: ${name} -> ${agent}`); process.exit(0); }
  await new Promise((resolve) => setTimeout(resolve, 1500));
}
throw new Error(`${name} is not visible on chain; re-run to verify before listing the estate`);
