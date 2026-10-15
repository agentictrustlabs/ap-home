// GIVE A DEMO ROSTER ONE NAME ACROSS THE FEDERATION — a second chain's personas were named with short labels
// (`maya.me`) while the root chain's names are the long ones (`maya-fernandes.me`); with nobody on the second chain the
// owner asked for the two to agree. A typed name is never released and the permissionless root allows one claim per
// account, so an account cannot simply claim again. What the registry DOES allow: the ROOT's owner (the deployer, on a
// `status: demo` chain) registers `<label>.me` directly to the account (`_requireParentAuth`: owner OR delegate), and the
// account then points the new node at itself, presents it as primary, carries its `atl:accounts` over, empties the old
// node's records and hands the old node to the root's owner, who EXPIRES it (`renew(node, 1)`): an expired record does
// not exist to the universal resolver (`recordExists` is false, so `resolveName` is nobody — NOT the owner, which is what
// an unpointed live node falls back to), the indexer skips it, and the parent may reclaim the label later. That is the
// registry's one release primitive, and it is the parent's act, never the account's.
//
//   npx tsx scripts/rename-personas-on-chain.mts \
//     --chain <roster.json>,<deployments.json>,<rpc with write token>            (the chain being cleaned)
//     --mirror <roster.json>,<deployments.json>,<rpc>                            (the chain whose names are copied)
//     --root-key-file ~/.<chain>-deployer.key [--tld me] [--only maya] [--dry-run]
import { readFileSync } from 'node:fs';
import { AgentAccountClient, buildExecuteBatchCallData } from '@agenticprimitives/agent-account';
import { AgentNamingClient, buildRecordCalls, buildSetPrimaryNameCall, namehash, parseAgentName } from '@agenticprimitives/agent-naming';
import { createPublicClient, createWalletClient, decodeEventLog, encodeFunctionData, http, keccak256, toBytes, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const argv = process.argv.slice(2);
const pick = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const [chainArg, mirrorArg, rootKeyFile] = [pick('chain'), pick('mirror'), (pick('root-key-file') ?? '').replace(/^~/, process.env.HOME ?? '')];
const tld = pick('tld') ?? 'me'; const only = (pick('only') ?? '').split(',').map((s) => s.trim()).filter(Boolean); const dry = argv.includes('--dry-run');
if (!chainArg || !mirrorArg || !rootKeyFile) { console.error('usage: --chain <roster>,<deployments>,<rpc> --mirror <roster>,<deployments>,<rpc> --root-key-file <file> [--tld me] [--only a,b] [--dry-run]'); process.exit(1); }

type Dep = { chainId: number; entryPoint: Address; agentAccountFactory: Address; agentNameRegistry: Address; agentNameResolver: Address; agentNameUniversalResolver: Address; smartAgentPaymaster: Address; permissionlessSubregistries: Record<string, Address> };
type Roster = Record<string, { sa: string; eoaPrivateKey: Hex; name?: string }>;
const load = (a: string) => { const [roster, depFile, rpc] = a.split(',') as [string, string, string]; const dep = JSON.parse(readFileSync(depFile, 'utf8')) as Dep; return { rpc, dep, roster: JSON.parse(readFileSync(roster, 'utf8')) as Roster, naming: new AgentNamingClient({ rpcUrl: rpc, chainId: dep.chainId, registry: dep.agentNameRegistry, universalResolver: dep.agentNameUniversalResolver }), pc: createPublicClient({ transport: http(rpc) }) }; };
const T = load(chainArg), M = load(mirrorArg);
const root = privateKeyToAccount(readFileSync(rootKeyFile, 'utf8').trim() as Hex);
const chain = { id: T.dep.chainId, name: `chain-${T.dep.chainId}`, nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [T.rpc] } } } as const;
const rootWallet = createWalletClient({ account: root, chain, transport: http(T.rpc) });
const account = new AgentAccountClient({ rpcUrl: T.rpc, chainId: T.dep.chainId, entryPoint: T.dep.entryPoint, factory: T.dep.agentAccountFactory });

