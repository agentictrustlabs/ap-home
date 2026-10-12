/**
 * GIVE AN ESTATE'S HOME ITS OWN NAMING GATE — a ticket signer the priced roots accept.
 *
 *   npx tsx scripts/add-naming-gate.mts --estate imbnet
 *
 * A paid name (spec 431) is claimed with an EIP-712 ClaimTicketV1 signed by a GATE the PricedSubregistry
 * allows (`gates(address)`), and each Home signs tickets with its own NAMING_GATE_PRIVATE_KEY. The set is
 * governed by `naming.svc` — a TOWN agent custodied by the town clerk — so adding a gate is a town act:
 * one `execute` batch from naming.svc calling `setGate(gate, true)` on every priced root, signed by the
 * clerk's key, relayed through the faithnet Home (faithchain gas is free; the paymaster is in allowlist mode).
 *
 * One gate per Home: imbnet's is minted here and never shared with faithnet's, so either can be revoked
 * (`setGate(gate, false)`) without touching the other.
 */
import { createPublicClient, http, parseAbi, encodeFunctionData, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { buildExecuteBatchCallData, type ContractCall } from '@agenticprimitives/agent-account';

const arg = (n: string) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
const estate = arg('--estate') ?? 'imbnet';
const HOME = 'https://www.faithnet.me'; // the TOWN's relayer: naming.svc is the town's agent, not the estate's
const NAMING_SVC = '0x8e6F25eb905677ee80fEc3F8742A8cd143a998e9' as Address;
const PRICED: Record<string, Address> = { me:'0xFEe352298dD12554928c8de2bdA5cf7bbeD9C184', org:'0x2cf2eA7D2302b3390FA3596acbd8821193f296D4', team:'0x5D95fBb3a5B97fF4967aC5587c607B1d9D7DE216', svc:'0x7976bcE1BE0184A738BecF42AF7428065229a42F', workspace:'0x7e1639F35192aab59E1Bc349cD333139BFdA0C86', treasury:'0xb7b6E31D17bBbC7E71741DAbB7d062A26f776902', registry:'0x62e65f085aBEf2cdF9Cf63bf854a363aF75a3F28', church:'0x2404f292187faeCaeD7ceED9F0954Cc3311AB250', circle:'0x15D890374B5BD6D41ADF062Ec25953c7E236c463', household:'0x938eD1296Da9A092A55AEC4F478B667C5b14d09d' };
const abi = parseAbi(['function gates(address) view returns (bool)', 'function setGate(address gate, bool allowed)']);

const envFile = `.estate-${estate}.local`;
let env = readFileSync(envFile, 'utf8');
const rpc = /^RPC_URL='?([^'\n]+)'?$/m.exec(env)?.[1]; if (!rpc) throw new Error('RPC_URL missing from estate file');
let gateKey = /^NAMING_GATE_PRIVATE_KEY='?(0x[0-9a-f]{64})'?$/m.exec(env)?.[1] as Hex | undefined;
if (!gateKey) { gateKey = generatePrivateKey(); env = env.replace(/\n?$/, `\nNAMING_GATE_PRIVATE_KEY='${gateKey}'\n`); writeFileSync(envFile, env, { mode: 0o600 }); chmodSync(envFile, 0o600); console.log('minted a new gate key for', estate); }
const gate = privateKeyToAccount(gateKey).address;
const clerk = privateKeyToAccount((JSON.parse(readFileSync('/home/barb/ap-town/.townclerk-key.local.json', 'utf8')) as { privateKey: Hex }).privateKey);
console.log(`gate ${gate}  clerk ${clerk.address}  governor ${NAMING_SVC}`);

const pc = createPublicClient({ transport: http(rpc) });
const todo = (await Promise.all(Object.entries(PRICED).map(async ([tld, sub]) => [tld, sub, await pc.readContract({ address: sub, abi, functionName: 'gates', args: [gate] })] as const))).filter(([, , ok]) => !ok);
if (!todo.length) { console.log('already a gate on every priced root'); process.exit(0); }
const calls: ContractCall[] = todo.map(([, sub]) => ({ to: sub, value: 0n, data: encodeFunctionData({ abi, functionName: 'setGate', args: [gate, true] }) }));

const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
const csrf = (await csrfRes.json()) as { token?: string };
const H = { 'content-type': 'application/json', origin: HOME, cookie: (csrfRes.headers.get('set-cookie') ?? '').split(';')[0] ?? '', 'x-csrf-token': csrf.token ?? '' };
const post = async (p: string, body: unknown) => (await fetch(`${HOME}/a2a${p}`, { method: 'POST', headers: H, body: JSON.stringify(body) })).json() as Promise<Record<string, unknown>>;
const callData = buildExecuteBatchCallData(calls);
let tx: Hex | undefined;
for (let i = 0; i < 6 && !tx; i++) {
  const b = await post('/account/build-call-userop', { sender: NAMING_SVC, callData });
  if (!b.ok) throw new Error(`build-call-userop: ${JSON.stringify(b).slice(0, 300)}`);
  const signature = await clerk.signMessage({ message: { raw: b.userOpHash as Hex } });
  const s = await post('/account/submit-call-userop', { userOp: { ...(b.userOp as object), signature } });
  if (s.ok) tx = s.transactionHash as Hex;
  else if (/AA25|nonce/i.test(JSON.stringify(s))) await new Promise((r) => setTimeout(r, 3000));
  else throw new Error(`submit-call-userop: ${JSON.stringify(s).slice(0, 300)}`);
}
console.log('setGate tx', tx, 'on', todo.map(([t]) => t).join(','));
// The gateway caches reads — bounded retry of the same read, never a second mechanism.
for (let i = 0; i < 10; i++) { const ok = await pc.readContract({ address: PRICED.me, abi, functionName: 'gates', args: [gate] }); if (ok) { console.log('gates(me) =', ok); process.exit(0); } await new Promise((r) => setTimeout(r, 1500)); }
console.error('gate not visible after the tx — stopping rather than claiming it took'); process.exit(1);
