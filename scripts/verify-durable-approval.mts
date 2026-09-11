/**
 * Spec 362, LIVE: a payment with a SUPPLIED PLAN (the deterministic screen entry, spec 361 I4) driven
 * DURABLY — attempt-1 suspends on the second-party obligation, the engine holds the wait, the custodian
 * approves through /harness/approve, attempt-2 re-verifies everything and settles.
 *
 *   npx tsx scripts/verify-durable-approval.mts
 *
 * The two gates it proves on the real estate: the approval EVENT carried only a reference (the evidence
 * rode the checkpoint and was verified by the approval port on resume), and one executor owned the run
 * (a conversational re-ask of the same runRef refuses with 409).
 */
import { createPublicClient, http, keccak256, toBytes, toHex, type Address, type Hex } from 'viem';
import { hashDelegation, buildDigestBindingCaveat, paymentHandler, intentDigest, ROOT_AUTHORITY, PAYMENT_RAR_TYPE, type Delegation, type MandateRequirementV1 } from '@agenticprimitives/delegation';

const HOME = 'https://www.faithnet.me';
const RPC = 'https://a2a.faithnet.io/rpc';
const CHAIN = 34348;
const D = {
  dm: '0x710cb1bF08C234Df397e0910331e0A29710EF4F7', timestamp: '0x73A7B878168b7DE48677617179A8bE894f0Dfe96',
  allowedTargets: '0x2156311097A936de1916a878bF53Bfd43c7b5715', allowedMethods: '0xdBb2E47793393C499efB0f3fcbf6Ca8669791a41',
  value: '0x8759c1a6cEBF1D5069e9434EF46327Bf2ef69975', payment: '0x07fA0aE59FdE4B7ce8962d6fE7a1d648ec3DD5CE',
  digestBinding: '0xA3bb9BCC9b2F6F2419E1aBe5ED6Fd5399b9E68e1', usdc: '0xdaE09066A2cc32f6203605619137dcF01A9B49Ae',
} as const;
const ORG = '0x3b99f2b452766de5df0dbcdfc676f27257151333' as Address;
const HARNESS_SA = '0xD34c3Fbc89706dd57d426546DCEBD3bA926eDE35' as Address;
const PAYEE = '0x8c5cddca27c088a65e58e94403acdc9bc3eb7fe3' as Address;
const AMOUNT = 7_000_000n;
const CEILING = 50_000_000n;

const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 300), _status: r.status }; } };
const pub = createPublicClient({ transport: http(RPC) });
const bal = async (a: Address) => (await pub.readContract({ address: D.usdc, abi: [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }], functionName: 'balanceOf', args: [a] })) as bigint;

const signin = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: 'alice', client_id: 'demo-jp' }) }));
const token: string = signin.homeSession;
if (!token) throw new Error('no session');
const sign = async (digest: Hex): Promise<Hex> => {
  const b = await j(await fetch(`${HOME}/connect/persona-sign`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ digest }) }));
  if (!b.signature) throw new Error(`persona-sign refused: ${JSON.stringify(b).slice(0, 150)}`);
  return b.signature;
};

const enforcers = { delegationManager: D.dm, timestamp: D.timestamp, allowedTargets: D.allowedTargets, allowedMethods: D.allowedMethods, value: D.value, payment: D.payment, digestBinding: D.digestBinding } as const;
const now = Math.floor(Date.now() / 1000);
const intent = { goal: `pay ${PAYEE} 7 USDC from Missio Nexus (durable)`, context: { payer: ORG, payee: PAYEE, asset: D.usdc, amount: AMOUNT.toString(), nonce: toHex(crypto.getRandomValues(new Uint8Array(8))) } };
const req: MandateRequirementV1 = {
  type: PAYMENT_RAR_TYPE, actions: ['execute'], locations: [D.usdc],
  limits: { payee: PAYEE, asset: D.usdc, maxAmount: CEILING.toString(), maxAggregate: CEILING.toString(), maxRedemptionsPerWindow: 3, windowSeconds: 3600 },
  intentDigest: intentDigest(intent), validAfter: now - 60, validUntil: now + 3600,
};
const salt = BigInt(toHex(crypto.getRandomValues(new Uint8Array(16))));
const mandate: Delegation = { delegator: ORG, delegate: HARNESS_SA, authority: ROOT_AUTHORITY, caveats: [...paymentHandler.toCaveats(req, enforcers as never), buildDigestBindingCaveat(D.digestBinding, 'intent', req.intentDigest)], salt, signature: '0x' };
const mandateRef = hashDelegation(mandate, CHAIN, D.dm);
mandate.signature = await sign(mandateRef);
const wire = { ...mandate, salt: salt.toString() };

const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
const csrf = (await j(csrfRes)) as { token?: string };
const cookie = (csrfRes.headers.get('set-cookie') ?? '').split(';')[0];
const H = { 'content-type': 'application/json', origin: HOME, cookie, 'x-csrf-token': csrf.token ?? '' };
const post = async (path: string, body: unknown) => j(await fetch(`${HOME}/a2a${path}`, { method: 'POST', headers: H, body: JSON.stringify(body) }));

const before = { org: await bal(ORG), payee: await bal(PAYEE) };

// ── START DURABLY, with the deterministic SUPPLIED PLAN — no LLM interprets a click. ──
const start = await post('/harness/durable', {
  session: token, addressee: ORG, intent, presented: wire,
  plan: { steps: [{ toolId: 'treasury.payment.execute', args: { payer: ORG, payee: PAYEE, asset: D.usdc, amount: AMOUNT.toString() } }] },
  approvalTimeoutMs: 10 * 60 * 1000,
});
if (start.ok !== true) throw new Error(`durable start failed: ${JSON.stringify(start).slice(0, 300)}`);
console.log(`durable run ${start.runRef} started (executor=${start.executor})`);

// ── ONE EXECUTOR: the conversational path must refuse this run. ──
const reask = await post('/harness/ask', { session: token, addressee: ORG, runRef: start.runRef, message: intent.goal });
if (!/advancing durably/.test(String(reask.error ?? ''))) throw new Error(`expected the 409 refusal, got: ${JSON.stringify(reask).slice(0, 200)}`);
console.log('re-ask refused ✓ (one executor per run)');

// Give attempt-1 a moment to run and suspend on the approval obligation.
await new Promise((r) => setTimeout(r, 8000));

// ── THE CUSTODIAN DECIDES: evidence to the checkpoint, the reference on the event. ──
const approvalDigest = keccak256(toBytes(JSON.stringify({ action: 'execute', capability: 'treasury.payment.execute', intentDigest: req.intentDigest, mandateRef, resource: D.usdc.toLowerCase(), stepRef: 's0' })));
const approve = await post('/harness/approve', {
  session: token, addressee: ORG, runRef: start.runRef,
  approval: { approver: signin.agent, digest: approvalDigest, signature: await sign(approvalDigest), stepRef: 's0' },
});
if (approve.ok !== true) throw new Error(`approve failed: ${JSON.stringify(approve).slice(0, 300)}`);
console.log('custodian decision delivered ✓');

// ── The engine resumes attempt-2: re-verify → reconcile → act. Watch the chain. ──
for (let i = 0; i < 24; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  const after = { org: await bal(ORG), payee: await bal(PAYEE) };
  if (after.payee === before.payee + AMOUNT) {
    console.log(`settled ✓  org ${before.org} → ${after.org}   payee ${before.payee} → ${after.payee}`);
    process.exit(0);
  }
}
throw new Error('the payment did not settle within 2 minutes of approval');
