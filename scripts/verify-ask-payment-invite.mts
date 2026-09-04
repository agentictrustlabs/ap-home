/**
 * Spec 350 W2 — the two remaining reference scenarios, driven through the ASK exactly as the Home's
 * flyout drives it: paying between treasuries, and inviting a member.
 *
 *   npx tsx scripts/verify-ask-payment-invite.mts          (from the repo root)
 *
 * What each proves beyond "it worked":
 *   payment  the authority a payment needs is the PAYER's, never the token it moves (the mandate's
 *            delegator is the org; `locations` pins the asset), and the ladder's second-party approval
 *            is SIGNED IN THE CONVERSATION rather than pre-supplied — same digest, same ERC-1271 check.
 *   invite   an organization grants the INVITATION, not the membership: what comes back is a signed
 *            org → invitee access grant the invitee redeems on join.
 */
import { createPublicClient, http, toHex, type Address, type Hex } from 'viem';
import {
  buildDigestBindingCaveat, capabilityHandler, paymentHandler, hashDelegation, ROOT_AUTHORITY,
  type Caveat, type Delegation, type MandateRequirementV1,
} from '../packages/delegation/src/index.js';

const HOME = 'https://www.faithnet.me';
const RPC = 'https://a2a.faithnet.io/rpc';
const CHAIN = 34348;
const E = {
  delegationManager: '0x710cb1bF08C234Df397e0910331e0A29710EF4F7', timestamp: '0x73A7B878168b7DE48677617179A8bE894f0Dfe96',
  allowedTargets: '0x2156311097A936de1916a878bF53Bfd43c7b5715', allowedMethods: '0xdBb2E47793393C499efB0f3fcbf6Ca8669791a41',
  value: '0x8759c1a6cEBF1D5069e9434EF46327Bf2ef69975', payment: '0x07fA0aE59FdE4B7ce8962d6fE7a1d648ec3DD5CE',
  digestBinding: '0xA3bb9BCC9b2F6F2419E1aBe5ED6Fd5399b9E68e1', usdc: '0xdaE09066A2cc32f6203605619137dcF01A9B49Ae',
} as const;
const ORG = '0x3b99f2b452766de5df0dbcdfc676f27257151333' as Address;      // Missio Nexus — Alice stewards it, it holds the USDC
const PAYEE = '0x8c5cddca27c088a65e58e94403acdc9bc3eb7fe3' as Address;    // bob.me
const AMOUNT = 25_000_000n;                                                // 25 USDC

const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 400), _status: r.status }; } };
const pub = createPublicClient({ transport: http(RPC) });
const bal = (a: Address) => pub.readContract({ address: E.usdc, abi: [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }], functionName: 'balanceOf', args: [a] }) as Promise<bigint>;

const signin = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: 'alice', client_id: 'demo-jp' }) }));
const token: string = signin.homeSession;
const person = String(signin.agent).toLowerCase() as Address;
const sign = async (digest: Hex): Promise<Hex> => {
  const b = await j(await fetch(`${HOME}/connect/persona-sign`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ digest }) }));
  if (!b.signature) throw new Error(`persona-sign refused: ${JSON.stringify(b).slice(0, 200)}`);
  return b.signature;
};
const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
const csrf = (await j(csrfRes)) as { token?: string };
const cookie = (csrfRes.headers.get('set-cookie') ?? '').split(';')[0];
const post = async (body: unknown) =>
  j(await fetch(`${HOME}/a2a/harness/ask`, { method: 'POST', headers: { 'content-type': 'application/json', origin: HOME, cookie, 'x-csrf-token': csrf.token ?? '' }, body: JSON.stringify(body) }));

/** What the flyout's "Grant & continue" does — caveats built HERE from the requirement. */
async function mintMandate(reply: { requirement: MandateRequirementV1; delegate: Address; delegator: Address }) {
  const handler = reply.requirement.type.endsWith('treasury.payment.execute') ? paymentHandler : capabilityHandler;
  const caveats: Caveat[] = [...handler.toCaveats(reply.requirement, E as never), buildDigestBindingCaveat(E.digestBinding, 'intent', reply.requirement.intentDigest as Hex)];
  const salt = BigInt(toHex(crypto.getRandomValues(new Uint8Array(16))));
  const d: Delegation = { delegator: reply.delegator, delegate: reply.delegate, authority: ROOT_AUTHORITY, caveats, salt, signature: '0x' };
  d.signature = await sign(hashDelegation(d, CHAIN, E.delegationManager));
  return { ...d, salt: salt.toString() };
}

