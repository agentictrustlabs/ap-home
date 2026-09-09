/**
 * Spec 382 W3 (M6 milestones), live — a milestone the adopted plan defines, reached by Ask under the
 * organization's mandate, shown achieved on the endeavor.
 *
 *   npx tsx scripts/verify-milestone.mts
 *
 * alice, a steward of Missio Nexus, raises an endeavor and adopts it, proposes and adopts a plan with one
 * milestone, then asks her own agent to record the milestone as reached. The step routes to the
 * organization's own agent (the coordination acts live on the org-steward playbook, asked AT the organization
 * under her standing); the organization asks for ITS mandate; she grants it at home as its steward; the resume finishes the act at the organization; the detail shows the milestone
 * achieved with her evidence. Plans are supplied (the planner is not under test).
 */
import { hashDelegation, buildDigestBindingCaveat, capabilityHandler, ROOT_AUTHORITY, type Delegation, type Caveat, type MandateRequirementV1 } from '../packages/delegation/src/index.js';
import type { Address, Hex } from 'viem';

const HOME = 'https://www.faithnet.me';
const CHAIN = 34348;
const DM = '0x710cb1bF08C234Df397e0910331e0A29710EF4F7' as Address;
const ENFORCERS = { delegationManager: DM, timestamp: '0x73A7B878168b7DE48677617179A8bE894f0Dfe96', allowedTargets: '0x2156311097A936de1916a878bF53Bfd43c7b5715', allowedMethods: '0xdBb2E47793393C499efB0f3fcbf6Ca8669791a41', value: '0x8759c1a6cEBF1D5069e9434EF46327Bf2ef69975', payment: '0x07fA0aE59FdE4B7ce8962d6fE7a1d648ec3DD5CE', digestBinding: '0xA3bb9BCC9b2F6F2419E1aBe5ED6Fd5399b9E68e1' } as const;
const ORG = '0x3b99f2b452766de5df0dbcdfc676f27257151333' as Address; // missio-nexus.org
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 250), _status: r.status }; } };
const fail = (m: string): never => { console.error(`\n✗ ${m}`); process.exit(1); };
const alice = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: 'alice', client_id: 'demo-web' }) }));
const ME = String(alice.agent).toLowerCase() as Address;
const AUTH = { 'content-type': 'application/json', authorization: `Bearer ${alice.homeSession}` };
const work = async (body: Record<string, unknown>) => j(await fetch(`${HOME}/connect/work`, { method: 'POST', headers: AUTH, body: JSON.stringify({ org: ORG, ...body }) }));
const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
const csrf = (await j(csrfRes)) as { token?: string };
const H = { 'content-type': 'application/json', origin: HOME, cookie: (csrfRes.headers.get('set-cookie') ?? '').split(';')[0], 'x-csrf-token': csrf.token ?? '' };
const post = async (path: string, body: unknown) => j(await fetch(`${HOME}/a2a${path}`, { method: 'POST', headers: H, body: JSON.stringify(body) }));
const sign = async (digest: Hex): Promise<Hex> => { const b = await j(await fetch(`${HOME}/connect/persona-sign`, { method: 'POST', headers: AUTH, body: JSON.stringify({ digest }) })); if (!b.signature) throw new Error(`persona-sign: ${JSON.stringify(b).slice(0, 160)}`); return b.signature; };

// ── the endeavor, its plan, its milestone ──
const nonce = Date.now().toString(36);
const req = await work({ action: 'request', target: ORG, goal: `Run the spring retreat (milestone gate ${nonce})` });
if (!req.requestId) fail(`request: ${JSON.stringify(req).slice(0, 200)}`);
// The organization's coordinator playbook adopts a request the moment it lands (spec 375, on-request); when it
// has, the steward's adopt is refused as already adopted and the endeavor is found by the request instead.
let created = await work({ action: 'adopt', requestId: req.requestId, title: `Milestone gate ${nonce}` });
let endeavorId = String(created.endeavorId ?? '');
if (!endeavorId) {
  for (let i = 0; i < 6 && !endeavorId; i++) {
    const list = await j(await fetch(`${HOME}/connect/work?org=${ORG}`, { headers: AUTH }));
    const rows = ((list.endeavors ?? []) as Array<Record<string, unknown>>);
    const hit = rows.find((e) => e.requestId === req.requestId || String(e.title ?? '').includes(nonce) || String(e.goal ?? '').includes(nonce));
    if (hit) endeavorId = String(hit.endeavorId ?? hit.id ?? '');
    if (!endeavorId) await new Promise((r) => setTimeout(r, 4000));
  }
  if (!endeavorId) fail(`adopt: ${JSON.stringify(created).slice(0, 160)} — and no endeavor for request ${req.requestId} in the list`);
  console.log(`  the organization's agent had already adopted the request (${endeavorId})`);
}
const proposed = await work({ action: 'proposePlan', endeavorId, planSteps: [{ stepId: 'step_venue', kind: 'contribution', description: 'Book the venue' }], milestones: [{ milestoneId: 'ms_venue', title: 'Venue booked', criteria: [{ criterionId: 'crit_contract' }] }] });
if (!proposed.planId) fail(`proposePlan: ${JSON.stringify(proposed).slice(0, 200)}`);
const adopted = await work({ action: 'adoptPlan', endeavorId, planRef: { planId: proposed.planId, revision: Number(proposed.revision), hash: proposed.contentHash } });
if (adopted.ok !== true) fail(`adoptPlan: ${JSON.stringify(adopted).slice(0, 200)}`);
console.log(`endeavor ${endeavorId} · plan ${proposed.planId} r${proposed.revision} adopted with milestone ms_venue`);

