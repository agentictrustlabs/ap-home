// THE ESTATE'S OWN AGENT — the agent that IS this estate, and says where its Home is.
//
// Every estate on a chain shares the name registry, so a name like `maya.me` resolves the same for all of
// them and nothing says WHICH Home custodies her. That gap is not cosmetic: a sign-in at the wrong Home
// does not fail, it derives a different Smart Agent for the same credential. So each estate gets an agent
// of its own with a name (`<estate>.estate`), each person's agent declares that NAME in `atl:estate`, and
// this agent carries the Home's URL in `atl:homepage`. The name is stable; the URL moves.
//
// This script does the estate's half, with the estate's OWN keys (never the deployer's):
//   1. derive + deploy the estate agent (salt 2 over the estate's interactions key, beside the two service
//      agents bootstrap-estate.mts deploys — same custodian, same mechanism);
//   2. register its profile and set `atl:homepage` to the Home, signed by that agent itself.
// Registering the NAME is the town's half and needs the root owner (the deployer):
//   ESTATE_LABEL=<estate> ESTATE_AGENT=<the address printed here> \
//     forge script script/AddEstateName.s.sol:AddEstateName …   (agenticprimitives/packages/contracts)
//
// Idempotent throughout: an already-deployed agent is reused, and a homepage already equal to this one is
// not rewritten. Reads the estate's keys from `.estate-<estate>.local` — never prints them.
//
//   npx tsx scripts/add-estate-agent.mts --estate imbnet --home https://imb-home.vercel.app [--dry-run]

import { existsSync, readFileSync } from 'node:fs';
import { AgentAccountClient } from '@agenticprimitives/agent-account';
import { createPublicClient, encodeFunctionData, http, keccak256, toBytes, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const arg = (k: string): string | undefined => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const estate = arg('estate');
const home = (arg('home') ?? '').trim();
const dry = process.argv.includes('--dry-run');
if (!estate || !home) { console.error('usage: add-estate-agent.mts --estate <id> --home <https://…> [--dry-run]'); process.exit(1); }
if (!/^https:\/\/[^\s/]+/.test(home)) { console.error('--home must be an https origin'); process.exit(1); }

const file = `.estate-${estate}.local`;
if (!existsSync(file)) { console.error(`${file} not found — this estate's keys are not on this machine, so its agent cannot sign here`); process.exit(1); }
const env = Object.fromEntries(
  readFileSync(file, 'utf8').split('\n').filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^'(.*)'$/, '$1')]; }),
) as Record<string, string>;

const RPC = env.RPC_URL;
const relay = env.A2A_MASTER_PRIVATE_KEY as Hex;
const interactions = env.A2A_INTERACTIONS_SESSION_PRIVATE_KEY as Hex;
if (!RPC || !relay || !interactions) { console.error(`${file} does not carry RPC_URL + the relay and interactions keys`); process.exit(1); }

const CHAIN_ID = Number(env.CHAIN_ID ?? 34348);
const ENTRY_POINT = '0xf7855250B3363AB7649B10957d8908A9AFcdD4B5' as Address;
const FACTORY = '0x464eEe7518c3c97DA570592481329E0627E9a3B8' as Address;
const PROFILE_RESOLVER = (env.PROFILE_RESOLVER ?? '0xB03F7C06ad3274F584AB72794406D639c02A45e1') as Address;
const PAYMASTER = (env.PAYMASTER ?? '0xbd93fEC6910ffD74F14709188b5a9B6C6965b2a7') as Address;
const ATL_HOMEPAGE = keccak256(toBytes('atl:homepage'));

