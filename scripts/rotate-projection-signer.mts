// HAND THE ANCHORING ROLE TO ANOTHER ACCOUNT — `EstateProjectionRegistry.rotateSigner`, which only the CURRENT signer
// may call (spec 439 §4). Two cases, and the second is why this script exists:
//
//   · the signer is a KEY — rotate with `cast send` and that key; nothing here is needed;
//   · the signer is an AGENT — the call must come FROM its account, so it is a userOp its custodian signs. That is
//     the shape §4 asks for, and it is the shape nothing else in this repository could drive.
//
// Rotation is not a repair: an estate id is permanent and its roots are continuous across a rotation, so the new
// signer picks up at the next sequence. What changes is only who may write them.
//
//   RPC_URL=… RELAY_PRIVATE_KEY_FILE=~/.faithchain-deployer.key \
//   npx tsx scripts/rotate-projection-signer.mts --from 0x<current signer agent> --to 0x<new> --estate-id 0x… \
//     [--home https://… --by maya | --persona demo-admin | CUSTODIAN_KEY_ENV_FILE=… CUSTODIAN_KEY_VAR=…] [--dry-run]
import { readFileSync } from 'node:fs';
import { AgentAccountClient, buildExecuteCallData } from '@agenticprimitives/agent-account';
import { createPublicClient, decodeEventLog, encodeFunctionData, http, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const arg = (k: string): string | undefined => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const from = (arg('from') ?? '').toLowerCase() as Address; const to = (arg('to') ?? '').toLowerCase() as Address;
const estateId = (arg('estate-id') ?? '') as Hex; const registry = (arg('registry') ?? '0xb4E116F5C6915a4f1e649E0877e4a0A7a1c1147b') as Address;
const persona = arg('persona'); const home = arg('home'); const by = arg('by'); const dry = process.argv.includes('--dry-run');
if (!/^0x[0-9a-f]{40}$/.test(from) || !/^0x[0-9a-f]{40}$/.test(to) || !/^0x[0-9a-f]{64}$/.test(estateId)) { console.error('usage: rotate-projection-signer.mts --from 0x<agent> --to 0x<new signer> --estate-id 0x<32 bytes> [--registry 0x…] [--home … --by …|--persona …] [--dry-run]'); process.exit(1); }
const RPC = process.env.RPC_URL ?? (() => { console.error('RPC_URL is required'); process.exit(1); })();
const relayFile = (process.env.RELAY_PRIVATE_KEY_FILE ?? '').replace(/^~/, process.env.HOME ?? '');
const relayKey = (process.env.RELAY_PRIVATE_KEY ?? (relayFile ? readFileSync(relayFile, 'utf8').trim() : '')) as Hex;
if (!/^0x[0-9a-fA-F]{64}$/.test(relayKey)) { console.error('RELAY_PRIVATE_KEY(_FILE) is required'); process.exit(1); }
const CHAIN_ID = Number(process.env.CHAIN_ID ?? 34348);
const ENTRY_POINT = '0xf7855250B3363AB7649B10957d8908A9AFcdD4B5' as Address; const FACTORY = '0x464eEe7518c3c97DA570592481329E0627E9a3B8' as Address;
const PAYMASTER = (process.env.PAYMASTER ?? '0xbd93fEC6910ffD74F14709188b5a9B6C6965b2a7') as Address;
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
const REG = [
  { type: 'function', name: 'rotateSigner', stateMutability: 'nonpayable', inputs: [{ name: 'estateId', type: 'bytes32' }, { name: 'to', type: 'address' }], outputs: [] },
  { type: 'function', name: 'signerOf', stateMutability: 'view', inputs: [{ name: 'estateId', type: 'bytes32' }], outputs: [{ type: 'address' }] },
] as const;
const chain = { id: CHAIN_ID, name: 'c', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } as const;
const pc = createPublicClient({ chain, transport: http(RPC) });
const cur = String(await pc.readContract({ address: registry, abi: REG, functionName: 'signerOf', args: [estateId] })).toLowerCase();
console.log(`estate ${estateId.slice(0, 12)}… · signerOf is ${cur}\n  rotating ${from} → ${to}, signed by ${who}`);
if (cur !== from) { console.error(`  ${from} is not the current signer — only the current signer may rotate (nothing sent)`); process.exit(1); }
if (dry) { console.log('  would send the rotation userOp'); process.exit(0); }
const client = new AgentAccountClient({ rpcUrl: RPC, chainId: CHAIN_ID, entryPoint: ENTRY_POINT, factory: FACTORY });
const OP_EVENT = { type: 'event', name: 'UserOperationEvent', inputs: [{ name: 'userOpHash', type: 'bytes32', indexed: true }, { name: 'sender', type: 'address', indexed: true }, { name: 'paymaster', type: 'address', indexed: true }, { name: 'nonce', type: 'uint256' }, { name: 'success', type: 'bool' }, { name: 'actualGasCost', type: 'uint256' }, { name: 'actualGasUsed', type: 'uint256' }] } as const;
const built = await client.buildCallUserOp({ sender: from, callData: buildExecuteCallData({ to: registry, value: 0n, data: encodeFunctionData({ abi: REG, functionName: 'rotateSigner', args: [estateId, to] }) }), paymaster: PAYMASTER });
built.userOp.signature = await sign(built.userOpHash);
const { receipt } = await client.submitCallUserOp(built.userOp, privateKeyToAccount(relayKey));
let ok: boolean | null = null;
for (const log of receipt.logs) { try { ok = decodeEventLog({ abi: [OP_EVENT], data: log.data, topics: log.topics }).args.success as boolean; } catch { /* another event */ } }
if (receipt.status !== 'success' || ok === false) { console.error(`  the rotation userOp failed (tx ${receipt.transactionHash})`); process.exit(1); }
console.log(`  done (tx ${receipt.transactionHash}) — signerOf is now ${String(await pc.readContract({ address: registry, abi: REG, functionName: 'signerOf', args: [estateId] }))}`);
