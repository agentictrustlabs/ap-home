// COPY A PERSON'S NAME RECORDS FROM THE ROOT CHAIN — the records a Home writes when it names someone (`atl:a2aEndpoint`,
// `atl:description`, a site or card when set) are what place the person in an estate: the town portal puts an agent in the
// estate whose `agentZone` its `a2aEndpoint` host is under (town-model `placeAgent`: a record, never a subdomain guess).
// A name claimed by script on a second chain carried none of them, so hopenet's portal showed the impact-agent estate with
// no people although five were named there. This copies those records from the person's name on the mirror chain onto
// their name on the target chain — the same estate zone serves both, so the values are chain-agnostic — written by the
// name's owner, as every record is.
//
//   npx tsx scripts/copy-persona-name-records.mts --chain <roster>,<deployments>,<rpc with write token> \
//     --mirror <roster>,<deployments>,<rpc> --relay-key-file ~/.<chain>-deployer.key [--only a,b] [--dry-run]
import { readFileSync } from 'node:fs';
import { AgentAccountClient, buildExecuteBatchCallData } from '@agenticprimitives/agent-account';
import { AgentNamingClient, buildRecordCalls, namehash, type AgentNameRecords } from '@agenticprimitives/agent-naming';
import { createPublicClient, decodeEventLog, http, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const argv = process.argv.slice(2);
const pick = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const [chainArg, mirrorArg, relayFile] = [pick('chain'), pick('mirror'), (pick('relay-key-file') ?? '').replace(/^~/, process.env.HOME ?? '')];
const only = (pick('only') ?? '').split(',').map((s) => s.trim()).filter(Boolean); const dry = argv.includes('--dry-run');
if (!chainArg || !mirrorArg || !relayFile) { console.error('usage: --chain <roster>,<deployments>,<rpc> --mirror <roster>,<deployments>,<rpc> --relay-key-file <file> [--only a,b] [--dry-run]'); process.exit(1); }
type Dep = { chainId: number; entryPoint: Address; agentAccountFactory: Address; agentNameRegistry: Address; agentNameResolver: Address; agentNameUniversalResolver: Address; smartAgentPaymaster: Address };
type Roster = Record<string, { sa: string; eoaPrivateKey: Hex }>;
const load = (a: string) => { const [roster, depFile, rpc] = a.split(',') as [string, string, string]; const dep = JSON.parse(readFileSync(depFile, 'utf8')) as Dep; return { rpc, dep, roster: JSON.parse(readFileSync(roster, 'utf8')) as Roster, naming: new AgentNamingClient({ rpcUrl: rpc, chainId: dep.chainId, registry: dep.agentNameRegistry, universalResolver: dep.agentNameUniversalResolver }), pc: createPublicClient({ transport: http(rpc) }) }; };
const T = load(chainArg), M = load(mirrorArg);
const relay = privateKeyToAccount(readFileSync(relayFile, 'utf8').trim() as Hex);
const account = new AgentAccountClient({ rpcUrl: T.rpc, chainId: T.dep.chainId, entryPoint: T.dep.entryPoint, factory: T.dep.agentAccountFactory });
const OP_EVENT = { type: 'event', name: 'UserOperationEvent', inputs: [{ name: 'userOpHash', type: 'bytes32', indexed: true }, { name: 'sender', type: 'address', indexed: true }, { name: 'paymaster', type: 'address', indexed: true }, { name: 'nonce', type: 'uint256' }, { name: 'success', type: 'bool' }, { name: 'actualGasCost', type: 'uint256' }, { name: 'actualGasUsed', type: 'uint256' }] } as const;
// The records that place and describe a person; never addr/agentKind/accounts (chain-specific or already written), never custody.
const COPY = ['a2aEndpoint', 'description', 'siteUrl', 'cardUri', 'mcpEndpoint'] as const;

console.log(`chain ${T.dep.chainId} ← records from chain ${M.dep.chainId} · relay ${relay.address}${dry ? ' · DRY RUN' : ''}`);
let wrote = 0, same = 0;
for (const [h, p] of Object.entries(T.roster)) {
  if (only.length && !only.includes(h)) continue;
  const m = M.roster[h]; if (!m) { console.log(`${h.padEnd(8)} not in the mirror roster — skipped`); continue; }
  const agent = p.sa as Address;
  const [name, mirrorName] = await Promise.all([T.naming.reverseResolve(agent).catch(() => null), M.naming.reverseResolve(m.sa as Address).catch(() => null)]);
  if (!name || !mirrorName) { console.log(`${h.padEnd(8)} presents ${name ?? 'no name'} here / ${mirrorName ?? 'no name'} on the mirror — nothing to copy`); continue; }
  const [from, have] = await Promise.all([M.naming.getRecords(mirrorName).catch(() => ({} as AgentNameRecords)), T.naming.getRecords(name).catch(() => ({} as AgentNameRecords))]);
  const records: Partial<AgentNameRecords> = {};
  for (const k of COPY) { const v = (from as Record<string, unknown>)[k]; if (typeof v === 'string' && v && (have as Record<string, unknown>)[k] !== v) (records as Record<string, unknown>)[k] = v; }
  if (!Object.keys(records).length) { console.log(`${h.padEnd(8)} ${name}: records already match ${mirrorName}`); same++; continue; }
  console.log(`${h.padEnd(8)} ${name} ← ${Object.entries(records).map(([k, v]) => `${k}=${String(v).slice(0, 60)}`).join('; ')}${dry ? ' — would write' : ''}`);
  if (dry) continue;
  const custodian = privateKeyToAccount(p.eoaPrivateKey);
  const callData = buildExecuteBatchCallData(buildRecordCalls({ resolver: T.dep.agentNameResolver, node: namehash(name), records: records as AgentNameRecords }));
  const estimate = await T.pc.estimateGas({ account: T.dep.entryPoint, to: agent, data: callData });
  const built = await account.buildCallUserOp({ sender: agent, callData, paymaster: T.dep.smartAgentPaymaster, callGasLimit: (estimate * 125n) / 100n });
  built.userOp.signature = await custodian.signMessage({ message: { raw: built.userOpHash } });
  const { receipt } = await account.submitCallUserOp(built.userOp, relay);
  let ok: boolean | undefined;
  for (const log of receipt.logs) { try { const ev = decodeEventLog({ abi: [OP_EVENT], data: log.data, topics: log.topics }); if (ev.eventName === 'UserOperationEvent' && String(ev.args.sender).toLowerCase() === agent.toLowerCase()) ok = ev.args.success; } catch { /* another event */ } }
  if (receipt.status !== 'success') { console.error(`  handleOps reverted (tx ${receipt.transactionHash}) — validation; check the paymaster's EntryPoint deposit`); process.exit(1); }
  if (ok !== true) { console.error(`  the write ${ok === false ? 'reverted inside the account' : 'left no UserOperationEvent'} (tx ${receipt.transactionHash})`); process.exit(1); }
  const after = await T.naming.getRecords(name) as Record<string, unknown>;
  for (const [k, v] of Object.entries(records)) if (after[k] !== v) { console.error(`  read-back: ${k} is ${String(after[k])}, not ${String(v)} (tx ${receipt.transactionHash})`); process.exit(1); }
  console.log(`  written (tx ${receipt.transactionHash})`); wrote++;
}
console.log(`\ndone — ${wrote} name(s) updated, ${same} already matching.`);