/** The panel's turn loop. Everything a person would answer, answered. */
async function askUntilDone(message: string, addressee: Address, extra: Record<string, unknown> = {}) {
  const runRef = `ask-${Date.now().toString(36)}`;
  const supplied: unknown[] = [];
  let presented: unknown = null;
  for (let turn = 0; turn < 8; turn++) {
    const res = await post({ session: token, addressee, message, runRef, presented, supplied, ...extra });
    const reply = res.reply;
    if (!reply) throw new Error(`no reply: ${JSON.stringify(res).slice(0, 400)}`);
    const detail = reply.kind === 'authority_required' ? ` (${reply.capability} as ${reply.delegator.slice(0, 10)}…)`
      : reply.kind === 'prompt' ? `: "${reply.prompt.prompt.slice(0, 78)}"` : reply.kind === 'refused' ? ` — ${reply.error}` : '';
    console.log(`  ← ${reply.kind}${detail}`);
    if (reply.kind === 'done' || reply.kind === 'answer' || reply.kind === 'refused') return reply;
    if (reply.kind === 'authority_required') {
      presented = await mintMandate(reply);
      console.log(`  → granted ${reply.capability} as ${reply.delegator.slice(0, 10)}…, for this ask only`);
      continue;
    }
    if (reply.prompt.kind === 'signature') {
      console.log(`  → signing ${reply.prompt.digest.slice(0, 14)}… as ${String(reply.prompt.signer).slice(0, 10) || '(the ladder)'}…`);
      supplied.push({ stepRef: reply.resumeToken, signature: { digest: reply.prompt.digest, signer: reply.prompt.signer || person, signature: await sign(reply.prompt.digest), payload: reply.prompt.payload } });
    } else if (reply.prompt.kind === 'data') {
      throw new Error(`the person would be asked for ${reply.prompt.fields.map((f: { name: string }) => f.name).join(', ')} — this ask should have said it`);
    } else {
      supplied.push({ stepRef: reply.resumeToken, confirmed: true });
    }
  }
  throw new Error('the ask never settled');
}

// ── PAYMENT: standing in the org, pay another agent ──
console.log(`\n── standing in ${ORG} (an organization that holds USDC) ──\n  → "pay ${PAYEE} 25 USDC"`);
const before = { org: await bal(ORG), payee: await bal(PAYEE) };
const paid = await askUntilDone(`pay ${PAYEE} 25 USDC from this organization — the token is ${E.usdc} and the amount in its smallest units is ${AMOUNT}`, ORG);
if (paid.kind !== 'done') throw new Error(`expected done: ${JSON.stringify(paid).slice(0, 500)}`);
const after = { org: await bal(ORG), payee: await bal(PAYEE) };
console.log(`  tx ${paid.result?.txHash}\n  org   ${before.org} → ${after.org}\n  payee ${before.payee} → ${after.payee}`);
if (before.org - after.org !== AMOUNT || after.payee - before.payee !== AMOUNT) throw new Error('USDC did not move as mandated');

// ── INVITE: standing in the org, invite an agent ──
console.log(`\n  → "invite ${PAYEE} to this organization"`);
const invited = await askUntilDone(`invite ${PAYEE} to this organization as a member`, ORG);
if (invited.kind !== 'done' || invited.result?.invited !== true) throw new Error(`expected an invitation: ${JSON.stringify(invited).slice(0, 500)}`);
const mad = invited.result.memberAccessDelegation as { delegator: string; delegate: string; signature: string };
console.log(`  invitation ${mad.delegator.slice(0, 10)}… → ${mad.delegate.slice(0, 10)}…, signed ${mad.signature.slice(0, 14)}…`);
if (mad.delegator.toLowerCase() !== ORG.toLowerCase() || mad.delegate.toLowerCase() !== PAYEE.toLowerCase()) throw new Error('the invitation is not from this org to this invitee');
// The surface's half: store it where the invitee's join will look.
const stored = await fetch(`${HOME}/connect/org-invite/agent`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ org: ORG.toLowerCase(), agent: PAYEE.toLowerCase(), memberAccessDelegation: mad }) });
if (!stored.ok) throw new Error(`the invitation was signed but not stored: ${stored.status} ${(await stored.text()).slice(0, 300)}`);
console.log(`  stored in the organization's vault: ✓`);

console.log('\n✓ Ask → payment between agents (payer\'s authority, approval signed in the conversation, USDC moved) and an invitation (signed grant, stored where a join finds it).');
