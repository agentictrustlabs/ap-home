#!/usr/bin/env -S npx tsx
/** Give one Home its own gate. Addresses come from the pinned deployment, never a prior generation.
 * NAMING_CLERK_PRIVATE_KEY is supplied by the town's protected build environment, or --clerk-key-file
 * by an operator. The clerk key is never written to the estate file or printed.
 */
import { createPublicClient, http, parseAbi, encodeFunctionData, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { readFileSync, existsSync } from 'node:fs';
import { buildExecuteBatchCallData } from '@agenticprimitives/agent-account';
import { AgentNamingClient } from '@agenticprimitives/agent-naming';
import { getDeployments } from '@agenticprimitives/contracts/deployments';
import { loadTown } from './estate-oneclick/town.mts';
import { ensureNamingGate } from './estate-oneclick/naming-gate.mts';

const arg = (n: string) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
const estate = arg('--estate');
if (!estate || !/^[a-z][a-z0-9-]{1,30}$/.test(estate)) throw new Error('--estate <id> is required');
const checkOnly = process.argv.includes('--check');
const town = loadTown();
const file = `.estate-${estate}.local`;
const raw = existsSync(file) ? readFileSync(file, 'utf8') : '';
const vars = Object.fromEntries(raw.split('\n').filter((s) => /^[A-Z_]+=/.test(s)).map((s) => {
  const i = s.indexOf('='); const v = s.slice(i + 1).trim();
  return [s.slice(0, i), v.startsWith('"') ? JSON.parse(v) : v.startsWith("'") ? v.slice(1, -1) : v];
}));
const rpc = process.env.TOWN_RPC_URL || vars.RPC_URL;
if (!rpc) throw new Error('TOWN_RPC_URL or the estate RPC_URL is required');
const d = getDeployments(town.chain.name as Parameters<typeof getDeployments>[0]) as ReturnType<typeof getDeployments> & {
  pricedSubregistries?: Record<string, Address>; contractsGeneration?: number | string;
};
const priced = d.pricedSubregistries as Record<string, Address>;
if (Number(d.chainId) !== town.chain.id || !priced || !Object.keys(priced).length) throw new Error('no matching priced deployment');
const pc = createPublicClient({ transport: http(rpc, { retryCount: 0 }) });
if (await pc.getChainId() !== town.chain.id) throw new Error('RPC chain does not match the town');
const naming = new AgentNamingClient({ rpcUrl: rpc, chainId: town.chain.id, registry: d.agentNameRegistry, universalResolver: d.agentNameUniversalResolver });
const governor = await naming.resolveName('naming.svc');
if (!governor) throw new Error('naming.svc is not registered on this deployment');
const abi = parseAbi(['function gates(address) view returns (bool)', 'function governor() view returns (address)', 'function setGate(address,bool)', 'function isCustodian(address) view returns (bool)']);
const roots = await Promise.all(Object.entries(priced).map(async ([tld, address]) => {
  const owner = await pc.readContract({ address, abi, functionName: 'governor' });
  if (owner.toLowerCase() !== governor.toLowerCase()) throw new Error(`.${tld} is not governed by this deployment's naming.svc`);
  return { tld, address };
}));
let gate = arg('--gate') as Address | undefined;
if (gate && !/^0x[0-9a-fA-F]{40}$/.test(gate)) throw new Error('--gate must be an address');
if (!gate) {
  let key = vars.NAMING_GATE_PRIVATE_KEY as Hex | undefined;
  if (!key) {
    if (checkOnly) throw new Error('no estate naming gate has been provisioned');
    key = ensureNamingGate(file).key;
  }
  gate = privateKeyToAccount(key).address;
}
const missing = async () => (await Promise.all(roots.map(async (root) => ({ ...root, allowed: await pc.readContract({ address: root.address, abi, functionName: 'gates', args: [gate!] }) })))).filter((r) => !r.allowed);
const todo = await missing();
console.log(JSON.stringify({ estate, chainId: town.chain.id, generation: d.contractsGeneration, gate, governor, missing: todo.map((r) => r.tld) }));
if (!todo.length) { console.log(`verified: gate approved on all ${roots.length} priced roots`); process.exit(0); }
if (checkOnly) throw new Error('the gate is not approved on every priced root');
const keyFile = arg('--clerk-key-file');
const key = process.env.NAMING_CLERK_PRIVATE_KEY || (keyFile ? JSON.parse(readFileSync(keyFile, 'utf8')).privateKey : '');
if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error('the town clerk key is required (NAMING_CLERK_PRIVATE_KEY or --clerk-key-file)');
const clerk = privateKeyToAccount(key as Hex);
if (!await pc.readContract({ address: governor, abi, functionName: 'isCustodian', args: [clerk.address] })) throw new Error('the supplied key does not custody naming.svc');
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
const callData = buildExecuteBatchCallData(todo.map(({ address }) => ({ to: address, value: 0n, data: encodeFunctionData({ abi, functionName: 'setGate', args: [gate!, true] }) })));
const built = await post('/account/build-call-userop', { sender: governor, callData });
const signature = await clerk.signMessage({ message: { raw: built.userOpHash as Hex } });
const submitted = await post('/account/submit-call-userop', { userOp: { ...built.userOp, signature } });
if (!submitted.transactionHash) throw new Error('the town relayer returned no transaction hash');
console.log(`setGate transaction: ${submitted.transactionHash}`);
for (let i = 0; i < 15; i++) {
  if (!(await missing()).length) { console.log(`verified: gate approved on all ${roots.length} priced roots`); process.exit(0); }
  await new Promise((resolve) => setTimeout(resolve, 1500));
}
throw new Error('gate approval is not visible on every root; re-run to verify before enabling the Home');
