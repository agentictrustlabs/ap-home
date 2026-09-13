/**
 * Spec 393 W2 — THE COORDINATOR'S OFFERS AND ALLOCATIONS THROUGH THE ASK, live on Missio Nexus, with the twins.
 *
 *   npx tsx scripts/verify-endeavor-offer-allocate-ask.mts
 *
 * alice (a steward) raises an endeavor and adopts a one-step plan (step_flyer). Four asks, plans supplied
 * (the planner is not under test — memory rule):
 *   1. carol (a member): "I'll take the flyer step"  → coordination.contribution.propose → HER OWN mandate (the offer is the
 *      offerer's act — its acting party is the proposer, never the organization it is offered to) → an OFFER on the endeavor
 *   2. alice (steward):  "allocate the flyer step to carol" → coordination.contribution.allocate → the ORGANIZATION's mandate,
 *      granted by its steward → the ALLOCATION on the endeavor
 *   3. TWIN — a non-member: the same offer, under their own mandate → refused at the organization's member gate ("join this community")
 *   4. TWIN — carol: the same allocation → the Ask asks for the ORGANIZATION's mandate, which is not hers to give;
 *      her attempt to authorize as the organization is refused; the endeavor carries exactly one allocation.
 */
import { hashDelegation, buildDigestBindingCaveat, capabilityHandler, ROOT_AUTHORITY, type Delegation, type Caveat, type MandateRequirementV1 } from '@agenticprimitives/delegation';
import type { Address, Hex } from 'viem';
import { fixture as fx, HOME, A2A, resolveOrgAgent } from './fixture.mts';