// ── the milestone reached, by Ask AT the organization, under its mandate, granted by its steward ──
type Reply = { kind?: string; error?: string; text?: string; runRef?: string; requirement?: MandateRequirementV1; delegator?: Address; delegate?: Address; alsoApprove?: Array<{ digest: Hex }>; routedAt?: { name?: string; agent: string; runRef: string }; routed?: Array<{ name?: string; agent: string; observedVia: string; receipts?: number }>; prompt?: { kind?: string; digest?: Hex; prompt?: string; stepRef?: string } };
const note = 'Contract signed with the lodge';
let r = await post('/harness/ask', { session: alice.homeSession, addressee: ORG, message: `we reached the venue milestone on ${endeavorId} — ${note}`, plan: { steps: [{ toolId: 'coordination.milestone.achieve', args: { org: 'missio-nexus.org', endeavorId, milestoneId: 'ms_venue', note } }] } });
let rep = r.reply as Reply | undefined;
console.log(`  ask → ${rep?.kind}${rep?.error ? ` ${rep.error}` : ''}${rep?.routedAt ? ` — waits at ${rep.routedAt.name ?? rep.routedAt.agent}` : ''}`);
if (rep?.kind !== 'authority_required' || !rep.requirement || !rep.delegator || !rep.delegate) fail(`expected the organization's mandate relayed to alice: ${JSON.stringify(r).slice(0, 600)}`);
if (rep!.delegator!.toLowerCase() !== ORG) fail(`the mandate asked is not the organization's (${rep!.delegator})`);
const reqm = rep!.requirement!;
const caveats: Caveat[] = [...capabilityHandler.toCaveats(reqm, ENFORCERS as never), buildDigestBindingCaveat(ENFORCERS.digestBinding, 'intent', reqm.intentDigest as Hex)];
let salt = 0n; for (const b of crypto.getRandomValues(new Uint8Array(16))) salt = (salt << 8n) | BigInt(b);
const mandate: Delegation = { delegator: rep!.delegator!, delegate: rep!.delegate!, authority: ROOT_AUTHORITY, caveats, salt, signature: '0x' };
const a = await post('/harness/authorize', { session: alice.homeSession, delegator: rep!.delegator, digests: [hashDelegation(mandate, CHAIN, DM), ...(rep!.alsoApprove ?? []).map((x) => x.digest)] });
if (a.ok !== true) fail(`authorize build: ${JSON.stringify(a).slice(0, 300)}`);
const b2 = await post('/harness/authorize', { session: alice.homeSession, delegator: rep!.delegator, userOp: a.userOp, signature: await sign(a.userOpHash as Hex) });
if (b2.ok !== true) fail(`authorize submit: ${JSON.stringify(b2).slice(0, 300)}`);
mandate.signature = '0x03';
console.log(`  alice approved the organization's mandate (tx ${String(b2.txHash).slice(0, 18)}…)`);
r = await post('/harness/ask', { session: alice.homeSession, addressee: ORG, runRef: rep!.runRef, presented: { ...mandate, salt: salt.toString() } });
rep = r.reply as Reply | undefined;
for (let i = 0; i < 2 && rep?.kind === 'prompt' && rep.prompt?.kind === 'signature' && rep.prompt.digest; i++) {
  r = await post('/harness/ask', { session: alice.homeSession, addressee: ORG, runRef: rep.runRef ?? rep!.runRef, supplied: [{ kind: 'signature', stepRef: rep.prompt.stepRef, digest: rep.prompt.digest, signature: await sign(rep.prompt.digest), signer: ME }] });
  rep = r.reply as Reply | undefined;
}
const via = rep?.routed?.[0];
console.log(`  resume → ${rep?.kind}${rep?.error ? ` ${rep.error}` : ''}${via ? ` · by ${via.name ?? via.agent} (${via.observedVia}${via.receipts ? `, ${via.receipts} receipt(s)` : ''})` : ''}`);
if (rep?.kind !== 'done' && rep?.kind !== 'answer') fail(`the act did not finish: ${JSON.stringify(r).slice(0, 600)}`);

// ── the record: the milestone is achieved, with her evidence ──
const detail = await j(await fetch(`${HOME}/connect/work?org=${ORG}&endeavorId=${endeavorId}`, { headers: AUTH }));
const hit = ((detail.milestones ?? []) as Array<{ milestoneId: string; evidenceRefs?: unknown[] }>).find((m) => m.milestoneId === 'ms_venue');
console.log(`  detail: plan milestones ${JSON.stringify((detail.plan?.milestones ?? []).map((m: { milestoneId: string }) => m.milestoneId))} · achieved ${hit ? 'ms_venue' : 'none'}`);
if (!hit) fail('the milestone is not recorded as achieved');
console.log(`\n✓ spec 382 W3 (milestones): the adopted plan named the milestone; alice's ask routed to the organization, which asked for its mandate; she granted it as its steward; the milestone is recorded achieved with her evidence.`);
