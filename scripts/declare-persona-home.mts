// DECLARE WHICH ACCOUNT IS HOME — `atl:nativeId` on a person's name on EVERY chain names the account their Home and custody
// live on, as a CAIP-10 id. `atl:accounts` lists a person's accounts with no roles, so after a move a reader could tell both
// accounts were hers and nothing said which was canonical (the root name still points at the faithchain account she started
// with). The record is written by the name's owner on each chain and names the SAME account everywhere; a reader takes
// `nativeId` as "who this is" and the chain's own `addr` as "who signs here" — authority never crosses a chain on the strength
// of it. Not built here, and said: the satellite's own ERC-1271 proof and custody propagation (spec 440 §C3 / Ring 0 §3.2 item 7).
//
//   npx tsx scripts/declare-persona-home.mts --home <roster>,<deployments>,<rpc with write token> \
//     --chain <roster>,<deployments>,<rpc with write token> [--chain …] --relay-key-file <file> [--only a,b] [--dry-run]
import { readFileSync } from 'node:fs';
import { AgentAccountClient, buildExecuteBatchCallData } from '@agenticprimitives/agent-account';
import { AgentNamingClient, buildRecordCalls, namehash, type AgentNameRecords } from '@agenticprimitives/agent-naming';
import { createPublicClient, decodeEventLog, http, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const argv = process.argv.slice(2);
const chainArgs: string[] = []; let homeArg = ''; let relayFile = ''; let only: string[] = []; const dry = argv.includes('--dry-run');
for (let i = 0; i < argv.length; i++) { if (argv[i] === '--chain') chainArgs.push(argv[++i]!); else if (argv[i] === '--home') homeArg = argv[++i]!; else if (argv[i] === '--relay-key-file') relayFile = argv[++i]!.replace(/^~/, process.env.HOME ?? ''); else if (argv[i] === '--only') only = argv[++i]!.split(',').map((s) => s.trim()).filter(Boolean); }
if (!homeArg || !relayFile) { console.error('usage: --home <roster>,<deployments>,<rpc> [--chain <roster>,<deployments>,<rpc> …] --relay-key-file <file> [--only a,b] [--dry-run]'); process.exit(1); }
type Dep = { chainId: number; entryPoint: Address; agentAccountFactory: Address; agentNameRegistry: Address; agentNameResolver: Address; agentNameUniversalResolver: Address; smartAgentPaymaster: Address };
type Roster = Record<string, { sa: string; eoaPrivateKey: Hex }>;
const load = (a: string) => { const [roster, depFile, rpc] = a.split(',') as [string, string, string]; const dep = JSON.parse(readFileSync(depFile, 'utf8')) as Dep; return { rpc, dep, roster: JSON.parse(readFileSync(roster, 'utf8')) as Roster, caip2: `eip155:${dep.chainId}`, pc: createPublicClient({ transport: http(rpc) }), account: new AgentAccountClient({ rpcUrl: rpc, chainId: dep.chainId, entryPoint: dep.entryPoint, factory: dep.agentAccountFactory }), naming: new AgentNamingClient({ rpcUrl: rpc, chainId: dep.chainId, registry: dep.agentNameRegistry, universalResolver: dep.agentNameUniversalResolver }) }; };
const home = load(homeArg); const chains = [home, ...chainArgs.map(load)];
const relay = privateKeyToAccount(readFileSync(relayFile, 'utf8').trim() as Hex);
const OP_EVENT = { type: 'event', name: 'UserOperationEvent', inputs: [{ name: 'userOpHash', type: 'bytes32', indexed: true }, { name: 'sender', type: 'address', indexed: true }, { name: 'paymaster', type: 'address', indexed: true }, { name: 'nonce', type: 'uint256' }, { name: 'success', type: 'bool' }, { name: 'actualGasCost', type: 'uint256' }, { name: 'actualGasUsed', type: 'uint256' }] } as const;

console.log(`home chain ${home.caip2}; declared on ${chains.map((c) => c.caip2).join(', ')} · relay ${relay.address}${dry ? ' · DRY RUN' : ''}`);
let wrote = 0, same = 0;
for (const h of Object.keys(home.roster)) {
  if (only.length && !only.includes(h)) continue;
  const nativeId = `${home.caip2}:${home.roster[h]!.sa.toLowerCase()}`;
  for (const c of chains) {
    const p = c.roster[h]; if (!p) { console.log(`${h.padEnd(8)} ${c.caip2}: not in this chain's roster — skipped`); continue; }
    if (privateKeyToAccount(p.eoaPrivateKey).address !== privateKeyToAccount(home.roster[h]!.eoaPrivateKey).address) { console.error(`${h}: different custodian keys — not the same person`); process.exit(1); }
    const agent = p.sa as Address;
    const name = await c.naming.reverseResolve(agent).catch(() => null);
    if (!name) { console.log(`${h.padEnd(8)} ${c.caip2}: ${agent} presents no name — nothing to write on`); continue; }
    const have = (await c.naming.getRecords(name).catch(() => ({} as AgentNameRecords))).nativeId ?? null;
    if (have?.toLowerCase() === nativeId) { console.log(`${h.padEnd(8)} ${c.caip2}: ${name} already declares home ${nativeId}`); same++; continue; }
    console.log(`${h.padEnd(8)} ${c.caip2}: ${name} ← nativeId ${nativeId}${have ? ` (was ${have})` : ''}${dry ? ' — would write' : ''}`);
    if (dry) continue;
    const callData = buildExecuteBatchCallData(buildRecordCalls({ resolver: c.dep.agentNameResolver, node: namehash(name), records: { nativeId } }));
    const estimate = await c.pc.estimateGas({ account: c.dep.entryPoint, to: agent, data: callData });
    const built = await c.account.buildCallUserOp({ sender: agent, callData, paymaster: c.dep.smartAgentPaymaster, callGasLimit: (estimate * 125n) / 100n });
    built.userOp.signature = await privateKeyToAccount(p.eoaPrivateKey).signMessage({ message: { raw: built.userOpHash } });
    const { receipt } = await c.account.submitCallUserOp(built.userOp, relay);
    let ok: boolean | undefined;
    for (const log of receipt.logs) { try { const ev = decodeEventLog({ abi: [OP_EVENT], data: log.data, topics: log.topics }); if (ev.eventName === 'UserOperationEvent' && String(ev.args.sender).toLowerCase() === agent.toLowerCase()) ok = ev.args.success; } catch { /* another event */ } }
    if (receipt.status !== 'success') { console.error(`  handleOps reverted (tx ${receipt.transactionHash}) — validation; check the paymaster's EntryPoint deposit`); process.exit(1); }
    if (ok !== true) { console.error(`  the write ${ok === false ? 'reverted inside the account' : 'left no UserOperationEvent'} (tx ${receipt.transactionHash})`); process.exit(1); }
    const after = (await c.naming.getRecords(name)).nativeId ?? null;
    if (after?.toLowerCase() !== nativeId) { console.error(`  read-back: nativeId is ${after} (tx ${receipt.transactionHash})`); process.exit(1); }
    console.log(`  written (tx ${receipt.transactionHash})`); wrote++;
  }
}
console.log(`\ndone — ${wrote} record(s) written, ${same} already current.`);
