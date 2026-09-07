/**
 * "PAY ME HERE", conversationally — spec 361 I4's next family (`treasury.primary.declare`).
 *
 *   npx tsx scripts/verify-ask-primary-payee.mts [handle] [treasuryName]
 *
 * Drives the Ask the way the Home surface does: ask → answer any prompt → mint the mandate → done.
 * Then asserts the role is live ON CHAIN, which is the only place the preference actually is.
 */
import { createPublicClient, http, toHex, type Address, type Hex } from 'viem';
import { RELATIONSHIP_TYPE, ROLE } from '../packages/agent-relationships/src/index.js';
import { buildDigestBindingCaveat, capabilityHandler, registerDefaultSubsetHandlers, hashDelegation, ROOT_AUTHORITY, type Delegation, type MandateRequirementV1 } from '../packages/delegation/src/index.js';
registerDefaultSubsetHandlers();

const HOME = 'https://www.faithnet.me';
const RPC = 'https://a2a.faithnet.io/rpc';
const CHAIN = 34348;
const REL = '0x5015bD7d422e003511246f848cDd798cb00BB968' as Address;
const D = {
  dm: '0x710cb1bF08C234Df397e0910331e0A29710EF4F7', timestamp: '0x73A7B878168b7DE48677617179A8bE894f0Dfe96',
  allowedTargets: '0x2156311097A936de1916a878bF53Bfd43c7b5715', allowedMethods: '0xdBb2E47793393C499efB0f3fcbf6Ca8669791a41',
  value: '0x8759c1a6cEBF1D5069e9434EF46327Bf2ef69975', payment: '0x07fA0aE59FdE4B7ce8962d6fE7a1d648ec3DD5CE',
  digestBinding: '0xA3bb9BCC9b2F6F2419E1aBe5ED6Fd5399b9E68e1',
} as const;
const enforcers = { delegationManager: D.dm, timestamp: D.timestamp, allowedTargets: D.allowedTargets, allowedMethods: D.allowedMethods, value: D.value, payment: D.payment, digestBinding: D.digestBinding } as const;

const handle = process.argv[2] ?? 'alice';
const treasuryName = process.argv[3] ?? 'alice3.treasury';
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 300) }; } };
const pub = createPublicClient({ transport: http(RPC) });

const REL_ABI = [
  { type: 'function', name: 'getEdgeByTriple', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }, { type: 'bytes32' }], outputs: [{ type: 'bytes32' }] },
  { type: 'function', name: 'hasRole', stateMutability: 'view', inputs: [{ type: 'bytes32' }, { type: 'bytes32' }], outputs: [{ type: 'bool' }] },
] as const;

const si = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle, client_id: 'demo-jp' }) }));
const sign = async (d: Hex): Promise<Hex> => {
  const b = await j(await fetch(`${HOME}/connect/persona-sign`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${si.homeSession}` }, body: JSON.stringify({ digest: d }) }));
  if (!b.signature) throw new Error(JSON.stringify(b).slice(0, 200));
  return b.signature;
};
const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
const csrf = (await j(csrfRes)) as { token?: string };
const cookie = (csrfRes.headers.get('set-cookie') ?? '').split(';')[0];
const ask = async (body: Record<string, unknown>) =>
  j(await fetch(`${HOME}/a2a/harness/ask`, { method: 'POST', headers: { 'content-type': 'application/json', origin: HOME, cookie, 'x-csrf-token': csrf.token ?? '' }, body: JSON.stringify({ session: si.homeSession, addressee: si.agent, ...body }) }));

let r = await ask({ message: `payments to me should go to ${treasuryName}` });
const runRef = r.reply?.runRef;
for (let turn = 0; turn < 6; turn++) {
  const k = r.reply?.kind;
  if (k === 'prompt' && r.reply.prompt.kind === 'data') {
    const f = r.reply.prompt.fields[0];
    const pick = (f.choices ?? []).find((c: { label: string }) => c.label === treasuryName) ?? (f.choices ?? [])[0];
    if (!pick) throw new Error(`unanswerable prompt: ${r.reply.prompt.prompt}`);
    console.log(`  answer ${f.name} = ${pick.label}`);
    r = await ask({ runRef, supplied: [{ stepRef: r.reply.prompt.stepRef, data: { [f.name]: pick.value } }] });
  } else if (k === 'prompt' && r.reply.prompt.kind === 'signature') {
    const pr = r.reply.prompt;
    r = await ask({ runRef, supplied: [{ stepRef: pr.stepRef, signature: { digest: pr.digest, signer: pr.signer, signature: await sign(pr.digest as Hex), payload: pr.payload } }] });
  } else if (k === 'authority_required') {
    const req = r.reply.requirement as MandateRequirementV1;
    console.log(`  mandate: ${r.reply.capability} on ${r.reply.delegator}`);
    const caveats = [...capabilityHandler.toCaveats(req, enforcers as never), buildDigestBindingCaveat(D.digestBinding, 'intent', req.intentDigest as Hex)];
    const salt = BigInt(toHex(crypto.getRandomValues(new Uint8Array(16))));
    const mandate: Delegation = { delegator: r.reply.delegator, delegate: r.reply.delegate, authority: ROOT_AUTHORITY, caveats, salt, signature: '0x' };
    mandate.signature = await sign(hashDelegation(mandate, CHAIN, D.dm));
    r = await ask({ runRef, presented: [{ ...mandate, salt: salt.toString() }] });
  } else break;
}
console.log(`final: ${r.reply?.kind} — ${(r.reply?.text ?? r.reply?.error ?? '').toString().replace(/\n+/g, ' ').slice(0, 200)}`);
if (r.reply?.kind !== 'done') throw new Error(`expected done: ${JSON.stringify(r).slice(0, 400)}`);

// THE PREFERENCE IS ON CHAIN OR IT IS NOTHING — the reply is a claim; this is the fact.
const treasury = String((r.reply.result as { treasury?: string })?.treasury ?? '').toLowerCase() as Address;
const owner = String(si.agent).toLowerCase() as Address;
const edge = await pub.readContract({ address: REL, abi: REL_ABI, functionName: 'getEdgeByTriple', args: [treasury, owner, RELATIONSHIP_TYPE.CHARTERED_UNDER] }) as Hex;
const has = await pub.readContract({ address: REL, abi: REL_ABI, functionName: 'hasRole', args: [edge, ROLE.PRIMARY_PAYEE] }) as boolean;
console.log(`on chain: ${treasury} primaryPayee=${has}`);
if (!has) throw new Error('the run said done and the chain does not carry the role');

// AND THE PAYER'S RESOLVER STOPS ASKING — the whole point of the preference.
const other = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: handle === 'alice' ? 'nathan' : 'alice', client_id: 'demo-jp' }) }));
const probe = j(await fetch(`${HOME}/a2a/harness/ask`, { method: 'POST', headers: { 'content-type': 'application/json', origin: HOME, cookie, 'x-csrf-token': csrf.token ?? '' }, body: JSON.stringify({ session: other.homeSession, addressee: other.agent, message: `send ${handle} 1 usdc` }) }));
const p = await probe;
const asked = p.reply?.kind === 'prompt' ? p.reply.prompt.prompt : null;
console.log(`payer sees: ${p.reply?.kind}${asked ? ` — "${asked}"` : ''}`);
if (asked && /being paid|receive/i.test(asked)) throw new Error('the payer was still asked WHO to pay after the preference was declared');
console.log('\n✓ treasury.primary.declare: asked conversationally, granted once, recorded on chain, and the payer stopped asking.');
