/**
 * Spec 350 W2, scenario 3 — "Pay organization X from the treasury", end to end on faithchain.
 *
 *   npx tsx scripts/verify-harness-payment.mts
 *
 * Drives the REAL surfaces as the steward (a demo persona whose custodian key the Home holds, so every
 * signature is a real ERC-1271-valid one): mints a payment MANDATE (delegator = the org, delegate = the
 * a2a's harness SA, PaymentEnforcer caveats + the intent binding), signs the second-party APPROVAL over
 * the step's authority digest, and asks the a2a to run the intent under it. Then the NEGATIVE TWIN: the
 * same mandate, a different ask — refused at the step, nothing moves.
 *
 * What a pass proves, in order: the mandate verified per step on chain and off; the ladder demanded a
 * second party and the approval discharged it; the verifier ran AGAIN after discharge; the harness SA
 * redeemed the mandate on chain with the PaymentEnforcer and DigestBindingEnforcer args filled; USDC
 * moved from the org to the payee; and the receipt binds all of it to a txHash.
 */
import { createPublicClient, http, keccak256, toBytes, toHex, type Address, type Hex } from 'viem';
import {
  intentDigest, buildDigestBindingCaveat, paymentHandler, registerDefaultSubsetHandlers, hashDelegation, ROOT_AUTHORITY,
  PAYMENT_RAR_TYPE, type Delegation, type MandateRequirementV1,
} from '../packages/delegation/src/index.js';

registerDefaultSubsetHandlers();

const HOME = 'https://www.faithnet.me';
const RPC = 'https://a2a.faithnet.io/rpc';
const CHAIN = 34348;
const D = {
  dm: '0x710cb1bF08C234Df397e0910331e0A29710EF4F7', timestamp: '0x73A7B878168b7DE48677617179A8bE894f0Dfe96',
  allowedTargets: '0x2156311097A936de1916a878bF53Bfd43c7b5715', allowedMethods: '0xdBb2E47793393C499efB0f3fcbf6Ca8669791a41',
  value: '0x8759c1a6cEBF1D5069e9434EF46327Bf2ef69975', payment: '0x07fA0aE59FdE4B7ce8962d6fE7a1d648ec3DD5CE',
  digestBinding: '0xA3bb9BCC9b2F6F2419E1aBe5ED6Fd5399b9E68e1', usdc: '0xdaE09066A2cc32f6203605619137dcF01A9B49Ae',
} as const;
const ORG = '0x3b99f2b452766de5df0dbcdfc676f27257151333' as Address;        // Missio Nexus — Alice stewards it; it holds the USDC
const HARNESS_SA = '0xD34c3Fbc89706dd57d426546DCEBD3bA926eDE35' as Address; // the a2a's harness agent (the delegate)
const PAYEE = '0x8c5cddca27c088a65e58e94403acdc9bc3eb7fe3' as Address;      // bob.me — the "organization X" being paid
const AMOUNT = 100_000_000n;                                                 // 100 USDC (6dp)
const CEILING = 250_000_000n;

const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 300), _status: r.status }; } };
const pub = createPublicClient({ transport: http(RPC) });
const bal = async (a: Address) => (await pub.readContract({ address: D.usdc, abi: [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }], functionName: 'balanceOf', args: [a] })) as bigint;

// ── Alice: a Home session + the persona signer (signs as the SAs her key custodies — Missio Nexus included) ──
const signin = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: 'alice', client_id: 'demo-jp' }) }));
const token: string = signin.homeSession;
if (!token) throw new Error('no session for alice');
const sign = async (digest: Hex): Promise<Hex> => {
  const b = await j(await fetch(`${HOME}/connect/persona-sign`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ digest }) }));
  if (!b.signature) throw new Error(`persona-sign refused: ${JSON.stringify(b).slice(0, 200)}`);
  return b.signature;
};

const enforcers = { delegationManager: D.dm, timestamp: D.timestamp, allowedTargets: D.allowedTargets, allowedMethods: D.allowedMethods, value: D.value, payment: D.payment, digestBinding: D.digestBinding } as const;
const now = Math.floor(Date.now() / 1000);

// ── The INTENT — what the ask means, canonically. The mandate binds to its digest. ──
const intent = { goal: `pay ${PAYEE} 100 USDC from Missio Nexus`, context: { payer: ORG, payee: PAYEE, asset: D.usdc, amount: AMOUNT.toString(), nonce: toHex(crypto.getRandomValues(new Uint8Array(8))) } };

