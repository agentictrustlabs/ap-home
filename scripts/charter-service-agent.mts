// CHARTER A SERVICE AGENT — a Smart Agent custodied by a key its owner holds, typed on its own profile (spec 346
// §3.6 step 1b, `buildDeclareAgentTypeCalls`). No name is bought here: a name is a facet (ADR-0010) and every gate
// that matters reads the TYPE record, not a suffix. The relay pays gas; the paymaster sponsors the declaration
// userOps. Idempotent: an existing account and an existing declaration are left as they are.
//
// Three custody shapes, because three exist in this world — and the FIRST is the one to reach for: an agent belongs
// to an estate, so a person of THAT estate should custody it, not a service key and not another estate's roster.
//   --home <url> --by <handle>   the custodian is a persona of that estate, whose key lives at its Home. The address
//                                is recovered from a probe signature (the Home signs; the key never leaves it), and
//                                every userOp below is signed the same way.
//   --persona <handle>           the key is a demo persona's, from demo/personas.local.json (the faithnet roster)
//   CUSTODIAN_KEY_ENV_FILE + …   the key is in a 0600 env file. An estate's INTERACTIONS key works and is the wrong
//                                choice for anything an estate's people should own: it is the runtime's secret.
//
// Used for: a visiting agent's treasury (spec 439 §6), and each estate's `.registry` service agent — the one §4 says
// must be what anchors that estate's roots.
//
//   RPC_URL=… RELAY_PRIVATE_KEY_FILE=~/.faithchain-deployer.key \
//   npx tsx scripts/charter-service-agent.mts --type registry --service-role registry --persona demo-admin --salt 3 --display "faithnet registry"
//   … --type treasury CUSTODIAN_KEY_ENV_FILE=…/f3-visitor-payee.env CUSTODIAN_KEY_VAR=F3_VISITOR_PAYEE_KEY
import { readFileSync } from 'node:fs';
import { AgentAccountClient, buildExecuteCallData } from '@agenticprimitives/agent-account';
import { buildDeclareAgentTypeCalls } from '@agenticprimitives/agent-naming';
import { createPublicClient, decodeEventLog, encodeFunctionData, http, keccak256, recoverMessageAddress, toBytes, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const arg = (k: string): string | undefined => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const salt = BigInt(arg('salt') ?? '0'); const display = arg('display') ?? 'service agent'; const dry = process.argv.includes('--dry-run');
const agentType = (arg('type') ?? 'treasury') as 'treasury' | 'registry' | 'service' | 'workspace';
// ADR-0061: `registry` and `workspace` are role-typed — the serviceRole MUST equal the type name, and the builder
// refuses otherwise. Said here so the refusal is a sentence rather than a throw from inside a package.
const serviceRole = arg('service-role') ?? (agentType === 'registry' || agentType === 'workspace' ? agentType : undefined);
const persona = arg('persona'); const home = arg('home'); const by = arg('by');
// WHOSE ESTATE THIS AGENT IS ON (`atl:estate` = that estate agent's NAME, e.g. `imbnet.estate`). A person's agent
// carries it and so should a service agent: an agent that cannot say which estate it belongs to is one a reader has
// to guess about, and the estate is the thing that answers for it.
const estateName = arg('estate');
const RPC = process.env.RPC_URL ?? (() => { console.error('RPC_URL is required'); process.exit(1); })();
const relayFile = (process.env.RELAY_PRIVATE_KEY_FILE ?? '').replace(/^~/, process.env.HOME ?? '');
const relayKey = (process.env.RELAY_PRIVATE_KEY ?? (relayFile ? readFileSync(relayFile, 'utf8').trim() : '')) as Hex;
const envFile = process.env.CUSTODIAN_KEY_ENV_FILE ?? ''; const varName = process.env.CUSTODIAN_KEY_VAR ?? 'CUSTODIAN_PRIVATE_KEY';
const fromRoster = persona ? ((JSON.parse(readFileSync('demo/personas.local.json', 'utf8')) as Record<string, { eoaPrivateKey?: string }>)[persona]?.eoaPrivateKey ?? '') : '';
if (persona && !fromRoster) { console.error(`no persona ${persona} with a key in demo/personas.local.json`); process.exit(1); }
const custodianKey = (fromRoster || process.env.CUSTODIAN_PRIVATE_KEY || (envFile ? (new RegExp(`^${varName}=['"]?(0x[0-9a-fA-F]{64})`, 'm').exec(readFileSync(envFile, 'utf8'))?.[1] ?? '') : '')) as Hex;

// THE HOME-CUSTODIED SHAPE. The persona's key stays at its Home; this asks the Home to sign, and recovers the
// custodian's ADDRESS from a probe signature so the account can be derived without the key ever being here.
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t) as Record<string, unknown>; } catch { return { _raw: t.slice(0, 200) }; } };
let homeSign: ((digest: Hex) => Promise<Hex>) | null = null;
let homeCustodian: Address | null = null;
if (home && by) {
  const signin = await j(await fetch(`${home}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: by, client_id: 'demo-jp' }) }));
  const token = String(signin.homeSession ?? '');
  if (!token) { console.error(`no session for ${by} at ${home}: ${JSON.stringify(signin).slice(0, 160)}`); process.exit(1); }
  homeSign = async (digest: Hex) => {
    const b = await j(await fetch(`${home}/connect/persona-sign`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ digest }) }));
    if (!b.signature) throw new Error(String(b.error ?? 'persona-sign refused'));
    return b.signature as Hex;
  };
  const probe = keccak256(toBytes(`ap-federation charter probe ${Date.now()}`));
  homeCustodian = (await recoverMessageAddress({ message: { raw: probe }, signature: await homeSign(probe) })).toLowerCase() as Address;
  console.log(`custodian: ${by} at ${home} → ${homeCustodian} (recovered from a probe the Home signed; the key stayed there)`);
}
if (!/^0x[0-9a-fA-F]{64}$/.test(relayKey) || (!homeSign && !/^0x[0-9a-fA-F]{64}$/.test(custodianKey))) { console.error('RELAY_PRIVATE_KEY(_FILE) and a custodian (--home <url> --by <handle>, or --persona <handle>, or CUSTODIAN_PRIVATE_KEY, or CUSTODIAN_KEY_ENV_FILE + CUSTODIAN_KEY_VAR) are required'); process.exit(1); }
const CHAIN_ID = Number(process.env.CHAIN_ID ?? 34348);
// ENTRY_POINT / FACTORY are overridable like the rest: a second chain has its own factory (hopechain 0x73A7B878…), and a
// charter against faithchain's factory there reverts at getAddressForAgentAccount before it can say why.
const ENTRY_POINT = (process.env.ENTRY_POINT ?? '0xf7855250B3363AB7649B10957d8908A9AFcdD4B5') as Address; const FACTORY = (process.env.FACTORY ?? '0x464eEe7518c3c97DA570592481329E0627E9a3B8') as Address;
const PROFILE_RESOLVER = (process.env.PROFILE_RESOLVER ?? '0xB03F7C06ad3274F584AB72794406D639c02A45e1') as Address; const PAYMASTER = (process.env.PAYMASTER ?? '0xbd93fEC6910ffD74F14709188b5a9B6C6965b2a7') as Address;
const localCustodian = /^0x[0-9a-fA-F]{64}$/.test(custodianKey) ? privateKeyToAccount(custodianKey) : null;
const custodianAddress = (homeCustodian ?? localCustodian!.address.toLowerCase()) as Address;
const signUserOp = homeSign ?? ((digest: Hex) => localCustodian!.signMessage({ message: { raw: digest } }));
const relay = privateKeyToAccount(relayKey);
const chain = { id: CHAIN_ID, name: 'c', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } as const;
const pc = createPublicClient({ chain, transport: http(RPC) });
const client = new AgentAccountClient({ rpcUrl: RPC, chainId: CHAIN_ID, entryPoint: ENTRY_POINT, factory: FACTORY });
const spec = { custodians: [custodianAddress] as readonly Address[], salt };
const agent = await client.getAddressForAgentAccount(spec);
let deployed = await client.isDeployed(agent).catch(() => false);
console.log(`${agentType}: ${agent} (salt ${salt} over ${by ?? persona ?? ''} ${custodianAddress}) — ${deployed ? 'deployed' : 'not deployed'}`);
if (!deployed) {
  if (dry) { console.log('would deploy'); } else {
    await client.createAgentAccountFromPrivateKey(spec, relayKey);
    for (let i = 0; i < 10 && !deployed; i++) { deployed = await client.isDeployed(agent).catch(() => false); if (!deployed) await new Promise((r) => setTimeout(r, 1500)); }
    if (!deployed) { console.error('the deploy did not take'); process.exit(1); }
    console.log('  deployed');
  }
}
const ATL_ESTATE = keccak256(toBytes('atl:estate'));
const ABI = [{ type: 'function', name: 'isRegistered', stateMutability: 'view', inputs: [{ name: 'agent', type: 'address' }], outputs: [{ type: 'bool' }] }, { type: 'function', name: 'getBytes32Property', stateMutability: 'view', inputs: [{ name: 'agent', type: 'address' }, { name: 'predicate', type: 'bytes32' }], outputs: [{ type: 'bytes32' }] },
  { type: 'function', name: 'getStringProperty', stateMutability: 'view', inputs: [{ name: 'agent', type: 'address' }, { name: 'predicate', type: 'bytes32' }], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'setStringProperty', stateMutability: 'nonpayable', inputs: [{ name: 'agent', type: 'address' }, { name: 'predicate', type: 'bytes32' }, { name: 'value', type: 'string' }], outputs: [] }] as const;
const registered = deployed ? await pc.readContract({ address: PROFILE_RESOLVER, abi: ABI, functionName: 'isRegistered', args: [agent] }).catch(() => false) : false;
const typeNow = registered ? await pc.readContract({ address: PROFILE_RESOLVER, abi: ABI, functionName: 'getBytes32Property', args: [agent, keccak256(toBytes('atl:agentType'))] }).catch(() => '0x') : '0x';
const estateNow = registered && estateName ? String(await pc.readContract({ address: PROFILE_RESOLVER, abi: ABI, functionName: 'getStringProperty', args: [agent, ATL_ESTATE] }).catch(() => '')) : '';
const estateCall = estateName && estateNow.trim() !== estateName
  ? [{ to: PROFILE_RESOLVER, value: 0n, data: encodeFunctionData({ abi: ABI, functionName: 'setStringProperty', args: [agent, ATL_ESTATE, estateName] }) }]
  : [];
if (registered && typeNow && !/^0x0*$/.test(String(typeNow)) && !estateCall.length) { console.log(`  atl:agentType already declared (${typeNow})${estateName ? ` and atl:estate is ${estateNow}` : ''} — nothing to write\n${agent}`); process.exit(0); }
const typeCalls = registered && typeNow && !/^0x0*$/.test(String(typeNow)) ? [] : buildDeclareAgentTypeCalls({ profileResolver: PROFILE_RESOLVER, agent, agentType, ...(serviceRole ? { serviceRole } : {}), registered, displayName: display });
const calls = [...typeCalls, ...estateCall];
for (const c of calls) console.log(`${dry ? 'would send' : 'sending'} ${c.data.slice(0, 10)} → ${c.to}`);
if (dry) process.exit(0);
const OP_EVENT = { type: 'event', name: 'UserOperationEvent', inputs: [{ name: 'userOpHash', type: 'bytes32', indexed: true }, { name: 'sender', type: 'address', indexed: true }, { name: 'paymaster', type: 'address', indexed: true }, { name: 'nonce', type: 'uint256' }, { name: 'success', type: 'bool' }, { name: 'actualGasCost', type: 'uint256' }, { name: 'actualGasUsed', type: 'uint256' }] } as const;
for (const c of calls) {
  const built = await client.buildCallUserOp({ sender: agent, callData: buildExecuteCallData({ to: c.to, value: c.value ?? 0n, data: c.data }), paymaster: PAYMASTER });
  built.userOp.signature = await signUserOp(built.userOpHash);
  const { receipt } = await client.submitCallUserOp(built.userOp, relay);
  let ok: boolean | null = null;
  for (const log of receipt.logs) { try { ok = decodeEventLog({ abi: [OP_EVENT], data: log.data, topics: log.topics }).args.success as boolean; } catch { /* another event */ } }
  if (receipt.status !== 'success' || ok === false) { console.error(`  a declaration userOp failed (tx ${receipt.transactionHash})`); process.exit(1); }
  console.log(`  done (tx ${receipt.transactionHash})`);
}
console.log(agent);
