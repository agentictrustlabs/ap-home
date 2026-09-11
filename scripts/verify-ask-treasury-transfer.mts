/**
 * Treasury → treasury, said in words: "send 5 usdc from nathan.treasury to alice2.treasury".
 *
 *   npx tsx scripts/verify-ask-treasury-transfer.mts      (from the repo root)
 *
 * The ask names two agents BY NAME and an amount in the units a person uses. Everything the enforcers
 * need — both addresses, this deployment's token, the ceiling — is derived before the person is shown
 * what they are granting, because a mandate whose limits name a string cannot be minted and one whose
 * locations name another chain's token is worse: it mints, and it is wrong.
 */
import { toHex, keccak256, toBytes, createPublicClient, http, type Address, type Hex } from 'viem';
import { buildDigestBindingCaveat, paymentHandler, hashDelegation, ROOT_AUTHORITY, type Caveat, type Delegation, type MandateRequirementV1 } from '@agenticprimitives/delegation';

const HOME = 'https://www.faithnet.me';
const RPC = 'https://a2a.faithnet.io/rpc';
const CHAIN = 34348;
const E = {
  delegationManager: '0x710cb1bF08C234Df397e0910331e0A29710EF4F7', timestamp: '0x73A7B878168b7DE48677617179A8bE894f0Dfe96',
  allowedTargets: '0x2156311097A936de1916a878bF53Bfd43c7b5715', allowedMethods: '0xdBb2E47793393C499efB0f3fcbf6Ca8669791a41',
  value: '0x8759c1a6cEBF1D5069e9434EF46327Bf2ef69975', payment: '0x07fA0aE59FdE4B7ce8962d6fE7a1d648ec3DD5CE',
  digestBinding: '0xA3bb9BCC9b2F6F2419E1aBe5ED6Fd5399b9E68e1', usdc: '0xdaE09066A2cc32f6203605619137dcF01A9B49Ae',
} as const;
const FROM = '0x2c471607FeC409516ab6DE6b7517bcF95F1f2edc' as Address; // nathan.treasury
const TO = '0x5ef5360A41F31e55541117a854455C0dA0Fb67B3' as Address;   // alice2.treasury
const AMOUNT = 5_000_000n;

const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 300), _status: r.status }; } };
const pub = createPublicClient({ transport: http(RPC) });
const bal = (a: Address) => pub.readContract({ address: E.usdc, abi: [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }], functionName: 'balanceOf', args: [a] }) as Promise<bigint>;

const signin = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: 'nathan', client_id: 'demo-jp' }) }));
const token: string = signin.homeSession;
const sign = async (d: Hex): Promise<Hex> => {
  const b = await j(await fetch(`${HOME}/connect/persona-sign`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ digest: d }) }));
  if (!b.signature) throw new Error(`persona-sign refused: ${JSON.stringify(b).slice(0, 200)}`);
  return b.signature;
};
const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
const csrf = (await j(csrfRes)) as { token?: string };
const cookie = (csrfRes.headers.get('set-cookie') ?? '').split(';')[0];
const post = async (body: unknown) => j(await fetch(`${HOME}/a2a/harness/ask`, { method: 'POST', headers: { 'content-type': 'application/json', origin: HOME, cookie, 'x-csrf-token': csrf.token ?? '' }, body: JSON.stringify(body) }));

const before = { from: await bal(FROM), to: await bal(TO) };
console.log(`nathan.treasury ${before.from}  alice2.treasury ${before.to}`);
const runRef = `xfer-${Date.now().toString(36)}`;
let r = await post({ session: token, addressee: signin.agent, message: 'send 5 usdc from nathan.treasury to alice2.treasury', runRef });
console.log(`1 ${r.reply?.kind} ${r.reply?.capability ?? ''} as ${r.reply?.delegator ?? ''}`);
if (r.reply?.kind !== 'authority_required') throw new Error(`expected authority: ${JSON.stringify(r).slice(0, 400)}`);

// Everything the enforcers need, derived from the words — not from the planner's memory.
const req = r.reply.requirement as MandateRequirementV1;
if (String(req.limits?.asset).toLowerCase() !== E.usdc.toLowerCase()) throw new Error(`the mandate names the wrong token: ${req.limits?.asset}`);
if ((req.locations ?? []).some((l) => l.toLowerCase() !== E.usdc.toLowerCase())) throw new Error(`locations name a token this chain does not have: ${JSON.stringify(req.locations)}`);
if (String(req.limits?.payee).toLowerCase() !== TO.toLowerCase()) throw new Error(`the payee is not alice2.treasury: ${req.limits?.payee}`);
if (r.reply.delegator.toLowerCase() !== FROM.toLowerCase()) throw new Error(`the payer is not nathan.treasury: ${r.reply.delegator}`);

const caveats: Caveat[] = [...paymentHandler.toCaveats(req, E as never), buildDigestBindingCaveat(E.digestBinding, 'intent', req.intentDigest as Hex)];
const salt = BigInt(toHex(crypto.getRandomValues(new Uint8Array(16))));
const d: Delegation = { delegator: r.reply.delegator, delegate: r.reply.delegate, authority: ROOT_AUTHORITY, caveats, salt, signature: '0x' };
d.signature = await sign(hashDelegation(d, CHAIN, E.delegationManager));
r = await post({ session: token, addressee: signin.agent, runRef, presented: { ...d, salt: salt.toString() } });
console.log(`2 ${r.reply?.kind} ${r.reply?.kind === 'prompt' ? `"${r.reply.prompt.prompt.slice(0, 60)}"` : ''}`);

// A payment is HIGH risk: the ladder wants a second party, and it asks for the signature rather than refusing.
if (r.reply?.kind === 'prompt' && r.reply.prompt.kind === 'signature') {
  const p = r.reply.prompt as { digest: Hex; signer: string };
  r = await post({ session: token, addressee: signin.agent, runRef, supplied: [{ stepRef: (r.reply as { resumeToken: string }).resumeToken, signature: { digest: p.digest, signer: p.signer || signin.agent, signature: await sign(p.digest) } }] });
  console.log(`3 ${r.reply?.kind} ${JSON.stringify(r.reply?.result ?? r.reply?.error ?? '').slice(0, 160)}`);
}
if (r.reply?.kind !== 'done') throw new Error(`the transfer did not complete: ${JSON.stringify(r).slice(0, 500)}`);
const after = { from: await bal(FROM), to: await bal(TO) };
console.log(`tx ${r.reply.result?.txHash}\n  nathan.treasury ${before.from} → ${after.from}\n  alice2.treasury ${before.to} → ${after.to}`);
if (before.from - after.from !== AMOUNT || after.to - before.to !== AMOUNT) throw new Error('the USDC did not move as asked');
console.log('\n✓ "send 5 usdc from nathan.treasury to alice2.treasury" — named agents resolved, this chain\'s token pinned, approved in the conversation, 5 USDC moved.');