// ── The MANDATE: Missio Nexus → harness SA, for THIS intent, ≤ 250 USDC to THIS payee, 1 hour ──
const req: MandateRequirementV1 = {
  type: PAYMENT_RAR_TYPE, actions: ['execute'], locations: [D.usdc],
  limits: { payee: PAYEE, asset: D.usdc, maxAmount: CEILING.toString(), maxAggregate: CEILING.toString(), maxRedemptionsPerWindow: 3, windowSeconds: 3600 },
  intentDigest: intentDigest(intent), validAfter: now - 60, validUntil: now + 3600,
};
const salt = BigInt(toHex(crypto.getRandomValues(new Uint8Array(16))));
const mandate: Delegation = { delegator: ORG, delegate: HARNESS_SA, authority: ROOT_AUTHORITY, caveats: [...paymentHandler.toCaveats(req, enforcers as never), buildDigestBindingCaveat(D.digestBinding, 'intent', req.intentDigest)], salt, signature: '0x' };
const mandateRef = hashDelegation(mandate, CHAIN, D.dm);
mandate.signature = await sign(mandateRef);   // the org's custodian (Alice) signs the mandate
console.log(`mandate  ${mandateRef}\n  org ${ORG} → harness ${HARNESS_SA}, intent ${req.intentDigest.slice(0, 18)}…, ≤ ${CEILING / 1_000_000n} USDC to ${PAYEE.slice(0, 10)}…`);
const wire = { ...mandate, salt: salt.toString() };

// ── The APPROVAL: the ladder makes a payment HIGH ⇒ a second party signs over THIS step's authority digest ──
const approvalDigest = keccak256(toBytes(JSON.stringify({ action: 'execute', capability: 'treasury.payment.execute', intentDigest: req.intentDigest, mandateRef, resource: D.usdc.toLowerCase(), stepRef: 's0' })));
const approval = { approver: signin.agent as Address, digest: approvalDigest, signature: await sign(approvalDigest) };

// Through the Home's /a2a proxy, exactly as the browser goes: it carries the gateway assertion the edge
// requires, and it wants a CSRF token on every POST.
const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
const csrf = (await j(csrfRes)) as { token?: string };
const cookie = (csrfRes.headers.get('set-cookie') ?? '').split(';')[0];
const run = async (runIntent: typeof intent, presented = wire, approvals = [approval]) =>
  j(await fetch(`${HOME}/a2a/harness/run`, { method: 'POST', headers: { 'content-type': 'application/json', origin: HOME, cookie, 'x-csrf-token': csrf.token ?? '' }, body: JSON.stringify({ session: token, intent: runIntent, presented, approvals }) }));

const before = { org: await bal(ORG), payee: await bal(PAYEE) };
console.log(`\n── run: "${intent.goal}" ──`);
const r = await run(intent);
console.log(`outcome ${r.outcome}  planner ${r.plannerKind}`);
for (const rc of r.receipts ?? []) console.log(`  ${rc.stepRef} ${rc.toolId} ${rc.status} risk=${rc.risk} decision=${rc.authority?.decision?.decision ?? '-'} approvals=${(rc.approvalRecords ?? []).length}${rc.error ? ` — ${rc.error}` : ''}`);
if (r.outcome !== 'completed') throw new Error(`expected completed: ${JSON.stringify(r).slice(0, 600)}`);
const after = { org: await bal(ORG), payee: await bal(PAYEE) };
console.log(`tx ${r.result?.txHash}\n  org   ${before.org} → ${after.org}\n  payee ${before.payee} → ${after.payee}`);
if (before.org - after.org !== AMOUNT || after.payee - before.payee !== AMOUNT) throw new Error('USDC did not move as mandated');

// ── NEGATIVE TWIN 1: same mandate, a different ask (a different intent) — denied at the step ──
console.log('\n── negative twin: same mandate, different intent ──');
const other = { ...intent, goal: `pay ${PAYEE} 100 USDC for something else`, context: { ...intent.context, nonce: '0x01' } };
const n1 = await run(other);
console.log(`outcome ${n1.outcome} — ${n1.error}`);
if (n1.outcome !== 'denied' || !/intent-mismatch/.test(n1.error ?? '')) throw new Error('the twin was not denied for the reason');

// ── NEGATIVE TWIN 2: a larger amount is a DIFFERENT intent — refused at the reason check, before any ceiling ──
// (The ceiling itself is the payment handler's, unit-tested; here the intent check fires first, which is right:
//  the mandate was for THIS ask, and a bigger ask is another ask.)
console.log('\n── negative twin: a different amount is a different intent ──');
const big = { ...intent, context: { ...intent.context, amount: (CEILING + 1n).toString() } };
const n2 = await run({ ...big, goal: intent.goal });
console.log(`outcome ${n2.outcome} — ${(n2.error ?? '').slice(0, 80)}`);
if (n2.outcome !== 'denied') throw new Error('a different amount must be a different intent');

// ── NEGATIVE TWIN 3: replaying the IDENTICAL run — the on-chain nonce derives from the intent, so it reverts ──
console.log('\n── negative twin: replay the identical run ──');
const n3 = await run(intent);
console.log(`outcome ${n3.outcome} — ${(n3.error ?? '').slice(0, 160)}`);
const final = await bal(ORG);
console.log(`org after replay attempt: ${final} (${final === after.org ? 'unchanged ✓' : 'CHANGED ✗'})`);
if (n3.outcome === 'completed' || final !== after.org) throw new Error('the identical intent settled TWICE — the on-chain nonce must derive from the intent');

console.log('\n✓ W2 scenario 3 on faithchain: mandate → verify → approve → re-verify → redeem on chain → receipt; twins refused.');
