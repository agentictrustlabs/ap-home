// LINK A PERSON'S ACCOUNTS ACROSS CHAINS — ap-federation spec 440 §C3 step 3 / Ring 0 spec 346 §3.8, done by hand for a
// demo roster. The same person is a DIFFERENT Smart Agent on each chain (CREATE2 over a per-chain factory, same custodian),
// and until this record exists the root chain's name says nothing about the other chain: faithchain's `maya-fernandes.me`
// could not resolve her hopechain account. `atl:accounts` on a name is the CAIP-10 id of that person's account on each
// chain, one per chain, written by the name's owner. This writes the SAME list on the person's name on EVERY chain the
// rosters cover, so a reader on either side finds the other (`accountForChain(records, 'eip155:<id>')`).
//
// A record is evidence, never authority: nothing here grants anything, and the custodian key that signs on each chain
// is the one the person already holds there. The predicate must be registered on the chain's OntologyTermRegistry
// (Ring 0 `script/AddAccountsPredicate.s.sol`; `PredicateNotActive` 0x898efc7c is the revert when it is not).
//
//   npx tsx scripts/link-persona-accounts.mts \
//     --chain <roster.json>,<deployments.json>,<rpc with write token> \
//     --chain <roster.json>,<deployments.json>,<rpc with write token> \
//     --relay-key-file ~/.<chain>-deployer.key [--only maya,samuel] [--dry-run]
import { readFileSync } from 'node:fs';
import { AgentAccountClient, buildExecuteCallData } from '@agenticprimitives/agent-account';
import { AgentNamingClient, namehash } from '@agenticprimitives/agent-naming';
import { createPublicClient, decodeEventLog, encodeFunctionData, http, keccak256, toBytes, type Address, type Hex } from 'viem';

// The published pin (agent-naming alpha.34) predates the `atl:accounts` SDK half (Ring 0 spec 346 §3.8: `encodeAccounts`,
// `accountForChain`, `PREDICATE_ID.accounts`, the string[] resolver ABI). These are that half, verbatim in rule, until the
// next alpha carries them — then delete this block and import them.
const ACCOUNTS_PREDICATE = keccak256(toBytes('atl:accounts'));
const CAIP10 = /^([a-z0-9]{3,8}):([-_a-zA-Z0-9]{1,32}):(0x[0-9a-fA-F]{40})$/;
function encodeAccounts(accounts: readonly string[]): string[] {
  const byChain = new Map<string, string>();
  for (const raw of accounts) {
    const m = CAIP10.exec(raw.trim()); if (!m || m[1] !== 'eip155') throw new Error(`accounts: "${raw}" is not an eip155 CAIP-10 id`);
    const chain = `${m[1]}:${m[2]}`; if (byChain.has(chain)) throw new Error(`accounts: two entries for ${chain} — a name has one account per chain`);
    byChain.set(chain, `${chain}:${m[3]!.toLowerCase()}`);
  }
  return [...byChain.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, v]) => v);
}
const accountForChain = (accounts: readonly string[], chain: string) => accounts.find((a) => a.toLowerCase().startsWith(`${chain.toLowerCase()}:`)) ?? null;
const RESOLVER_ABI = [
  { type: 'function', name: 'setStringArrayAttribute', stateMutability: 'nonpayable', inputs: [{ name: 'node', type: 'bytes32' }, { name: 'predicate', type: 'bytes32' }, { name: 'values', type: 'string[]' }], outputs: [] },
  { type: 'function', name: 'getStringArr', stateMutability: 'view', inputs: [{ name: 'subject', type: 'bytes32' }, { name: 'predicate', type: 'bytes32' }], outputs: [{ type: 'string[]' }] },
] as const;
import { privateKeyToAccount } from 'viem/accounts';

const argv = process.argv.slice(2);
const chainArgs: string[] = []; let relayFile = ''; let only: string[] = []; const dry = argv.includes('--dry-run');
for (let i = 0; i < argv.length; i++) { if (argv[i] === '--chain') chainArgs.push(argv[++i]!); else if (argv[i] === '--relay-key-file') relayFile = argv[++i]!.replace(/^~/, process.env.HOME ?? ''); else if (argv[i] === '--only') only = argv[++i]!.split(',').map((s) => s.trim()).filter(Boolean); }
if (chainArgs.length < 2 || !relayFile) { console.error('usage: --chain <roster>,<deployments>,<rpc> (twice or more) --relay-key-file <file> [--only a,b] [--dry-run]'); process.exit(1); }
const relay = privateKeyToAccount(readFileSync(relayFile, 'utf8').trim() as Hex);

