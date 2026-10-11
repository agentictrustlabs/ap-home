// Present an already-registered name from its owner's Smart Agent (ap-town spec 431). The Home's purchase flow does
// this as its second signed operation (`setPrimaryName` + the name's records); when that step is interrupted the name
// is bought and registered but the agent still "presents no public name", and the Naming page offers no way to
// present a name it already owns. This finishes that step for a demo persona: the roster's custodian EOA signs the
// owner SA's userOp through this estate's relayer. One signed operation per persona; nothing is bought here.
//
//   npx tsx scripts/present-estate-names.mts --estate imbnet --home https://imb-home.vercel.app priya=priyaraghavan.me tomas=tomas-vargas.me
import { readFileSync } from 'node:fs';
import { keccak256, toBytes, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { buildExecuteBatchCallData, type ContractCall } from '@agenticprimitives/agent-account';
import { buildSetPrimaryNameCall, buildSetAddressAttributeCall, buildSetBytes32AttributeCall, buildSetStringAttributeCall, namehash, PREDICATE_ID, AGENT_KIND_ID } from '@agenticprimitives/agent-naming';
import { CONTRACTS } from '@agenticprimitives/contracts/deployments/faithchain';

const args = process.argv.slice(2);
const opt = (k: string): string | undefined => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };
const estate = opt('estate') ?? 'imbnet'; const HOME = opt('home') ?? 'https://imb-home.vercel.app';
const pairs = args.filter((a) => /^[a-z0-9-]+=[a-z0-9-]+\.[a-z]+$/i.test(a)).map((a) => a.split('=') as [string, string]);
if (!pairs.length) throw new Error('name at least one handle=name.tld');
type Persona = { sa: Address; eoaPrivateKey: Hex; name: string; blurb?: string };
const roster = JSON.parse(readFileSync(`demo/personas.${estate}.json`, 'utf8')) as Record<string, Persona>;
const registry = (CONTRACTS as Record<string, string>).agentNameRegistry as Address; const resolver = (CONTRACTS as Record<string, string>).agentNameResolver as Address;
if (!registry || !resolver) throw new Error('faithchain deployments name no agentNameRegistry/agentNameResolver');
const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
const csrf = (await csrfRes.json()) as { token?: string };
const H = { 'content-type': 'application/json', origin: HOME, cookie: (csrfRes.headers.get('set-cookie') ?? '').split(';')[0] ?? '', 'x-csrf-token': csrf.token ?? '' };
const post = async (p: string, body: unknown) => (await fetch(`${HOME}/a2a${p}`, { method: 'POST', headers: H, body: JSON.stringify(body) })).json() as Promise<Record<string, unknown>>;

for (const [handle, name] of pairs) {
  const p = roster[handle]; if (!p) throw new Error(`${handle} is not in demo/personas.${estate}.json`);
  const node = namehash(name.toLowerCase());
  const calls: ContractCall[] = [
    buildSetPrimaryNameCall({ registry, node }),
    buildSetAddressAttributeCall({ resolver, node, predicate: PREDICATE_ID.addr, value: p.sa }),
    buildSetBytes32AttributeCall({ resolver, node, predicate: PREDICATE_ID.agentKind, value: AGENT_KIND_ID.person }),
    buildSetStringAttributeCall({ resolver, node, predicate: PREDICATE_ID.displayName, value: p.name.slice(0, 80) }),
    ...(p.blurb ? [buildSetStringAttributeCall({ resolver, node, predicate: keccak256(toBytes('atl:description')), value: p.blurb.slice(0, 280) })] : []),
  ];
  const b = await post('/account/build-call-userop', { sender: p.sa, callData: buildExecuteBatchCallData(calls) });
  if (!b.ok) throw new Error(`${handle}: build-call-userop ${JSON.stringify(b).slice(0, 300)}`);
  const signature = await privateKeyToAccount(p.eoaPrivateKey).signMessage({ message: { raw: b.userOpHash as Hex } });
  const s = await post('/account/submit-call-userop', { userOp: { ...(b.userOp as object), signature } });
  if (!s.ok) throw new Error(`${handle}: submit-call-userop ${JSON.stringify(s).slice(0, 300)}`);
  console.log(`${handle}: presents ${name} (${p.name}) tx ${String(s.txHash ?? s.userOpHash ?? '')}`);
}
