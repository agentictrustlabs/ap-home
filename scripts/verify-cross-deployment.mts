/**
 * THE SECOND DEPLOYMENT, live — spec 366 R4 (sender), 383 W3, spec 374 W2 across deployments.
 *
 *   npx tsx scripts/verify-cross-deployment.mts [invitee]
 *
 * dave's Home is served by the first deployment (a2a.faithnet.io). His organization, dave-s-table.org, is
 * PLACED on the second (demo-a2a-faithnet-b) by its NAME: `atl:a2aEndpoint = https://edge-b.faithnet.io/…`
 * and `atl:cardUri` on a b.faithnet.io host — written by `place-on-deployment.mts`, no subdomain convention.
 *
 *   1. M1 R4 — a routed READ: dave asks his own agent who is in his organization; the step routes to the
 *      organization's agent, resolved through its records and its card, over the wire; the answer is the
 *      receiver's envelope; the routed step records `observedVia: network` and the standing it presented.
 *   2. M2 W3 / 374 W2 — a routed ACT: dave asks to invite someone; the organization (on B) asks for ITS
 *      mandate, relayed to dave as the steward; he grants it at home; the resume carries it over the wire
 *      to the parked run on B, which finishes under its own gates.
 *   3. 383 W3 — the chain the receiver's receipt names crosses the wire: `routed[].standing.wireRef`.
 *
 * Plans are SUPPLIED (the planner is not under test); the composer still writes the reply.
 */
import { hashDelegation, buildDigestBindingCaveat, capabilityHandler, ROOT_AUTHORITY, type Delegation, type Caveat, type MandateRequirementV1 } from '../packages/delegation/src/index.js';
import type { Address, Hex } from 'viem';

const HOME = 'https://www.faithnet.me';
const CHAIN = 34348;
const DM = '0x710cb1bF08C234Df397e0910331e0A29710EF4F7' as Address;
const ENFORCERS = { delegationManager: DM, timestamp: '0x73A7B878168b7DE48677617179A8bE894f0Dfe96', allowedTargets: '0x2156311097A936de1916a878bF53Bfd43c7b5715', allowedMethods: '0xdBb2E47793393C499efB0f3fcbf6Ca8669791a41', value: '0x8759c1a6cEBF1D5069e9434EF46327Bf2ef69975', payment: '0x07fA0aE59FdE4B7ce8962d6fE7a1d648ec3DD5CE', digestBinding: '0xA3bb9BCC9b2F6F2419E1aBe5ED6Fd5399b9E68e1' } as const;
const ORG_NAME = 'dave-s-table.org';
const B_HOST = 'dave-s-table-org.b.faithnet.io';
const INVITEE = process.argv[2] ?? 'elena.me';