type Dep = { chainId: number; entryPoint: Address; agentAccountFactory: Address; agentNameRegistry: Address; agentNameResolver: Address; agentNameUniversalResolver: Address; smartAgentPaymaster: Address };
type Roster = Record<string, { sa: string; eoaPrivateKey: Hex }>;
const chains = chainArgs.map((a) => {
  const [roster, depFile, rpc] = a.split(',') as [string, string, string];
  const dep = JSON.parse(readFileSync(depFile, 'utf8')) as Dep;
  return { rpc, dep, roster: JSON.parse(readFileSync(roster, 'utf8')) as Roster, caip2: `eip155:${dep.chainId}`,
    pc: createPublicClient({ transport: http(rpc) }),
    account: new AgentAccountClient({ rpcUrl: rpc, chainId: dep.chainId, entryPoint: dep.entryPoint, factory: dep.agentAccountFactory }),
    naming: new AgentNamingClient({ rpcUrl: rpc, chainId: dep.chainId, registry: dep.agentNameRegistry, universalResolver: dep.agentNameUniversalResolver }) };
});
const OP_EVENT = { type: 'event', name: 'UserOperationEvent', inputs: [{ name: 'userOpHash', type: 'bytes32', indexed: true }, { name: 'sender', type: 'address', indexed: true }, { name: 'paymaster', type: 'address', indexed: true }, { name: 'nonce', type: 'uint256' }, { name: 'success', type: 'bool' }, { name: 'actualGasCost', type: 'uint256' }, { name: 'actualGasUsed', type: 'uint256' }] } as const;

// The people every roster names — a person missing from one chain's roster has no account there and is not linked.
const handles = Object.keys(chains[0]!.roster).filter((h) => chains.every((c) => c.roster[h]) && (!only.length || only.includes(h)));
console.log(`${chains.map((c) => c.caip2).join(' ↔ ')} · ${handles.length} person(s) · relay ${relay.address}${dry ? ' · DRY RUN' : ''}`);
let wrote = 0, same = 0;
for (const h of handles) {
  // The custodian is the person: one key, one account per chain. Refuse a roster whose keys disagree.
  const custodians = new Set(chains.map((c) => privateKeyToAccount(c.roster[h]!.eoaPrivateKey).address.toLowerCase()));
  if (custodians.size !== 1) { console.error(`${h}: the rosters hold different custodian keys for this person — not the same person, not linked`); process.exit(1); }
  const accounts = encodeAccounts(chains.map((c) => `${c.caip2}:${c.roster[h]!.sa}`));
  for (const c of chains) {
    const agent = c.roster[h]!.sa as Address;
    const name = await c.naming.reverseResolve(agent).catch(() => null);
    if (!name) { console.log(`${h.padEnd(8)} ${c.caip2}: ${agent} presents no name here — nothing to write the record on`); continue; }
    const node = namehash(name);
    const current = (await c.pc.readContract({ address: c.dep.agentNameResolver, abi: RESOLVER_ABI, functionName: 'getStringArr', args: [node, ACCOUNTS_PREDICATE] }).catch(() => [])) as readonly string[];
    if (current.length === accounts.length && current.every((v, i) => v === accounts[i])) { console.log(`${h.padEnd(8)} ${c.caip2}: ${name} already links ${accounts.join(' + ')}`); same++; continue; }
    console.log(`${h.padEnd(8)} ${c.caip2}: ${name} ← atl:accounts [${accounts.join(', ')}]${current.length ? ` (replacing [${current.join(', ')}])` : ''}${dry ? ' — would write' : ''}`);
    if (dry) continue;
    const data = encodeFunctionData({ abi: RESOLVER_ABI, functionName: 'setStringArrayAttribute', args: [node, ACCOUNTS_PREDICATE, accounts] });
    const callData = buildExecuteCallData({ to: c.dep.agentNameResolver, value: 0n, data });
    const estimate = await c.pc.estimateGas({ account: c.dep.entryPoint, to: agent, data: callData });
    const built = await c.account.buildCallUserOp({ sender: agent, callData, paymaster: c.dep.smartAgentPaymaster, callGasLimit: (estimate * 125n) / 100n });
    built.userOp.signature = await privateKeyToAccount(c.roster[h]!.eoaPrivateKey).signMessage({ message: { raw: built.userOpHash } });
    const { receipt } = await c.account.submitCallUserOp(built.userOp, relay);
    let ok: boolean | undefined;
    for (const log of receipt.logs) { try { const ev = decodeEventLog({ abi: [OP_EVENT], data: log.data, topics: log.topics }); if (ev.eventName === 'UserOperationEvent' && String(ev.args.sender).toLowerCase() === agent.toLowerCase()) ok = ev.args.success; } catch { /* another event */ } }
    if (receipt.status !== 'success') { console.error(`  handleOps reverted (tx ${receipt.transactionHash}) — validation; check the paymaster's EntryPoint deposit`); process.exit(1); }
    if (ok !== true) { console.error(`  the write ${ok === false ? 'reverted inside the account' : 'left no UserOperationEvent'} (tx ${receipt.transactionHash})`); process.exit(1); }
    const after = (await c.pc.readContract({ address: c.dep.agentNameResolver, abi: RESOLVER_ABI, functionName: 'getStringArr', args: [node, ACCOUNTS_PREDICATE] })) as readonly string[];
    for (const o of chains) { const want = `${o.caip2}:${o.roster[h]!.sa.toLowerCase()}`; if (accountForChain(after, o.caip2) !== want) { console.error(`  read-back: ${name} does not resolve ${o.caip2} to ${want}`); process.exit(1); } }
    console.log(`  written (tx ${receipt.transactionHash}); ${name} now resolves ${chains.map((o) => o.caip2).join(' and ')}`); wrote++;
  }
}
console.log(`\ndone — ${wrote} record(s) written, ${same} already current.`);