const P = { addr: keccak256(toBytes('atl:addr')), agentKind: keccak256(toBytes('atl:agentKind')), displayName: keccak256(toBytes('atl:displayName')), accounts: keccak256(toBytes('atl:accounts')) };
const REGISTRY_ABI = [
  { type: 'function', name: 'owner', stateMutability: 'view', inputs: [{ name: 'node', type: 'bytes32' }], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'register', stateMutability: 'nonpayable', inputs: [{ name: 'parentNode', type: 'bytes32' }, { name: 'label', type: 'string' }, { name: 'newOwner', type: 'address' }, { name: 'resolverContract', type: 'address' }, { name: 'expiry', type: 'uint64' }], outputs: [{ type: 'bytes32' }] },
  { type: 'function', name: 'setOwner', stateMutability: 'nonpayable', inputs: [{ name: 'node', type: 'bytes32' }, { name: 'newOwner', type: 'address' }], outputs: [] },
  { type: 'function', name: 'renew', stateMutability: 'nonpayable', inputs: [{ name: 'node', type: 'bytes32' }, { name: 'newExpiry', type: 'uint64' }], outputs: [] },
] as const;
const RESOLVER_ABI = [
  { type: 'function', name: 'getStringArr', stateMutability: 'view', inputs: [{ name: 'subject', type: 'bytes32' }, { name: 'predicate', type: 'bytes32' }], outputs: [{ type: 'string[]' }] },
  { type: 'function', name: 'setStringArrayAttribute', stateMutability: 'nonpayable', inputs: [{ name: 'node', type: 'bytes32' }, { name: 'predicate', type: 'bytes32' }, { name: 'values', type: 'string[]' }], outputs: [] },
  { type: 'function', name: 'unsetAttribute', stateMutability: 'nonpayable', inputs: [{ name: 'node', type: 'bytes32' }, { name: 'predicate', type: 'bytes32' }], outputs: [] },
] as const;
const SUBREG_ABI = [{ type: 'function', name: 'DEFAULT_RESOLVER', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] }] as const;
const OP_EVENT = { type: 'event', name: 'UserOperationEvent', inputs: [{ name: 'userOpHash', type: 'bytes32', indexed: true }, { name: 'sender', type: 'address', indexed: true }, { name: 'paymaster', type: 'address', indexed: true }, { name: 'nonce', type: 'uint256' }, { name: 'success', type: 'bool' }, { name: 'actualGasCost', type: 'uint256' }, { name: 'actualGasUsed', type: 'uint256' }] } as const;
const ZERO = '0x0000000000000000000000000000000000000000';

const parent = namehash(tld);
const rootOwner = await T.pc.readContract({ address: T.dep.agentNameRegistry, abi: REGISTRY_ABI, functionName: 'owner', args: [parent] });
if (rootOwner.toLowerCase() !== root.address.toLowerCase()) { console.error(`the .${tld} root on chain ${T.dep.chainId} is owned by ${rootOwner}, not the key given (${root.address}) — only the root's owner may register under it directly`); process.exit(1); }
const defaultResolver = await T.pc.readContract({ address: T.dep.permissionlessSubregistries[tld]!, abi: SUBREG_ABI, functionName: 'DEFAULT_RESOLVER' });
console.log(`chain ${T.dep.chainId} ← names from chain ${M.dep.chainId} · .${tld} root owner ${root.address} · resolver ${defaultResolver}${dry ? ' · DRY RUN' : ''}`);

