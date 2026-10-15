// NAME A DEMO ESTATE'S PERSONAS ON A CHAIN — the half `seed-personas-on-chain.mts` does not do. Seeding deploys an
// account per custodian key and names nothing, so on a second chain every persona reverse-resolves to "" and the
// town's registry lists nobody. This claims `<handle>.<tld>` for each of them on THAT chain's permissionless typed
// root, in the shape spec 346 §3 requires: the subject declares its derived type on its own profile subject first,
// then claims, writes the node's records, and presents the name as primary — all in ONE executeBatch sent BY the
// agent (the subregistry allows one claim per msg.sender, so a relay could claim for one persona and no more).
//
// Free, local names (ap-town spec 429: a `status: demo` town). On a town whose names root elsewhere (spec 440 §C)
// these are the LOCAL table's entries, not the federation's: the federated name stays `{ <handle>.<tld>, root chain }`
// and the two are joined by `atl:accounts` on the root-chain name, which this script does not write.
//
//   npx tsx scripts/name-personas-on-chain.mts --roster demo/personas.<estate>.<chain>.json \
//     --deployment-file <path to deployments-<chain>.json> --rpc <gateway url with a write token> \
//     --relay-key-file ~/.<chain>-deployer.key [--tld me] [--only maya,samuel] [--dry-run]
import { readFileSync } from 'node:fs';
import { AgentAccountClient, buildExecuteBatchCallData } from '@agenticprimitives/agent-account';
import { AgentNamingClient, buildDeclareAgentTypeCalls, buildTypedClaimCalls, derivedTypeForTld } from '@agenticprimitives/agent-naming';
import { createPublicClient, decodeEventLog, http, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const roster = arg('roster'), depFile = arg('deployment-file'), rpc = arg('rpc'), relayFile = (arg('relay-key-file') ?? '').replace(/^~/, process.env.HOME ?? '');
const tld = arg('tld') ?? 'me'; const only = (arg('only') ?? '').split(',').map((s) => s.trim()).filter(Boolean); const dry = process.argv.includes('--dry-run');
if (!roster || !depFile || !rpc || !relayFile) { console.error('usage: --roster <file> --deployment-file <file> --rpc <url> --relay-key-file <file> [--tld me] [--only a,b] [--dry-run]'); process.exit(1); }

type Dep = { chainId: number; entryPoint: Address; agentAccountFactory: Address; agentNameRegistry: Address; agentNameResolver: Address; agentNameUniversalResolver: Address; agentProfileResolver: Address; smartAgentPaymaster: Address; permissionlessSubregistries: Record<string, Address> };
const dep = JSON.parse(readFileSync(depFile, 'utf8')) as Dep;
const people = JSON.parse(readFileSync(roster, 'utf8')) as Record<string, { sa: string; eoaPrivateKey: Hex; name?: string }>;
const relay = privateKeyToAccount(readFileSync(relayFile, 'utf8').trim() as Hex);
const agentType = derivedTypeForTld(tld);
const subregistry = dep.permissionlessSubregistries?.[tld];
if (!subregistry) { console.error(`the deployment has no permissionless subregistry for ".${tld}"`); process.exit(1); }

const chain = { id: dep.chainId, name: `chain-${dep.chainId}`, nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } } as const;
const pc = createPublicClient({ chain, transport: http(rpc) });
const account = new AgentAccountClient({ rpcUrl: rpc, chainId: dep.chainId, entryPoint: dep.entryPoint, factory: dep.agentAccountFactory });
const naming = new AgentNamingClient({ rpcUrl: rpc, chainId: dep.chainId, registry: dep.agentNameRegistry, universalResolver: dep.agentNameUniversalResolver, subregistries: dep.permissionlessSubregistries, profileResolver: dep.agentProfileResolver });
const PROFILE_ABI = [{ type: 'function', name: 'isRegistered', stateMutability: 'view', inputs: [{ name: 'agent', type: 'address' }], outputs: [{ type: 'bool' }] }] as const;
const OP_EVENT = { type: 'event', name: 'UserOperationEvent', inputs: [{ name: 'userOpHash', type: 'bytes32', indexed: true }, { name: 'sender', type: 'address', indexed: true }, { name: 'paymaster', type: 'address', indexed: true }, { name: 'nonce', type: 'uint256' }, { name: 'success', type: 'bool' }, { name: 'actualGasCost', type: 'uint256' }, { name: 'actualGasUsed', type: 'uint256' }] } as const;