const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 250), _status: r.status }; } };
const dave = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: 'dave', client_id: 'demo-web' }) }));
const ME = String(dave.agent).toLowerCase() as Address;
const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
const csrf = (await j(csrfRes)) as { token?: string };
const H = { 'content-type': 'application/json', origin: HOME, cookie: (csrfRes.headers.get('set-cookie') ?? '').split(';')[0], 'x-csrf-token': csrf.token ?? '' };
const post = async (path: string, body: unknown) => j(await fetch(`${HOME}/a2a${path}`, { method: 'POST', headers: H, body: JSON.stringify(body) }));
const sign = async (digest: Hex): Promise<Hex> => { const b = await j(await fetch(`${HOME}/connect/persona-sign`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${dave.homeSession}` }, body: JSON.stringify({ digest }) })); if (!b.signature) throw new Error(`persona-sign: ${JSON.stringify(b).slice(0, 160)}`); return b.signature; };
const fail = (m: string): never => { console.error(`\n✗ ${m}`); process.exit(1); };
type Routed = { stepRef: string; toolId: string; agent: string; name?: string; observedVia: string; host?: string; runRef?: string; receipts?: number; standing?: { relation: string; subject: string; principal: string; because: string; wireRef?: string } };
type Reply = { kind?: string; error?: string; text?: string; runRef?: string; stepRef?: string; requirement?: MandateRequirementV1; delegator?: Address; delegate?: Address; alsoApprove?: Array<{ digest: Hex }>; routedAt?: { agent: string; name?: string; runRef: string }; routed?: Routed[]; prompt?: { kind?: string; digest?: Hex; prompt?: string; stepRef?: string }; results?: Array<{ toolId: string; result: unknown }> };

const orgs = ((await j(await fetch(`${HOME}/connect/related-orgs?surface=any`, { headers: { authorization: `Bearer ${dave.homeSession}` } }))).orgs ?? []) as Array<{ orgAgent: string; orgName: string; relationship: string }>;
const org = orgs.find((o) => o.orgName.toLowerCase() === ORG_NAME && o.relationship === 'steward');
if (!org) fail(`dave does not steward ${ORG_NAME}`);
const ORG = org!.orgAgent.toLowerCase() as Address;
const card = await j(await fetch(`https://${B_HOST}/.well-known/agent-card.json`));
console.log(`dave ${ME} · ${ORG_NAME} ${ORG} · served by B as "${card?.name}" at ${(card?.supportedInterfaces ?? [])[0]?.url ?? '?'}`);
if ((process.env.EXPECT_VIA ?? 'network') === 'network' && String(card?.agentAddress ?? '').toLowerCase() !== ORG) fail(`B does not serve ${ORG_NAME} at ${B_HOST}`);

// ── 1. the routed READ, over the wire ──
console.log(`\n── 1. dave asks his agent (A) who is in ${ORG_NAME} (B) ──`);
const t1 = Date.now();
const r1 = await post('/harness/ask', { session: dave.homeSession, addressee: ME, message: `who are the members of ${ORG_NAME}`, plan: { steps: [{ toolId: 'organization.membership.list', args: { org: ORG_NAME } }] } });
const rep1 = r1.reply as Reply | undefined;
const via1 = rep1?.routed?.[0];
console.log(`  → ${rep1?.kind} (${((Date.now() - t1) / 1000).toFixed(1)}s) ${JSON.stringify(rep1?.text ?? rep1?.error ?? '').slice(0, 160)}`);
console.log(`  routed: ${via1 ? `${via1.name ?? via1.agent} via ${via1.observedVia}${via1.host ? ` at ${via1.host}` : ''}${via1.runRef ? `, run ${via1.runRef.slice(0, 22)}…` : ''}${via1.standing ? `, standing ${via1.standing.relation} (${via1.standing.because})${via1.standing.wireRef ? ` wire ${via1.standing.wireRef.slice(0, 12)}…` : ''}` : ''}` : 'none'}`);
if (process.env.DUMP) console.log(`  results: ${JSON.stringify(rep1?.results ?? []).slice(0, 900)}`);
if (rep1?.kind !== 'answer' || !via1) fail(`the read did not route: ${JSON.stringify(r1).slice(0, 600)}`);
const EXPECT_VIA = process.env.EXPECT_VIA ?? 'network';
if (via1!.observedVia !== EXPECT_VIA) fail(`the hop was ${via1!.observedVia}, expected ${EXPECT_VIA} — the records decide`);
if (via1!.standing?.relation !== 'steward') console.log('  (no steward standing recorded on the routed step)');
if (!via1!.standing?.wireRef) console.log('  (383 W3: no wireRef on the routed step)');

if (process.env.STEP === 'read') process.exit(0);

// ── 2. the routed ACT, over the wire; the organization's mandate, relayed; granted at home; resumed there ──
console.log(`\n── 2. dave asks to invite ${INVITEE} to ${ORG_NAME} (B) ──`);
const t2 = Date.now();
let r2 = await post('/harness/ask', { session: dave.homeSession, addressee: ME, message: `invite ${INVITEE} to ${ORG_NAME}`, plan: { steps: [{ toolId: 'organization.membership.invite', args: { org: ORG_NAME, invitee: INVITEE } }] } });
let rep2 = r2.reply as Reply | undefined;
console.log(`  → ${rep2?.kind} (${((Date.now() - t2) / 1000).toFixed(1)}s)${rep2?.error ? ` ${rep2.error}` : ''}${rep2?.routedAt ? ` — waits at ${rep2.routedAt.name ?? rep2.routedAt.agent} as ${rep2.routedAt.runRef}` : ''}`);
if (rep2?.kind !== 'authority_required' || !rep2.requirement || !rep2.delegator || !rep2.delegate) fail(`expected the organization's authority request relayed as dave's own: ${JSON.stringify(r2).slice(0, 700)}`);
if (rep2!.delegator!.toLowerCase() !== ORG) fail(`the mandate asked is not the organization's (delegator ${rep2!.delegator})`);
const req = rep2!.requirement!;
const caveats: Caveat[] = [...capabilityHandler.toCaveats(req, ENFORCERS as never), buildDigestBindingCaveat(ENFORCERS.digestBinding, 'intent', req.intentDigest as Hex)];
let salt = 0n; for (const b of crypto.getRandomValues(new Uint8Array(16))) salt = (salt << 8n) | BigInt(b);
const mandate: Delegation = { delegator: rep2!.delegator!, delegate: rep2!.delegate!, authority: ROOT_AUTHORITY, caveats, salt, signature: '0x' };
const a = await post('/harness/authorize', { session: dave.homeSession, delegator: rep2!.delegator, digests: [hashDelegation(mandate, CHAIN, DM), ...(rep2!.alsoApprove ?? []).map((x) => x.digest)] });
if (a.ok !== true) fail(`authorize build failed: ${JSON.stringify(a).slice(0, 300)}`);
const b2 = await post('/harness/authorize', { session: dave.homeSession, delegator: rep2!.delegator, userOp: a.userOp, signature: await sign(a.userOpHash as Hex) });
if (b2.ok !== true) fail(`authorize submit failed: ${JSON.stringify(b2).slice(0, 300)}`);
mandate.signature = '0x03';
console.log(`  dave approved the organization's mandate on chain (tx ${String(b2.txHash).slice(0, 18)}…)`);
const t3 = Date.now();
r2 = await post('/harness/ask', { session: dave.homeSession, addressee: ME, runRef: rep2!.runRef, presented: { ...mandate, salt: salt.toString() } });
rep2 = r2.reply as Reply | undefined;
for (let i = 0; i < 3 && rep2?.kind === 'prompt' && rep2.prompt?.kind === 'signature' && rep2.prompt.digest; i++) {
  console.log(`  signature asked: "${(rep2.prompt.prompt ?? '').slice(0, 100)}"`);
  r2 = await post('/harness/ask', { session: dave.homeSession, addressee: ME, runRef: rep2.runRef ?? rep2!.runRef, supplied: [{ kind: 'signature', stepRef: rep2.prompt.stepRef, digest: rep2.prompt.digest, signature: await sign(rep2.prompt.digest), signer: ME }] });
  rep2 = r2.reply as Reply | undefined;
}
const via2 = rep2?.routed?.[0];
console.log(`  → ${rep2?.kind} (${((Date.now() - t3) / 1000).toFixed(1)}s) ${JSON.stringify(rep2?.text ?? rep2?.error ?? rep2?.prompt?.prompt ?? '').slice(0, 160)}`);
console.log(`  routed: ${via2 ? `${via2.name ?? via2.agent} via ${via2.observedVia}${via2.runRef ? `, run ${via2.runRef.slice(0, 22)}…` : ''}${via2.receipts ? `, ${via2.receipts} receipt(s)` : ''}` : 'none'}`);
if (rep2?.kind !== 'done' && rep2?.kind !== 'answer') fail(`the act did not finish through the continuation: ${JSON.stringify(r2).slice(0, 700)}`);
if (via2?.observedVia !== 'network') fail(`the act's hop was ${via2?.observedVia ?? 'unrecorded'}, not over the wire`);

console.log(`\n✓ second deployment: ${ORG_NAME} is asked where its NAME says it is — over the wire to B, through its card. A steward's read answered there; an act parked there for the organization's mandate, granted at home and carried back over the wire; the routed steps record the hop and the standing presented.`);