let renamed = 0, same = 0;
for (const [h, p] of Object.entries(T.roster)) {
  if (only.length && !only.includes(h)) continue;
  const m = M.roster[h]; if (!m) { console.log(`${h.padEnd(8)} not in the mirror roster — skipped`); continue; }
  if (privateKeyToAccount(m.eoaPrivateKey).address !== privateKeyToAccount(p.eoaPrivateKey).address) { console.error(`${h}: different custodian keys on the two chains — not the same person`); process.exit(1); }
  const agent = p.sa as Address; const custodian = privateKeyToAccount(p.eoaPrivateKey);
  const want = await M.naming.reverseResolve(m.sa as Address).catch(() => null);
  if (!want) { console.log(`${h.padEnd(8)} presents no name on the mirror chain — nothing to copy`); continue; }
  const have = await T.naming.reverseResolve(agent).catch(() => null);
  if (have === want) { console.log(`${h.padEnd(8)} already presents ${want} here`); same++; continue; }
  const label = parseAgentName(want).handle?.label; if (!label || parseAgentName(want).handle?.tld !== tld) { console.error(`${h}: mirror name ${want} is not a .${tld} name`); process.exit(1); }
  const newNode = namehash(want); const oldNode = have ? namehash(have) : null;
  const newOwner = await T.pc.readContract({ address: T.dep.agentNameRegistry, abi: REGISTRY_ABI, functionName: 'owner', args: [newNode] }).catch(() => ZERO as Address);
  if (newOwner !== ZERO && newOwner.toLowerCase() !== agent.toLowerCase()) { console.error(`${h}: ${want} already belongs to ${newOwner} on this chain — not touching it`); process.exit(1); }
  const accounts = oldNode ? (await T.pc.readContract({ address: T.dep.agentNameResolver, abi: RESOLVER_ABI, functionName: 'getStringArr', args: [oldNode, P.accounts] }).catch(() => [])) as readonly string[] : [];
  console.log(`${h.padEnd(8)} ${agent}: ${have ?? '(no name)'} → ${want}${newOwner === ZERO ? ' (root registers it)' : ' (already registered to the account)'}${accounts.length ? `; carries atl:accounts [${accounts.join(', ')}]` : ''}${oldNode ? `; ${have} emptied and handed to the root owner` : ''}${dry ? ' — would do' : ''}`);
  if (dry) continue;
  if (newOwner === ZERO) {
    const tx = await rootWallet.writeContract({ address: T.dep.agentNameRegistry, abi: REGISTRY_ABI, functionName: 'register', args: [parent, label, agent, defaultResolver, 0n] });
    const r = await T.pc.waitForTransactionReceipt({ hash: tx }); if (r.status !== 'success') { console.error(`  register reverted (tx ${tx})`); process.exit(1); }
    console.log(`  ${want} registered to ${agent} by the root owner (tx ${tx})`);
  }
  const rec = buildRecordCalls({ resolver: T.dep.agentNameResolver, node: newNode, records: { addr: agent, agentKind: 'person', ...(p.name ? { displayName: p.name } : {}) } });
  const calls = [...rec, buildSetPrimaryNameCall({ registry: T.dep.agentNameRegistry, node: newNode })];
  if (accounts.length) calls.push({ to: T.dep.agentNameResolver, value: 0n, data: encodeFunctionData({ abi: RESOLVER_ABI, functionName: 'setStringArrayAttribute', args: [newNode, P.accounts, [...accounts]] }) });
  if (oldNode) {
    for (const pred of [P.addr, P.agentKind, P.displayName, P.accounts]) calls.push({ to: T.dep.agentNameResolver, value: 0n, data: encodeFunctionData({ abi: RESOLVER_ABI, functionName: 'unsetAttribute', args: [oldNode, pred] }) });
    calls.push({ to: T.dep.agentNameRegistry, value: 0n, data: encodeFunctionData({ abi: REGISTRY_ABI, functionName: 'setOwner', args: [oldNode, root.address] }) });
  }
  const callData = buildExecuteBatchCallData(calls);
  const estimate = await T.pc.estimateGas({ account: T.dep.entryPoint, to: agent, data: callData });
  const built = await account.buildCallUserOp({ sender: agent, callData, paymaster: T.dep.smartAgentPaymaster, callGasLimit: (estimate * 125n) / 100n });
  built.userOp.signature = await custodian.signMessage({ message: { raw: built.userOpHash } });
  const { receipt } = await account.submitCallUserOp(built.userOp, root);
  let ok: boolean | undefined;
  for (const log of receipt.logs) { try { const ev = decodeEventLog({ abi: [OP_EVENT], data: log.data, topics: log.topics }); if (ev.eventName === 'UserOperationEvent' && String(ev.args.sender).toLowerCase() === agent.toLowerCase()) ok = ev.args.success; } catch { /* another event */ } }
  if (receipt.status !== 'success') { console.error(`  handleOps reverted (tx ${receipt.transactionHash}) — validation; check the paymaster's EntryPoint deposit`); process.exit(1); }
  if (ok !== true) { console.error(`  the batch ${ok === false ? 'reverted inside the account' : 'left no UserOperationEvent'} (tx ${receipt.transactionHash})`); process.exit(1); }
  if (oldNode) {
    const tx = await rootWallet.writeContract({ address: T.dep.agentNameRegistry, abi: REGISTRY_ABI, functionName: 'renew', args: [oldNode, 1n] });
    const r = await T.pc.waitForTransactionReceipt({ hash: tx }); if (r.status !== 'success') { console.error(`  expiring ${have} reverted (tx ${tx})`); process.exit(1); }
  }
  const after = await T.naming.reverseResolve(agent).catch(() => null);
  const oldResolves = oldNode ? await T.naming.resolveName(have!).catch(() => null) : null;
  if (after !== want || (oldNode && oldResolves && oldResolves !== ZERO)) { console.error(`  read-back: presents ${after ?? '""'}; ${have} resolves ${oldResolves} (tx ${receipt.transactionHash})`); process.exit(1); }
  console.log(`  ${agent} presents ${want}; ${have ?? '—'} expired, resolves nobody (tx ${receipt.transactionHash})`); renamed++;
}
console.log(`\ndone — ${renamed} renamed, ${same} already right.`);
