// DECLARE WHICH ESTATE AN AGENT IS ON — the backfill behind `atl:estate`.
//
// The Home writes this for a person at onboarding, and on a later visit for anyone enrolled before it
// existed — but only where the custody is PROMPTLESS (a passkey or wallet home is not asked for a
// signature by a page load). This script is for the rest: an operator declaring for agents whose
// custodian key is already in hand, with the person's own account doing the writing either way.
//
// It writes the same record the Home writes, by the same rail: `atl:estate` on the AgentProfileResolver,
// holding the estate agent's NAME (`imbnet.estate`). The name is stable; the Home URL it leads to lives
// on that estate agent's `atl:homepage`.
//
//   npx tsx scripts/declare-estate.mts --estate imbnet --estate-name imbnet.estate --persona maya [--dry-run]
//   npx tsx scripts/declare-estate.mts --estate imbnet --estate-name imbnet.estate --all
//
// Personas come from `demo/personas.<estate>.json` (0600, their custodian keys — never printed). An agent
// whose key is NOT here cannot be declared for: the record is the agent's own statement, and nothing here
// can make it on their behalf.

import { existsSync, readFileSync } from 'node:fs';
import { AgentAccountClient, buildExecuteCallData } from '@agenticprimitives/agent-account';
import { buildRegisterProfileCall } from '@agenticprimitives/agent-profile';
import { createPublicClient, decodeEventLog, encodeFunctionData, http, keccak256, toBytes, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const arg = (k: string): string | undefined => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const estate = arg('estate');
const estateName = (arg('estate-name') ?? (estate ? `${estate}.estate` : '')).trim().toLowerCase();
const only = arg('persona');
const all = process.argv.includes('--all');
const dry = process.argv.includes('--dry-run');
if (!estate || !estateName || (!only && !all)) { console.error('usage: declare-estate.mts --estate <id> [--estate-name <x.estate>] (--persona <handle> | --all) [--dry-run]'); process.exit(1); }

const keyFile = `.estate-${estate}.local`;
const personaFile = `demo/personas.${estate}.json`;
for (const f of [keyFile, personaFile]) if (!existsSync(f)) { console.error(`${f} not found — this estate's keys are not on this machine`); process.exit(1); }
const env = Object.fromEntries(readFileSync(keyFile, 'utf8').split('\n').filter((l) => l.includes('=') && !l.trim().startsWith('#'))
  .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^'(.*)'$/, '$1')]; })) as Record<string, string>;
const personas = JSON.parse(readFileSync(personaFile, 'utf8')) as Record<string, { sa: Address; eoaPrivateKey: Hex; name?: string }>;

const RPC = env.RPC_URL;
const relay = env.A2A_MASTER_PRIVATE_KEY as Hex;
if (!RPC || !relay) { console.error(`${keyFile} does not carry RPC_URL + the relay key`); process.exit(1); }
const CHAIN_ID = Number(env.CHAIN_ID ?? 34348);
const ENTRY_POINT = '0xf7855250B3363AB7649B10957d8908A9AFcdD4B5' as Address;
const FACTORY = '0x464eEe7518c3c97DA570592481329E0627E9a3B8' as Address;
const PROFILE_RESOLVER = (env.PROFILE_RESOLVER ?? '0xB03F7C06ad3274F584AB72794406D639c02A45e1') as Address;
const PAYMASTER = (env.PAYMASTER ?? '0xbd93fEC6910ffD74F14709188b5a9B6C6965b2a7') as Address;
const ATL_ESTATE = keccak256(toBytes('atl:estate'));

