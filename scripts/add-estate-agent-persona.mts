// AN ESTATE AGENT CUSTODIED BY A DEMO PERSONA — the owner's shape for faithnet (2026-10-14): "use a demo user for that
// agent … a type of .estate for each". The runtime-custodied shape (add-estate-agent.mts: salt 2 over the estate's
// interactions key) needs a key that is a Cloudflare secret; this one needs a persona's key from
// demo/personas.local.json and a relay key that pays gas. Everything else is the same as imbnet's estate agent: a
// Smart Agent whose only duties are to BE the estate's stable identity (`<estate>.estate` points at it; the estate
// id on neutral ground derives from it), to carry the Home URL in `atl:homepage`, and to declare the key that
// anchors its roots in `atl:projectionSigner`. It is NOT the Pulse context agent (`faith-estate.workspace`), which
// stays a workspace — one agent per estate typed .estate, one per context typed .workspace.
//
//   RPC_URL=… RELAY_PRIVATE_KEY_FILE=~/.faithchain-deployer.key \
//   npx tsx scripts/add-estate-agent-persona.mts --estate faithnet --custodian-persona demo-admin --home https://www.faithnet.me [--signer 0x…] [--salt 2] [--dry-run]
//
// Then, as the DEPLOYER (it owns the .estate root), Ring 0: ESTATE_LABEL=faithnet ESTATE_AGENT=<addr> forge script script/AddEstateName.s.sol …
import { readFileSync } from 'node:fs';
import { AgentAccountClient, buildExecuteCallData } from '@agenticprimitives/agent-account';
import { buildRegisterProfileCall } from '@agenticprimitives/agent-profile';
import { createPublicClient, decodeEventLog, encodeFunctionData, http, keccak256, toBytes, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const arg = (k: string): string | undefined => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const estate = arg('estate'); const persona = arg('custodian-persona'); const home = (arg('home') ?? '').trim(); const signer = arg('signer')?.toLowerCase(); const salt = BigInt(arg('salt') ?? '2'); const dry = process.argv.includes('--dry-run');
if (!estate || !persona || !/^https:\/\/[^\s/]+/.test(home)) { console.error('usage: add-estate-agent-persona.mts --estate <id> --custodian-persona <handle> --home https://… [--signer 0x…] [--salt 2] [--dry-run]'); process.exit(1); }
const RPC = process.env.RPC_URL ?? (() => { console.error('RPC_URL is required'); process.exit(1); })();
const relayFile = (process.env.RELAY_PRIVATE_KEY_FILE ?? '').replace(/^~/, process.env.HOME ?? '');
const relayKey = (process.env.RELAY_PRIVATE_KEY ?? (relayFile ? readFileSync(relayFile, 'utf8').trim() : '')) as Hex;
if (!/^0x[0-9a-fA-F]{64}$/.test(relayKey)) { console.error('RELAY_PRIVATE_KEY or RELAY_PRIVATE_KEY_FILE is required'); process.exit(1); }
const roster = JSON.parse(readFileSync('demo/personas.local.json', 'utf8')) as Record<string, { eoaPrivateKey?: string }>;
if (!roster[persona]?.eoaPrivateKey) { console.error(`no persona ${persona} with a key in demo/personas.local.json`); process.exit(1); }
const custodian = privateKeyToAccount(roster[persona]!.eoaPrivateKey as Hex);
const relay = privateKeyToAccount(relayKey);

const CHAIN_ID = Number(process.env.CHAIN_ID ?? 34348);
const ENTRY_POINT = '0xf7855250B3363AB7649B10957d8908A9AFcdD4B5' as Address; const FACTORY = '0x464eEe7518c3c97DA570592481329E0627E9a3B8' as Address;
const PROFILE_RESOLVER = (process.env.PROFILE_RESOLVER ?? '0xB03F7C06ad3274F584AB72794406D639c02A45e1') as Address; const PAYMASTER = (process.env.PAYMASTER ?? '0xbd93fEC6910ffD74F14709188b5a9B6C6965b2a7') as Address;
const P = { homepage: keccak256(toBytes('atl:homepage')), projectionSigner: keccak256(toBytes('atl:projectionSigner')) };
const ABI = [
  { type: 'function', name: 'isRegistered', stateMutability: 'view', inputs: [{ name: 'agent', type: 'address' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'getStringProperty', stateMutability: 'view', inputs: [{ name: 'agent', type: 'address' }, { name: 'predicate', type: 'bytes32' }], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'getAddressProperty', stateMutability: 'view', inputs: [{ name: 'agent', type: 'address' }, { name: 'predicate', type: 'bytes32' }], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'setStringProperty', stateMutability: 'nonpayable', inputs: [{ name: 'agent', type: 'address' }, { name: 'predicate', type: 'bytes32' }, { name: 'value', type: 'string' }], outputs: [] },
  { type: 'function', name: 'setAddressProperty', stateMutability: 'nonpayable', inputs: [{ name: 'agent', type: 'address' }, { name: 'predicate', type: 'bytes32' }, { name: 'value', type: 'address' }], outputs: [] },
] as const;
const chain = { id: CHAIN_ID, name: 'estate-chain', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } as const;
const pc = createPublicClient({ chain, transport: http(RPC) });
const client = new AgentAccountClient({ rpcUrl: RPC, chainId: CHAIN_ID, entryPoint: ENTRY_POINT, factory: FACTORY });

const spec = { custodians: [custodian.address] as readonly Address[], salt };
const agent = await client.getAddressForAgentAccount(spec);
const deployed = await client.isDeployed(agent).catch(() => false);
console.log(`estate: ${estate}\nestate agent: ${agent} (salt ${salt} over ${persona} ${custodian.address}) — ${deployed ? 'already deployed' : 'not deployed'}\nhome: ${home}${signer ? `\nsigner: ${signer}` : ''}`);
if (!deployed) {
  if (dry) console.log('would deploy the estate agent');
  else {
    console.log('deploying the estate agent…');
    await client.createAgentAccountFromPrivateKey(spec, relayKey);
    let now = false;
    for (let i = 0; i < 10 && !now; i++) { now = await client.isDeployed(agent).catch(() => false); if (!now) await new Promise((r) => setTimeout(r, 1500)); }
    if (!now) { console.error('  the deploy did not take — stopping'); process.exit(1); }
    console.log('  deployed');
  }
}
const registered = deployed ? await pc.readContract({ address: PROFILE_RESOLVER, abi: ABI, functionName: 'isRegistered', args: [agent] }).catch(() => false) : false;
const calls: { to: Address; value: bigint; data: Hex; what: string }[] = [];
if (!registered) { const r = buildRegisterProfileCall({ profileResolver: PROFILE_RESOLVER, agent, displayName: `${estate} estate`, description: `The ${estate} estate: its Home and the people under it.` }); calls.push({ to: r.to, value: r.value ?? 0n, data: r.data, what: 'register the profile' }); }
const curHome = registered ? String(await pc.readContract({ address: PROFILE_RESOLVER, abi: ABI, functionName: 'getStringProperty', args: [agent, P.homepage] }).catch(() => '')) : '';
if (curHome.trim() !== home) calls.push({ to: PROFILE_RESOLVER, value: 0n, data: encodeFunctionData({ abi: ABI, functionName: 'setStringProperty', args: [agent, P.homepage, home] }), what: `set atl:homepage = ${home}` });
if (signer) { const cur = registered ? String(await pc.readContract({ address: PROFILE_RESOLVER, abi: ABI, functionName: 'getAddressProperty', args: [agent, P.projectionSigner] }).catch(() => '')).toLowerCase() : ''; if (cur !== signer) calls.push({ to: PROFILE_RESOLVER, value: 0n, data: encodeFunctionData({ abi: ABI, functionName: 'setAddressProperty', args: [agent, P.projectionSigner, signer as Address] }), what: `set atl:projectionSigner = ${signer}` }); }
for (const c of calls) console.log(`${dry ? 'would' : 'will'} ${c.what}`);
if (dry || !calls.length) { if (!calls.length) console.log('nothing to write'); process.exit(0); }

const OP_EVENT = { type: 'event', name: 'UserOperationEvent', inputs: [{ name: 'userOpHash', type: 'bytes32', indexed: true }, { name: 'sender', type: 'address', indexed: true }, { name: 'paymaster', type: 'address', indexed: true }, { name: 'nonce', type: 'uint256' }, { name: 'success', type: 'bool' }, { name: 'actualGasCost', type: 'uint256' }, { name: 'actualGasUsed', type: 'uint256' }] } as const;
for (const c of calls) {
  const built = await client.buildCallUserOp({ sender: agent, callData: buildExecuteCallData({ to: c.to, value: c.value, data: c.data }), paymaster: PAYMASTER });
  built.userOp.signature = await custodian.signMessage({ message: { raw: built.userOpHash } });
  const { receipt } = await client.submitCallUserOp(built.userOp, relay);
  if (receipt.status !== 'success') { console.error(`  ${c.what}: the transaction reverted (tx ${receipt.transactionHash})`); process.exit(1); }
  let ok: boolean | null = null;
  for (const log of receipt.logs) { try { ok = decodeEventLog({ abi: [OP_EVENT], data: log.data, topics: log.topics }).args.success as boolean; } catch { /* another event */ } }
  if (ok === false) { console.error(`  ${c.what}: the userOp reverted inside the account (tx ${receipt.transactionHash})`); process.exit(1); }
  console.log(`  ${c.what}: done (tx ${receipt.transactionHash})`);
}
console.log(`\n>>> next, as the DEPLOYER (it owns the .estate root), in Ring 0 packages/contracts:\n    ESTATE_LABEL=${estate} ESTATE_AGENT=${agent} AGENT_NAME_REGISTRY=0x60E949D52660A9D4143ecB0fdA56c0457f20aED9 AGENT_NAME_RESOLVER=0xa5855906C0De3813E74BEe201973071e0c844115 forge script script/AddEstateName.s.sol:AddEstateName --rpc-url "$RPC" --private-key "$KEY" --broadcast`);
