// ROTATE A CUSTODIAN ON AN AGENT'S ACCOUNT — add the incoming credential, retire the outgoing one, and re-approve the
// standing wires under the new custody epoch, all in ONE transaction. That is the rotation ceremony spec 410 §1 names,
// and the reason a bare `removeCustodian` is the wrong tool: it bumps the epoch and leaves every standing grant keyed
// to the old one. The agent's address never changes — a credential rotates, the identity does not (ADR-0011).
//
// The call must come FROM the account (`addCustodian`/`removeCustodian`/`approveDigest` are all `onlySelf`), so this is
// a userOp the CURRENT custodian signs. A custody-governed account (a CustodyPolicy executor installed) is refused
// here on purpose: there the ceremony belongs to the quorum path, not to a single signer.
//
//   RPC_URL=… RELAY_PRIVATE_KEY_FILE=~/.faithchain-deployer.key \
//   npx tsx scripts/rotate-custodian.mts --agent 0x<sa> --add 0x<incoming eoa> --remove 0x<outgoing eoa> \
//     [--re-approve 0x<digest> …] [--home https://… --by maya | --persona demo-admin | CUSTODIAN_KEY_ENV_FILE=…] [--dry-run]
import { readFileSync } from 'node:fs';
import { AgentAccountClient, buildExecuteBatchCallData, type ContractCall } from '@agenticprimitives/agent-account';
import { createPublicClient, decodeEventLog, encodeFunctionData, http, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const arg = (k: string): string | undefined => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const all = (k: string): string[] => process.argv.flatMap((v, i) => (v === `--${k}` && process.argv[i + 1] ? [process.argv[i + 1]] : []));
const agent = (arg('agent') ?? '').toLowerCase() as Address;
const add = (arg('add') ?? '').toLowerCase() as Address;
const remove = (arg('remove') ?? '').toLowerCase() as Address;
const reApprove = all('re-approve') as Hex[];
const persona = arg('persona'); const home = arg('home'); const by = arg('by'); const dry = process.argv.includes('--dry-run');
const addr = (v: string) => /^0x[0-9a-f]{40}$/.test(v);
if (!addr(agent) || (!addr(add) && !addr(remove)) || reApprove.some((d) => !/^0x[0-9a-fA-F]{64}$/.test(d))) {
  console.error('usage: rotate-custodian.mts --agent 0x<sa> [--add 0x<eoa>] [--remove 0x<eoa>] [--re-approve 0x<digest> …] [--home … --by …|--persona …] [--dry-run]');
  process.exit(1);
}
const RPC = process.env.RPC_URL ?? (() => { console.error('RPC_URL is required'); process.exit(1); })();
const relayFile = (process.env.RELAY_PRIVATE_KEY_FILE ?? '').replace(/^~/, process.env.HOME ?? '');
const relayKey = (process.env.RELAY_PRIVATE_KEY ?? (relayFile ? readFileSync(relayFile, 'utf8').trim() : '')) as Hex;
if (!/^0x[0-9a-fA-F]{64}$/.test(relayKey)) { console.error('RELAY_PRIVATE_KEY(_FILE) is required'); process.exit(1); }
const CHAIN_ID = Number(process.env.CHAIN_ID ?? 34348);
const ENTRY_POINT = '0xf7855250B3363AB7649B10957d8908A9AFcdD4B5' as Address;
const FACTORY = '0x464eEe7518c3c97DA570592481329E0627E9a3B8' as Address;
const PAYMASTER = (process.env.PAYMASTER ?? '0xbd93fEC6910ffD74F14709188b5a9B6C6965b2a7') as Address;
const CUSTODY_POLICY = (process.env.CUSTODY_POLICY ?? '0xfb3662Ddc308FAc977A1F663948A447055722d3B') as Address;
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t) as Record<string, unknown>; } catch { return { _raw: t.slice(0, 200) }; } };
const envFile = process.env.CUSTODIAN_KEY_ENV_FILE ?? ''; const varName = process.env.CUSTODIAN_KEY_VAR ?? 'CUSTODIAN_PRIVATE_KEY';
const fromRoster = persona ? ((JSON.parse(readFileSync('demo/personas.local.json', 'utf8')) as Record<string, { eoaPrivateKey?: string }>)[persona]?.eoaPrivateKey ?? '') : '';
const custodianKey = (fromRoster || process.env.CUSTODIAN_PRIVATE_KEY || (envFile ? (new RegExp(`^${varName}=['"]?(0x[0-9a-fA-F]{64})`, 'm').exec(readFileSync(envFile, 'utf8'))?.[1] ?? '') : '')) as Hex;
let sign: (d: Hex) => Promise<Hex>; let who: string;
if (home && by) {
  const s = await j(await fetch(`${home}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: by, client_id: 'demo-jp' }) }));
  const token = String(s.homeSession ?? ''); if (!token) { console.error(`no session for ${by} at ${home}`); process.exit(1); }
  sign = async (d) => { const b = await j(await fetch(`${home}/connect/persona-sign`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ digest: d }) })); if (!b.signature) throw new Error(String(b.error ?? 'persona-sign refused')); return b.signature as Hex; };
  who = `${by} at ${home}`;
} else {
  if (!/^0x[0-9a-fA-F]{64}$/.test(custodianKey)) { console.error('a custodian is required (--home/--by, --persona, CUSTODIAN_PRIVATE_KEY, or CUSTODIAN_KEY_ENV_FILE + CUSTODIAN_KEY_VAR)'); process.exit(1); }
  const a = privateKeyToAccount(custodianKey); sign = (d) => a.signMessage({ message: { raw: d } }); who = a.address;
}
const ACC = [
  { type: 'function', name: 'addCustodian', stateMutability: 'nonpayable', inputs: [{ name: 'owner', type: 'address' }], outputs: [] },
  { type: 'function', name: 'removeCustodian', stateMutability: 'nonpayable', inputs: [{ name: 'owner', type: 'address' }], outputs: [] },
  { type: 'function', name: 'approveDigest', stateMutability: 'nonpayable', inputs: [{ name: 'digest', type: 'bytes32' }], outputs: [] },
  { type: 'function', name: 'isCustodian', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'custodianCount', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'custodyEpoch', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint64' }] },
  { type: 'function', name: 'isModuleInstalled', stateMutability: 'view', inputs: [{ name: 'moduleTypeId', type: 'uint256' }, { name: 'module', type: 'address' }, { name: 'additionalContext', type: 'bytes' }], outputs: [{ type: 'bool' }] },
] as const;
const chain = { id: CHAIN_ID, name: 'c', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } as const;
const pc = createPublicClient({ chain, transport: http(RPC) });
const read = <T,>(fn: string, args: readonly unknown[] = []) => pc.readContract({ address: agent, abi: ACC, functionName: fn as 'custodianCount', args: args as [] }) as Promise<T>;
const [count, epoch, hasAdd, hasRemove] = await Promise.all([
  read<bigint>('custodianCount'),
  // Generation 1 of `AgentAccount` has no custody epoch and no approved-hash registry on the account, so this reverts
  // there. That is not a failure to route around: it says there is no epoch for a retirement to bump, and therefore no
  // standing wire for this ceremony to carry — and no `approveDigest` to carry one with (spec 410 §1 is generation 3).
  read<bigint>('custodyEpoch').catch(() => null),
  addr(add) ? read<boolean>('isCustodian', [add]) : Promise.resolve(false),
  addr(remove) ? read<boolean>('isCustodian', [remove]) : Promise.resolve(false),
]);
const governed = await read<boolean>('isModuleInstalled', [2n, CUSTODY_POLICY, '0x']).catch(() => false);
const impl = await pc.getStorageAt({ address: agent, slot: '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc' });
const implCode = await pc.getBytecode({ address: `0x${String(impl).slice(26)}` as Address }).catch(() => undefined);
const hasApproveDigest = (implCode ?? '').includes('436fd9e6');
console.log(`${agent} · ${count} custodian(s) · custody epoch ${epoch ?? 'n/a (generation 1 — this implementation has none)'}${governed ? ' · CUSTODY-GOVERNED' : ' · self-governed (mode 0)'}`);
if (governed) { console.error('  a CustodyPolicy executor is installed — the ceremony belongs to the quorum path, not to a single signer (nothing sent)'); process.exit(1); }
if (addr(add) && hasAdd) { console.error(`  ${add} is already a custodian (nothing sent)`); process.exit(1); }
if (addr(remove) && !hasRemove) { console.error(`  ${remove} is not a custodian (nothing sent)`); process.exit(1); }
if (reApprove.length && !hasApproveDigest) { console.error('  --re-approve was passed but this implementation has no `approveDigest` — the approved-hash registry is generation 3 (nothing sent)'); process.exit(1); }
if (addr(remove) && !addr(add) && count === 1n) { console.error('  that is the last custodian and nothing is being added — a zero-signer account is refused (nothing sent)'); process.exit(1); }
const calls: ContractCall[] = [];
if (addr(add)) calls.push({ to: agent, value: 0n, data: encodeFunctionData({ abi: ACC, functionName: 'addCustodian', args: [add] }) });
if (addr(remove)) calls.push({ to: agent, value: 0n, data: encodeFunctionData({ abi: ACC, functionName: 'removeCustodian', args: [remove] }) });
for (const d of reApprove) calls.push({ to: agent, value: 0n, data: encodeFunctionData({ abi: ACC, functionName: 'approveDigest', args: [d] }) });
console.log(`  ceremony (one transaction, signed by ${who}):`);
if (addr(add)) console.log(`    add     ${add}`);
if (addr(remove)) console.log(`    retire  ${remove}${epoch === null ? '' : `  → custody epoch ${epoch} becomes ${epoch + 1n}`}`);
if (reApprove.length) for (const d of reApprove) console.log(`    re-approve ${d}`);
else if (addr(remove) && epoch !== null) console.log('    no --re-approve digests: every standing wire keyed to the old epoch stops working. Pass them, or know there are none.');
else if (addr(remove)) console.log('    no epoch on this implementation, so no standing wire is keyed to one and there is nothing to carry across');
if (dry) { console.log('  would send the ceremony userOp'); process.exit(0); }
const client = new AgentAccountClient({ rpcUrl: RPC, chainId: CHAIN_ID, entryPoint: ENTRY_POINT, factory: FACTORY });
const OP_EVENT = { type: 'event', name: 'UserOperationEvent', inputs: [{ name: 'userOpHash', type: 'bytes32', indexed: true }, { name: 'sender', type: 'address', indexed: true }, { name: 'paymaster', type: 'address', indexed: true }, { name: 'nonce', type: 'uint256' }, { name: 'success', type: 'bool' }, { name: 'actualGasCost', type: 'uint256' }, { name: 'actualGasUsed', type: 'uint256' }] } as const;
const built = await client.buildCallUserOp({ sender: agent, callData: buildExecuteBatchCallData(calls), paymaster: PAYMASTER });
built.userOp.signature = await sign(built.userOpHash);
const { receipt } = await client.submitCallUserOp(built.userOp, privateKeyToAccount(relayKey));
let ok: boolean | null = null;
for (const log of receipt.logs) { try { ok = decodeEventLog({ abi: [OP_EVENT], data: log.data, topics: log.topics }).args.success as boolean; } catch { /* another event */ } }
if (receipt.status !== 'success' || ok === false) { console.error(`  the ceremony userOp failed (tx ${receipt.transactionHash})`); process.exit(1); }
const [c2, e2, a2, r2] = await Promise.all([read<bigint>('custodianCount'), read<bigint>('custodyEpoch').catch(() => null), addr(add) ? read<boolean>('isCustodian', [add]) : Promise.resolve(false), addr(remove) ? read<boolean>('isCustodian', [remove]) : Promise.resolve(false)]);
console.log(`  done (tx ${receipt.transactionHash}) — ${c2} custodian(s) · epoch ${e2 ?? 'n/a'}${addr(add) ? ` · ${add} ${a2 ? 'is' : 'is NOT'} a custodian` : ''}${addr(remove) ? ` · ${remove} ${r2 ? 'is STILL' : 'is not'} a custodian` : ''}`);