const RESOLVER_ABI = [
  { type: 'function', name: 'isRegistered', stateMutability: 'view', inputs: [{ name: 'agent', type: 'address' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'getStringProperty', stateMutability: 'view', inputs: [{ name: 'agent', type: 'address' }, { name: 'predicate', type: 'bytes32' }], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'setStringProperty', stateMutability: 'nonpayable', inputs: [{ name: 'agent', type: 'address' }, { name: 'predicate', type: 'bytes32' }, { name: 'value', type: 'string' }], outputs: [] },
] as const;
const OP_EVENT = { type: 'event', name: 'UserOperationEvent', inputs: [
  { name: 'userOpHash', type: 'bytes32', indexed: true }, { name: 'sender', type: 'address', indexed: true },
  { name: 'paymaster', type: 'address', indexed: true }, { name: 'nonce', type: 'uint256' },
  { name: 'success', type: 'bool' }, { name: 'actualGasCost', type: 'uint256' }, { name: 'actualGasUsed', type: 'uint256' }] } as const;

const chain = { id: CHAIN_ID, name: 'estate-chain', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } as const;
const pc = createPublicClient({ chain, transport: http(RPC) });
const client = new AgentAccountClient({ rpcUrl: RPC, chainId: CHAIN_ID, entryPoint: ENTRY_POINT, factory: FACTORY });
const bundler = privateKeyToAccount(relay);

/** ONE call as ONE userOp, with the ENTRYPOINT's verdict read back: a 4337 transaction succeeds even when
 *  the call inside the account reverted, so the tx receipt alone reports writes that never happened. */
async function send(sender: Address, custodian: Hex, call: { to: Address; value: bigint; data: Hex }, what: string): Promise<boolean> {
  const built = await client.buildCallUserOp({ sender, callData: buildExecuteCallData(call), paymaster: PAYMASTER });
  built.userOp.signature = await privateKeyToAccount(custodian).signMessage({ message: { raw: built.userOpHash } });
  const { receipt } = await client.submitCallUserOp(built.userOp, bundler);
  if (receipt.status !== 'success') { console.error(`    ${what}: the transaction reverted (${receipt.transactionHash})`); return false; }
  let ok: boolean | null = null;
  for (const log of receipt.logs) { try { ok = decodeEventLog({ abi: [OP_EVENT], data: log.data, topics: log.topics }).args.success as boolean; } catch { /* another event */ } }
  if (ok === false) { console.error(`    ${what}: the userOp reverted inside the account (${receipt.transactionHash})`); return false; }
  return true;
}

const handles = only ? [only] : Object.keys(personas);
console.log(`estate ${estate} → ${estateName}`);
let done = 0;
for (const handle of handles) {
  const p = personas[handle];
  if (!p?.sa || !p.eoaPrivateKey) { console.error(`  ${handle}: no agent + custodian key in ${personaFile}`); continue; }
  const sa = p.sa as Address;
  const registered = await pc.readContract({ address: PROFILE_RESOLVER, abi: RESOLVER_ABI, functionName: 'isRegistered', args: [sa] }).catch(() => false);
  const current = registered ? String(await pc.readContract({ address: PROFILE_RESOLVER, abi: RESOLVER_ABI, functionName: 'getStringProperty', args: [sa, ATL_ESTATE] }).catch(() => '')).trim() : '';
  if (current.toLowerCase() === estateName) { console.log(`  ${handle} (${sa}): already declares ${estateName}`); done++; continue; }
  if (dry) { console.log(`  ${handle} (${sa}): would declare ${estateName}${registered ? '' : ' (registering the profile first)'}`); continue; }
  if (!registered) {
    const r = buildRegisterProfileCall({ profileResolver: PROFILE_RESOLVER, agent: sa, displayName: p.name ?? handle });
    if (!(await send(sa, p.eoaPrivateKey, { to: r.to, value: r.value ?? 0n, data: r.data }, 'register the profile'))) continue;
  }
  const set = { to: PROFILE_RESOLVER, value: 0n, data: encodeFunctionData({ abi: RESOLVER_ABI, functionName: 'setStringProperty', args: [sa, ATL_ESTATE, estateName] }) };
  if (!(await send(sa, p.eoaPrivateKey, set, 'set atl:estate'))) continue;
  const after = String(await pc.readContract({ address: PROFILE_RESOLVER, abi: RESOLVER_ABI, functionName: 'getStringProperty', args: [sa, ATL_ESTATE] }).catch(() => ''));
  console.log(`  ${handle} (${sa}): ${after === estateName ? `declares ${after}` : `WROTE BUT READ BACK ${JSON.stringify(after)}`}`);
  if (after === estateName) done++;
}
console.log(`${done}/${handles.length} declared`);
