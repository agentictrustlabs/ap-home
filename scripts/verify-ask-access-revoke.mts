/**
 * "WHO CAN READ MY RECORDS" and "STOP THEM" — spec 361 I4's fourth family (`access.grant.revoke`).
 *
 *   npx tsx scripts/verify-ask-access-revoke.mts [handle] [clientId]
 *
 * The read runs no gate; the revoke takes one mandate and kills the delegation ON CHAIN, which is the
 * difference between this and every OAuth-shaped "disconnect": the app stops at every gate that checks,
 * not only at this Home. The assertion is `isRevoked` on the DelegationManager — a reply is a claim.
 *
 * It RE-ISSUES nothing. Run it against a demo persona whose grant you are willing to end.
 */
import { createPublicClient, http, toHex, type Address, type Hex } from 'viem';
import { buildDigestBindingCaveat, capabilityHandler, registerDefaultSubsetHandlers, hashDelegation, ROOT_AUTHORITY, type Delegation, type MandateRequirementV1 } from '../packages/delegation/src/index.js';
registerDefaultSubsetHandlers();

const HOME = 'https://www.faithnet.me';
const RPC = 'https://a2a.faithnet.io/rpc';
const CHAIN = 34348;
const DM = '0x710cb1bF08C234Df397e0910331e0A29710EF4F7' as Address;
const D = {
  dm: DM, timestamp: '0x73A7B878168b7DE48677617179A8bE894f0Dfe96',
  allowedTargets: '0x2156311097A936de1916a878bF53Bfd43c7b5715', allowedMethods: '0xdBb2E47793393C499efB0f3fcbf6Ca8669791a41',
  value: '0x8759c1a6cEBF1D5069e9434EF46327Bf2ef69975', payment: '0x07fA0aE59FdE4B7ce8962d6fE7a1d648ec3DD5CE',
  digestBinding: '0xA3bb9BCC9b2F6F2419E1aBe5ED6Fd5399b9E68e1',
} as const;
const enforcers = { delegationManager: D.dm, timestamp: D.timestamp, allowedTargets: D.allowedTargets, allowedMethods: D.allowedMethods, value: D.value, payment: D.payment, digestBinding: D.digestBinding } as const;
const IS_REVOKED_ABI = [{ type: 'function', name: 'isRevoked', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'bool' }] }] as const;

const handle = process.argv[2] ?? 'alice';
const app = process.argv[3] ?? 'field-app';
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 300) }; } };
const pub = createPublicClient({ transport: http(RPC) });

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

// ── THE READ. No mandate, no gate: your own list of who you authorized. ──
const listed = await ask({ message: 'which apps can read my records' });
console.log(`read: ${listed.reply?.kind} — ${(listed.reply?.text ?? '').replace(/\n+/g, ' ').slice(0, 160)}`);
if (listed.reply?.kind !== 'answer') throw new Error(`the audit should answer without authority: ${JSON.stringify(listed).slice(0, 300)}`);

// ── THE ACT. One mandate; the kill is on chain. ──
let r = await ask({ message: `stop ${app} from reading my records` });
const runRef = r.reply?.runRef;
for (let turn = 0; turn < 5; turn++) {
  const k = r.reply?.kind;
  if (k === 'prompt' && r.reply.prompt.kind === 'data') {
    const f = r.reply.prompt.fields[0];
    r = await ask({ runRef, supplied: [{ stepRef: r.reply.prompt.stepRef, data: { [f.name]: app } }] });
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
console.log(`revoke: ${r.reply?.kind} — ${JSON.stringify(r.reply?.result ?? r.reply?.error ?? '').slice(0, 200)}`);
if (r.reply?.kind !== 'done') throw new Error(`expected done: ${JSON.stringify(r).slice(0, 400)}`);
const res = r.reply.result as { revoked?: boolean; grantHash?: string; note?: string };
if (!res.revoked) { console.log(`nothing to revoke (${res.note ?? 'no grant'}) — run it against a persona holding one.`); process.exit(0); }

// THE CHAIN, not the reply. A revocation that only a Home believes in is the thing this replaces.
const revoked = await pub.readContract({ address: DM, abi: IS_REVOKED_ABI, functionName: 'isRevoked', args: [res.grantHash as Hex] }) as boolean;
console.log(`on chain: isRevoked(${(res.grantHash ?? '').slice(0, 12)}…) = ${revoked}`);
if (!revoked) throw new Error('the run said done and the chain still honours the grant');

// AND THE AUDIT SAYS SO — the same read, now reporting the on-chain truth.
const after = await ask({ message: 'which apps can read my records' });
console.log(`read after: ${(after.reply?.text ?? '').replace(/\n+/g, ' ').slice(0, 200)}`);
console.log('\n✓ access.grant.revoke: audited without authority, revoked with one mandate, killed on chain.');