const CHAIN = 34348;
const DM = '0x710cb1bF08C234Df397e0910331e0A29710EF4F7' as Address;
const ENFORCERS = { delegationManager: DM, timestamp: '0x73A7B878168b7DE48677617179A8bE894f0Dfe96', allowedTargets: '0x2156311097A936de1916a878bF53Bfd43c7b5715', allowedMethods: '0xdBb2E47793393C499efB0f3fcbf6Ca8669791a41', value: '0x8759c1a6cEBF1D5069e9434EF46327Bf2ef69975', payment: '0x07fA0aE59FdE4B7ce8962d6fE7a1d648ec3DD5CE', digestBinding: '0xA3bb9BCC9b2F6F2419E1aBe5ED6Fd5399b9E68e1' } as const;
const NON_MEMBER_CANDIDATES = (process.env.NON_MEMBERS ?? `${fx.people.outsider},${fx.people.payeeOwner}`).split(',');
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 250), _status: r.status }; } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let restoreAutoWork: () => Promise<void> = async () => undefined;
const fail: (m: string) => never = (m) => { console.error(`\n✗ ${m}`); void restoreAutoWork().finally(() => process.exit(1)); throw new Error(m); };
type Session = { homeSession: string; agent: string; handle: string };
const signin = async (handle: string): Promise<Session> => ({ ...(await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle, client_id: 'demo-web' }) }))), handle });
const signerFor = (s: Session) => async (digest: Hex): Promise<Hex> => { const b = await j(await fetch(`${HOME}/connect/persona-sign`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${s.homeSession}` }, body: JSON.stringify({ digest }) })); if (!b.signature) throw new Error(`persona-sign (${s.handle}): ${JSON.stringify(b).slice(0, 160)}`); return b.signature; };

const alice = await signin(fx.people.steward); const ALICE = String(alice.agent).toLowerCase() as Address;
const carol = await signin(fx.people.member2); const CAROL = String(carol.agent).toLowerCase() as Address;
const ORG = (await resolveOrgAgent(alice.homeSession)) as Address;
const related = await j(await fetch(`${HOME}/connect/related-orgs?person=${ALICE}`, { headers: { authorization: `Bearer ${alice.homeSession}` } }));
const stewardship = (related.orgs ?? []).find((o: { orgAgent: string }) => o.orgAgent.toLowerCase() === ORG)?.stewardshipDelegation;
if (!stewardship) fail(`${fx.people.steward} holds no stewardship wire for ${fx.org.name}`);
type Ix = { ok?: boolean; error?: string } & Record<string, unknown>;
const ix = async (token: string, op: string, payload: Record<string, unknown>, withStewardship = false): Promise<Ix & { httpStatus: number }> => {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${A2A}/interactions/${ORG}/${op}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: token, ...(withStewardship ? { stewardship } : {}), ...payload }) });
    const out = await j(res);
    if (res.status === 409 && /auth failed — mcp/.test(String(out.error)) && attempt < 6) { console.log(`  (${op}: the organization's vault budget is spent — waiting ${10 * (attempt + 1)}s)`); await sleep(10_000 * (attempt + 1)); continue; }
    await sleep(op.endsWith('.list') ? 3000 : 1500);
    return { ...out, httpStatus: res.status };
  }
};
// the Ask, through the Home's proxy (CSRF + origin), at the organization
const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
const csrf = (await j(csrfRes)) as { token?: string };
const H = { 'content-type': 'application/json', origin: HOME, cookie: (csrfRes.headers.get('set-cookie') ?? '').split(';')[0], 'x-csrf-token': csrf.token ?? '' };
const post = async (path: string, body: unknown) => j(await fetch(`${HOME}/a2a${path}`, { method: 'POST', headers: H, body: JSON.stringify(body) }));
type Reply = { kind?: string; error?: string; text?: string; runRef?: string; requirement?: MandateRequirementV1; delegator?: Address; delegate?: Address; alsoApprove?: Array<{ digest: Hex }>; prompt?: { kind?: string; digest?: Hex; stepRef?: string }; receipts?: Array<{ status?: string; error?: string }> };
/** One ask with a supplied plan; signature prompts answered by the asker's own persona-sign. */
const ask = async (s: Session, message: string, step: { toolId: string; args: Record<string, unknown> }): Promise<Reply> => {
  let r = await post('/harness/ask', { session: s.homeSession, addressee: ORG, message, plan: { steps: [step] } });
  let rep = (r.reply ?? r) as Reply;
  for (let i = 0; i < 3 && rep.kind === 'prompt' && rep.prompt?.kind === 'signature' && rep.prompt.digest; i++) {
    r = await post('/harness/ask', { session: s.homeSession, addressee: ORG, runRef: rep.runRef, supplied: [{ kind: 'signature', stepRef: rep.prompt.stepRef, digest: rep.prompt.digest, signature: await signerFor(s)(rep.prompt.digest), signer: s.agent.toLowerCase() }] });
    rep = (r.reply ?? r) as Reply;
  }
  return rep;
};
const describe = (rep: Reply) => `${rep.kind}${rep.kind === 'prompt' ? ` (${(rep.prompt as { kind?: string; prompt?: string } | undefined)?.kind}: ${String((rep.prompt as { prompt?: string } | undefined)?.prompt ?? '').slice(0, 120)})` : ''}${rep.error ? ` — ${rep.error}` : ''}${rep.delegator ? ` (mandate of ${rep.delegator.toLowerCase() === ORG ? 'the organization' : rep.delegator.toLowerCase() === CAROL ? 'carol herself' : rep.delegator})` : ''}${rep.text ? ` · "${String(rep.text).slice(0, 90)}"` : ''}`;
/** The mandate a parked run asks for, granted by `s` as its delegator's custodian (their own, or the organization's as its steward) — or the attempt's refusal. */
const grantMandate = async (s: Session, rep: Reply): Promise<{ ok: true; mandate: Delegation; salt: bigint } | { ok: false; error: string }> => {
  const reqm = rep.requirement!;
  const caveats: Caveat[] = [...capabilityHandler.toCaveats(reqm, ENFORCERS as never), buildDigestBindingCaveat(ENFORCERS.digestBinding, 'intent', reqm.intentDigest as Hex)];
  let salt = 0n; for (const b of crypto.getRandomValues(new Uint8Array(16))) salt = (salt << 8n) | BigInt(b);
  const mandate: Delegation = { delegator: rep.delegator!, delegate: rep.delegate!, authority: ROOT_AUTHORITY, caveats, salt, signature: '0x' };
  const a = await post('/harness/authorize', { session: s.homeSession, delegator: rep.delegator, digests: [hashDelegation(mandate, CHAIN, DM), ...(rep.alsoApprove ?? []).map((x) => x.digest)] });
  if (a.ok !== true) return { ok: false, error: `build: ${a.error ?? JSON.stringify(a).slice(0, 160)}` };
  let sig: Hex; try { sig = await signerFor(s)(a.userOpHash as Hex); } catch (e) { return { ok: false, error: `sign: ${(e as Error).message}` }; }
  const b = await post('/harness/authorize', { session: s.homeSession, delegator: rep.delegator, userOp: a.userOp, signature: sig });
  if (b.ok !== true) return { ok: false, error: `submit: ${b.error ?? JSON.stringify(b).slice(0, 160)}` };
  mandate.signature = '0x03';
  return { ok: true, mandate, salt };
};
const resumeWith = async (s: Session, rep: Reply, mandate: Delegation, salt: bigint): Promise<Reply> => {
  let r = await post('/harness/ask', { session: s.homeSession, addressee: ORG, runRef: rep.runRef, presented: { ...mandate, salt: salt.toString() } });
  let out = (r.reply ?? r) as Reply;
  for (let i = 0; i < 3 && out.kind === 'prompt' && out.prompt?.kind === 'signature' && out.prompt.digest; i++) {
    r = await post('/harness/ask', { session: s.homeSession, addressee: ORG, runRef: out.runRef ?? rep.runRef, supplied: [{ kind: 'signature', stepRef: out.prompt.stepRef, digest: out.prompt.digest, signature: await signerFor(s)(out.prompt.digest), signer: s.agent.toLowerCase() }] });
    out = (r.reply ?? r) as Reply;
  }
  return out;
};

// ── setup: auto-work paused (the organization's coordinator would draft plans and spend the vault budget) ──
const autoBefore = await ix(alice.homeSession, 'autowork.get', {}, true);
restoreAutoWork = async () => { if (autoBefore.enabled) await ix(alice.homeSession, 'autowork.enable', {}, true).catch(() => undefined); };
if (autoBefore.enabled) { await ix(alice.homeSession, 'autowork.disable', {}, true); console.log('setup: auto-work paused for the run'); }
try {
  // a persona who is NOT a member of this organization, for the twin
  let outsider: Session | undefined;
  for (const h of NON_MEMBER_CANDIDATES) {
    const s = await signin(h);
    if (!s.homeSession) continue;
    const l = await ix(s.homeSession, 'endeavor.list', {});
    if (l.ok === true && l.member === false && l.steward !== true) { outsider = s; break; }
    console.log(`  (${h} is a member or steward here — not the outsider)`);
  }
  if (!outsider) fail(`none of ${NON_MEMBER_CANDIDATES.join(', ')} is an outsider to ${fx.org.name} — set NON_MEMBERS=`);
  const OUT = String(outsider!.agent).toLowerCase() as Address;
  console.log(`personas: alice ${ALICE} (steward) · carol ${CAROL} (member) · ${outsider!.handle} ${OUT} (outsider)`);

  // ── 0. the endeavor and its one-step plan ──
  const nonce = Date.now().toString(36);
  const LABEL = `Flyer ${nonce}`;
  const requested = await ix(alice.homeSession, 'endeavor.request', { goal: `${LABEL}: print and hand out the retreat flyer`, entryPoint: 'home-request' }, true);
  const requestId = (requested.requestId ?? (requested.request as { requestId?: string } | undefined)?.requestId) as string | undefined;
  if (!requestId) fail(`endeavor.request: ${JSON.stringify(requested).slice(0, 300)}`);
  const created = await ix(alice.homeSession, 'endeavor.create', { requestId, decision: 'adopt', title: LABEL }, true);
  const endeavorId = typeof created.endeavorId === 'string' ? created.endeavorId : fail(`adopt: ${JSON.stringify(created).slice(0, 200)}`);
  const steps = [{ stepId: 'step_flyer', kind: 'contribution', description: 'Print and hand out the flyer' }];
  const proposed = await ix(alice.homeSession, 'endeavor.proposePlan', { endeavorId, steps, edges: [], milestones: [] }, true);
  if (!proposed.ok) fail(`proposePlan: ${JSON.stringify(proposed).slice(0, 300)}`);
  const get0 = await ix(alice.homeSession, 'endeavor.get', { endeavorId }, true);
  const planRow = ((get0.plans ?? []) as Array<{ planId: string; revision: number; contentHash: string }>).find((p) => p.planId === proposed.planId && p.revision === proposed.revision);
  const planRef = { planId: proposed.planId, revision: proposed.revision, hash: (planRow?.contentHash ?? (get0.plan as { contentHash?: string } | undefined)?.contentHash) as string };
  if (!planRef.hash) fail(`no content hash for the plan: ${JSON.stringify(get0).slice(0, 300)}`);
  const adopted = await ix(alice.homeSession, 'endeavor.adoptPlan', { endeavorId, planRef }, true);
  if (!adopted.ok) fail(`adoptPlan: ${JSON.stringify(adopted).slice(0, 300)}`);
  console.log(`endeavor ${endeavorId} (${LABEL}) · plan ${planRef.planId}@${planRef.revision} adopted with step_flyer`);

  // ── 1. carol offers, through the Ask ──
  let offer = await ask(carol, `I'll take the flyer step on ${endeavorId}`, { toolId: 'coordination.contribution.propose', args: { org: ORG, endeavorId, steps: ['step_flyer'], note: 'I can print them at the office' } });
  console.log(`  1. carol offers → ${describe(offer)}`);
  if (offer.kind === 'authority_required') {
    if (offer.delegator!.toLowerCase() !== CAROL) fail(`an offer is the offerer's act — the mandate asked is ${offer.delegator}, not carol's`);
    const g = await grantMandate(carol, offer);
    if (!g.ok) fail(`carol could not grant her own mandate: ${g.error}`);
    console.log(`     carol granted HER OWN mandate for the offer`);
    offer = await resumeWith(carol, offer, g.mandate, g.salt);
    console.log(`     resume → ${describe(offer)}`);
  }
  if (offer.kind !== 'done' && offer.kind !== 'answer') fail(`carol's offer did not land: ${JSON.stringify(offer).slice(0, 500)}`);
  const get1 = await ix(alice.homeSession, 'endeavor.get', { endeavorId }, true);
  const proposal = ((get1.proposals ?? []) as Array<{ proposalId: string; proposer: string; steps: string[] }>).find((p) => p.proposer.toLowerCase() === CAROL && p.steps.includes('step_flyer'));
  if (!proposal) fail(`no offer by carol on the endeavor: ${JSON.stringify(get1.proposals).slice(0, 300)}`);
  console.log(`     the endeavor carries her offer ${proposal!.proposalId}`);

  // ── 3. TWIN — the outsider's offer is refused at the member gate ──
  // Authority comes first, as for anyone: the outsider grants THEIR OWN mandate for the offer; the organization's
  // door then refuses the offer itself — a mandate says the act is theirs to attempt, never that the room admits it.
  let outOffer = await ask(outsider!, `I'll take the flyer step on ${endeavorId}`, { toolId: 'coordination.contribution.propose', args: { org: ORG, endeavorId, steps: ['step_flyer'] } });
  if (outOffer.kind === 'authority_required' && outOffer.delegator!.toLowerCase() === OUT) {
    const g = await grantMandate(outsider!, outOffer);
    if (!g.ok) fail(`${outsider!.handle} could not grant their own mandate: ${g.error}`);
    outOffer = await resumeWith(outsider!, outOffer, g.mandate, g.salt);
  }
  const outText = `${outOffer.error ?? ''} ${outOffer.text ?? ''} ${JSON.stringify(outOffer.receipts ?? [])}`;
  console.log(`  3. ${outsider!.handle} offers → ${describe(outOffer)}`);
  if (outOffer.kind === 'done' || !/join this community/i.test(outText)) fail(`the outsider's offer should be refused at the member gate: ${JSON.stringify(outOffer).slice(0, 500)}`);

  // ── 4. TWIN — carol asks to allocate: the organization's mandate is asked for, and is not hers to give ──
  // (to someone else — allocating a step to YOURSELF is refused earlier, by the party resolver: "that would be you")
  const carolAlloc = await ask(carol, `allocate the flyer step to alice on ${endeavorId}`, { toolId: 'coordination.contribution.allocate', args: { org: ORG, endeavorId, proposalRef: proposal!.proposalId, participant: ALICE, steps: ['step_flyer'] } });
  console.log(`  4. carol allocates → ${describe(carolAlloc)}`);
  if (carolAlloc.kind !== 'authority_required') fail(`carol's allocation should wait on the organization's mandate: ${JSON.stringify(carolAlloc).slice(0, 400)}`);
  if (carolAlloc.delegator!.toLowerCase() !== ORG) fail(`the mandate asked of carol is not the organization's: ${carolAlloc.delegator}`);
  const attempt = await grantMandate(carol, carolAlloc);
  console.log(`     carol tries to grant it as the organization → ${attempt.ok ? 'GRANTED (wrong)' : `refused: ${attempt.error.slice(0, 140)}`}`);
  if (attempt.ok) fail('carol was able to authorize as the organization');

  // ── 2. alice allocates, through the Ask, under the organization's mandate ──
  let alloc = await ask(alice, `allocate the flyer step to carol on ${endeavorId}`, { toolId: 'coordination.contribution.allocate', args: { org: ORG, endeavorId, proposalRef: proposal!.proposalId, participant: CAROL, steps: ['step_flyer'] } });
  console.log(`  2. alice allocates → ${describe(alloc)}`);
  if (alloc.kind === 'authority_required') {
    if (alloc.delegator!.toLowerCase() !== ORG) fail(`the mandate asked is not the organization's: ${alloc.delegator}`);
    const g = await grantMandate(alice, alloc);
    if (!g.ok) fail(`alice could not grant the organization's mandate: ${g.error}`);
    console.log(`     the steward granted the organization's mandate`);
    alloc = await resumeWith(alice, alloc, g.mandate, g.salt);
    console.log(`     resume → ${describe(alloc)}`);
  }
  if (alloc.kind !== 'done' && alloc.kind !== 'answer') fail(`the allocation did not land: ${JSON.stringify(alloc).slice(0, 500)}`);

  // ── the record: exactly one allocation, to carol ──
  const get2 = await ix(alice.homeSession, 'endeavor.get', { endeavorId }, true);
  const allocations = (get2.allocations ?? []) as Array<{ participant: string; steps: string[]; status?: string }>;
  console.log(`  detail: allocations ${JSON.stringify(allocations.map((a) => `${a.participant.slice(0, 10)}…:${a.steps.join('+')}`))}`);
  if (allocations.length !== 1 || allocations[0]!.participant.toLowerCase() !== CAROL) fail('expected exactly one allocation, to carol');
  console.log(`\n✓ spec 393 W2: carol's offer and alice's allocation went through the Ask (her own mandate; the organization's mandate by its steward); the outsider was refused at the member gate; carol could not allocate — the organization's mandate is not hers to give.`);
} finally { await restoreAutoWork(); }