console.log(`chain ${dep.chainId} · .${tld} → ${agentType} · subregistry ${subregistry} · relay ${relay.address}${dry ? ' · DRY RUN' : ''}`);
let named = 0, skipped = 0;
for (const [handle, p] of Object.entries(people)) {
  if (only.length && !only.includes(handle)) continue;
  const custodian = privateKeyToAccount(p.eoaPrivateKey);
  const agent = p.sa as Address;
  // The roster's `sa` must be THIS chain's derivation of the custodian — a faithchain roster on hopechain names the wrong account.
  const derived = await account.getAddressForAgentAccount({ custodians: [custodian.address], salt: 0n });
  if (derived.toLowerCase() !== agent.toLowerCase()) { console.error(`${handle}: roster sa ${agent} is not this chain's account for its custodian (${derived}) — wrong roster for this chain`); process.exit(1); }
  const name = `${handle}.${tld}`;
  const current = await naming.reverseResolve(agent).catch(() => null);
  if (current) { console.log(`${handle.padEnd(8)} ${agent} already presents ${current} — skipped`); skipped++; continue; }
  const taken = await naming.resolveName(name).catch(() => null);
  if (taken && taken !== '0x0000000000000000000000000000000000000000') { console.error(`${handle}: ${name} is already ${taken}'s on this chain — not touching it`); skipped++; continue; }
  const registered = await pc.readContract({ address: dep.agentProfileResolver, abi: PROFILE_ABI, functionName: 'isRegistered', args: [agent] }).catch(() => false);
  const declare = buildDeclareAgentTypeCalls({ profileResolver: dep.agentProfileResolver, agent, agentType, registered, displayName: p.name ?? handle });
  const claim = buildTypedClaimCalls({ name, owner: agent, registry: dep.agentNameRegistry, resolver: dep.agentNameResolver, subregistries: dep.permissionlessSubregistries, agentType, records: p.name ? { displayName: p.name } : {} });
  const calls = [...declare, claim.claim, ...claim.records, claim.primaryName];
  console.log(`${handle.padEnd(8)} ${agent} → ${name} (${registered ? 'profile registered' : 'registers profile'}; ${calls.length} calls in one batch)${dry ? ' — would claim' : ''}`);
  if (dry) continue;
  // A typed claim batch costs ~1.1–1.7M gas and buildCallUserOp's default callGasLimit is 800k — estimate from the
  // EntryPoint and pass the limit explicitly, as the Home's /account/build-call-userop does. An out-of-gas userOp
  // fails with `success:false` and no revert reason, and every call simulates fine on its own.
  const callData = buildExecuteBatchCallData(calls);
  const estimate = await pc.estimateGas({ account: dep.entryPoint, to: agent, data: callData });
  const built = await account.buildCallUserOp({ sender: agent, callData, paymaster: dep.smartAgentPaymaster, callGasLimit: (estimate * 125n) / 100n });
  built.userOp.signature = await custodian.signMessage({ message: { raw: built.userOpHash } });
  const { receipt } = await account.submitCallUserOp(built.userOp, relay);
  let ok: boolean | undefined;
  for (const log of receipt.logs) { try { const ev = decodeEventLog({ abi: [OP_EVENT], data: log.data, topics: log.topics }); if (ev.eventName === 'UserOperationEvent' && String(ev.args.sender).toLowerCase() === agent.toLowerCase()) ok = ev.args.success; } catch { /* another event */ } }
  // Three failures, three messages (never one): handleOps itself reverting is a VALIDATION failure — on a free-gas
  // chain that is still almost always the paymaster's EntryPoint deposit (AA31: prefund is charged against the
  // userOp's limits even at gas price 0; three claims drained 1e15 wei to 4e14 on hopechain) — while `success:false`
  // with a healthy receipt is the batch reverting inside the account, and no event at all is a bundler/relay fault.
  if (receipt.status !== 'success') { console.error(`  ${handle}: handleOps reverted (tx ${receipt.transactionHash}) — a validation failure, not the batch; check the paymaster's EntryPoint deposit first (entryPoint.balanceOf(paymaster))`); process.exit(1); }
  if (ok === false) { console.error(`  ${handle}: the batch reverted inside the account (tx ${receipt.transactionHash})`); process.exit(1); }
  if (ok === undefined) { console.error(`  ${handle}: no UserOperationEvent for this agent in tx ${receipt.transactionHash}`); process.exit(1); }
  const after = await naming.reverseResolve(agent).catch(() => null);
  if (after !== name) { console.error(`  ${handle}: claimed but reverse-resolves to "${after ?? ''}" (tx ${receipt.transactionHash})`); process.exit(1); }
  console.log(`  ${name} presented by ${agent} (tx ${receipt.transactionHash})`); named++;
}
console.log(`\ndone — ${named} named, ${skipped} skipped.`);