const RESOLVER_ABI = [
  { type: 'function', name: 'isRegistered', stateMutability: 'view', inputs: [{ name: 'agent', type: 'address' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'getStringProperty', stateMutability: 'view', inputs: [{ name: 'agent', type: 'address' }, { name: 'predicate', type: 'bytes32' }], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'setStringProperty', stateMutability: 'nonpayable', inputs: [{ name: 'agent', type: 'address' }, { name: 'predicate', type: 'bytes32' }, { name: 'value', type: 'string' }], outputs: [] },
  { type: 'function', name: 'register', stateMutability: 'nonpayable', inputs: [{ name: 'agent', type: 'address' }, { name: 'displayName', type: 'string' }, { name: 'description', type: 'string' }, { name: 'agentKind', type: 'bytes32' }, { name: 'profileSchemaURI', type: 'string' }], outputs: [] },
] as const;

const chain = { id: CHAIN_ID, name: 'estate-chain', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } as const;
const pc = createPublicClient({ chain, transport: http(RPC) });
const client = new AgentAccountClient({ rpcUrl: RPC, chainId: CHAIN_ID, entryPoint: ENTRY_POINT, factory: FACTORY });

const custodian = privateKeyToAccount(interactions).address;
const spec = { custodians: [custodian] as readonly Address[], salt: 2n };
const agent = await client.getAddressForAgentAccount(spec);
console.log(`estate:        ${estate}`);
console.log(`estate agent:  ${agent}   (salt 2 over the estate's interactions key)`);
console.log(`home:          ${home}`);

const deployed = await client.isDeployed(agent).catch(() => false);
if (!deployed) {
  if (dry) console.log('would deploy the estate agent');
  else {
    console.log('deploying the estate agent…');
    await client.createAgentAccountFromPrivateKey(spec, relay);
    // The gateway caches reads: a just-created address reads as undeployed for a beat. Retry the SAME
    // call rather than reaching for another mechanism (ADR-0013).
    let now = false;
    for (let i = 0; i < 10 && !now; i++) { now = await client.isDeployed(agent).catch(() => false); if (!now) await new Promise((r) => setTimeout(r, 1500)); }
    if (!now) { console.error('  the deploy did not take — stopping rather than naming an account that is not there'); process.exit(1); }
    console.log('  deployed');
  }
} else console.log('estate agent already deployed');

const registered = deployed ? await pc.readContract({ address: PROFILE_RESOLVER, abi: RESOLVER_ABI, functionName: 'isRegistered', args: [agent] }).catch(() => false) : false;
const current = registered ? await pc.readContract({ address: PROFILE_RESOLVER, abi: RESOLVER_ABI, functionName: 'getStringProperty', args: [agent, ATL_HOMEPAGE] }).catch(() => '') : '';
if (String(current).trim() === home) { console.log(`atl:homepage already ${home} — nothing to write`); process.exit(0); }

const calls = [
  ...(registered ? [] : [{ to: PROFILE_RESOLVER, value: 0n, data: encodeFunctionData({ abi: RESOLVER_ABI, functionName: 'register', args: [agent, `${estate} estate`, `The ${estate} estate: its Home and the people under it.`, keccak256(toBytes('atl:Agent')), ''] }) }]),
  { to: PROFILE_RESOLVER, value: 0n, data: encodeFunctionData({ abi: RESOLVER_ABI, functionName: 'setStringProperty', args: [agent, ATL_HOMEPAGE, home] }) },
];
console.log(`${dry ? 'would write' : 'writing'} atl:homepage = ${home}${registered ? '' : ' (registering the profile in the same batch)'}`);
if (dry) process.exit(0);

// The agent writes its own property (`onlyAgent`), as ONE userOp its custodian signs and the estate's
// relay submits. Gas is the paymaster's, as for every other act here.
const custodianAccount = privateKeyToAccount(interactions);
try {
  const built = await client.buildUserOp({ account: agent, calls: calls.map((c) => ({ to: c.to, data: c.data, value: c.value })), paymaster: PAYMASTER });
  built.userOp.signature = await custodianAccount.signMessage({ message: { raw: built.userOpHash } });
  await client.submitCallUserOp(built.userOp, privateKeyToAccount(relay));
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  // A revert here most often means the predicate is not registered yet: `setStringProperty` is
  // predicate-active-checked, and `atl:estate`/`atl:homepage` live in the OntologyTermRegistry.
  console.error('  the write failed:', msg.slice(0, 400));
  process.exit(1);
}
const after = await pc.readContract({ address: PROFILE_RESOLVER, abi: RESOLVER_ABI, functionName: 'getStringProperty', args: [agent, ATL_HOMEPAGE] }).catch(() => '');
console.log(`  atl:homepage now: ${String(after) || '(unreadable — check the tx)'}`);
console.log('');
console.log(`>>> next, as the DEPLOYER (it owns the .estate root):`);
console.log(`    ESTATE_LABEL=${estate} ESTATE_AGENT=${agent} forge script script/AddEstateName.s.sol:AddEstateName …`);
console.log(`>>> then set NEXT_PUBLIC_ESTATE_NAME=${estate}.estate on this estate's Home and redeploy it.`);
