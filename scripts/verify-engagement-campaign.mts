/**
 * Spec 384 W3 (appendix M7) — THE CAMPAIGN FROM AN ENDEAVOR STEP, live on Missio Nexus.
 *
 *   npx tsx scripts/verify-engagement-campaign.mts        (from the repo root)
 *
 * alice (steward) proposes and adopts a one-step plan whose step is an INTERACTION naming
 * `treasury.payment.execute` ("Pay 1 USDC to nathan.treasury"). The organization's work turn does not run it
 * itself: it finds candidates in the public tier, probes each once as the organization, records the
 * OfferSelection on the endeavor (who was asked, who offered, who was chosen and why, who was not and why),
 * and parks the run bound to the selected provider and its offer. alice claims the run in the Ask, is asked
 * for a mandate that NAMES the offer, grants it → the step runs at the provider under the organization's
 * mandate → the step is satisfied with a receipt citing run, mandate, tx and OFFER.
 * Twin: a mandate naming NO offer for the same step → `offer-not-bound`.
 */
import { hashDelegation, buildDigestBindingCaveat, paymentHandler, ROOT_AUTHORITY, registerDefaultSubsetHandlers, type Delegation, type Caveat, type MandateRequirementV1 } from '../packages/delegation/src/index.js';
import type { Address, Hex } from 'viem';
registerDefaultSubsetHandlers();

const HOME = 'https://www.faithnet.me';
const A2A = 'https://a2a.faithnet.io';
const CHAIN = 34348;
const DM = '0x710cb1bF08C234Df397e0910331e0A29710EF4F7' as Address;
const ENFORCERS = { delegationManager: DM, timestamp: '0x73A7B878168b7DE48677617179A8bE894f0Dfe96', allowedTargets: '0x2156311097A936de1916a878bF53Bfd43c7b5715', allowedMethods: '0xdBb2E47793393C499efB0f3fcbf6Ca8669791a41', value: '0x8759c1a6cEBF1D5069e9434EF46327Bf2ef69975', payment: '0x07fA0aE59FdE4B7ce8962d6fE7a1d648ec3DD5CE', digestBinding: '0xA3bb9BCC9b2F6F2419E1aBe5ED6Fd5399b9E68e1' } as const;
const ORG = '0x3b99f2b452766de5df0dbcdfc676f27257151333' as Address; // Missio Nexus
const ALICE2 = '0x5ef5360a41f31e55541117a854455c0da0fb67b3'; // alice's typed treasury, marked primaryPayer
const CAP = 'treasury.payment.execute';
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 250), _status: r.status }; } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const alice = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: 'alice', client_id: 'demo-web' }) }));
const ALICE = String(alice.agent).toLowerCase() as Address;
const token: string = alice.homeSession;
const sign = async (digest: Hex): Promise<Hex> => { const b = await j(await fetch(`${HOME}/connect/persona-sign`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ digest }) })); if (!b.signature) throw new Error(`persona-sign refused: ${JSON.stringify(b).slice(0, 200)}`); return b.signature; };
const related = await j(await fetch(`${HOME}/connect/related-orgs?person=${ALICE}`, { headers: { authorization: `Bearer ${token}` } }));
const stewardship = (related.orgs ?? []).find((o: { orgAgent: string }) => o.orgAgent.toLowerCase() === ORG)?.stewardshipDelegation;
if (!stewardship) throw new Error('alice holds no stewardship wire for Missio Nexus');
const ix = async (op: string, payload: Record<string, unknown>) => {
  const out = await j(await fetch(`${A2A}/interactions/${ORG}/${op}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: token, stewardship, ...payload }) }));
  if (!/\.(get|list|read)$/.test(op)) await sleep(900); // pace the organization's vault budget
  return out;
};
// The Ask, through the Home's proxy (the same door the flyout uses).
const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
const csrf = (await j(csrfRes)) as { token?: string };
const cookie = (csrfRes.headers.get('set-cookie') ?? '').split(';')[0];
const post = async (path: string, body: unknown) => j(await fetch(`${HOME}/a2a${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: HOME, cookie, 'x-csrf-token': csrf.token ?? '' }, body: JSON.stringify(body) }));

// ── 0. setup: auto-work OFF while the endeavor and plan are set up (so the assistant drafts nothing of its
// own), ON for the adoption (that is what dispatches the work turn — and the campaign). Restored at the end.
const autoBefore = await ix('autowork.get', {});
const restore = async () => { await ix(autoBefore.enabled ? 'autowork.enable' : 'autowork.disable', {}).catch(() => undefined); };
try {
  if (autoBefore.enabled) await ix('autowork.disable', {});
  // ── 1. the endeavor and its one INTERACTION step ────────────────────────────────────────────────────
  const nonce = Date.now().toString(36);
  const LABEL = `Venue campaign ${nonce}`;
  const requested = await ix('endeavor.request', { goal: `${LABEL}: get the venue deposit paid`, entryPoint: 'home-request' });
  const requestId = requested.requestId ?? requested.request?.requestId;
  if (!requestId) throw new Error(`endeavor.request: ${JSON.stringify(requested).slice(0, 300)}`);
  const findEndeavor = async (): Promise<string | undefined> => ((await ix('endeavor.list', {})).endeavors ?? []).find((e: Record<string, unknown>) => `${e.title ?? ''}${e.goal ?? ''}`.includes(nonce))?.endeavorId;
  let endeavorId = await findEndeavor();
  if (!endeavorId) { await ix('endeavor.create', { requestId, decision: 'adopt' }).catch(() => ({})); for (let i = 0; i < 10 && !endeavorId; i++) { await sleep(2500); endeavorId = await findEndeavor(); } }
  if (!endeavorId) throw new Error('the request never became an endeavor');
  console.log(`endeavor ${endeavorId} (${LABEL})`);
  const steps = [{ stepId: 'step_venue', kind: 'interaction', description: 'Pay 1 USDC to nathan.treasury', capabilityRequirements: [{ capabilityIri: `urn:ap:cap:${CAP}`, minAssertionStrength: 'declared' }] }];
  const proposed = await ix('endeavor.proposePlan', { endeavorId, steps, edges: [], milestones: [] });
  if (!proposed.ok) throw new Error(`proposePlan: ${JSON.stringify(proposed).slice(0, 300)}`);
  let get = await ix('endeavor.get', { endeavorId });
  const mine = ((get.plans ?? []) as Array<{ planId: string; revision: number; contentHash: string }>).find((p) => p.planId === proposed.planId && p.revision === proposed.revision) ?? (get.plan?.planId === proposed.planId ? get.plan : null);
  const planRef = { planId: proposed.planId, revision: proposed.revision, hash: (mine?.contentHash ?? get.plan?.contentHash) as string };
  if (!planRef.hash) throw new Error(`no content hash for the proposed plan: ${JSON.stringify(get).slice(0, 300)}`);
  await ix('autowork.enable', {});
  const adopted = await ix('endeavor.adoptPlan', { endeavorId, planRef });
  if (!adopted.ok) throw new Error(`adoptPlan: ${JSON.stringify(adopted).slice(0, 300)}`);
  console.log(`  plan ${planRef.planId}@${planRef.revision} adopted; the organization's work turn is dispatched`);

  // ── 2. the campaign ran: a run parked bound to a provider + offer, and the selection on the endeavor ──
  type Run = { runRef: string; asker: string; addressee: string; openToStewards?: boolean; origin?: { endeavorId: string; stepId: string; principal: string; engagement?: { capability: string; provider: string; providerName?: string | null; offerId: string; offerDigest: string; campaignId: string } } };
  let run: Run | undefined;
  for (let i = 0; i < 40 && !run; i++) {
    const list = await post('/harness/runs', { session: token, addressee: ORG });
    run = ((list.runs ?? []) as Run[]).find((r) => r.origin?.endeavorId === endeavorId && r.origin.stepId === 'step_venue');
    if (!run) await sleep(3000);
  }
  if (!run) throw new Error('no run was parked for the interaction step');
  const eng = run.origin?.engagement;
  console.log(`  parked ${run.runRef} (openToStewards ${run.openToStewards ?? false})${eng ? ` → handed to ${eng.providerName ?? eng.provider} under offer ${eng.offerId} (${eng.offerDigest.slice(0, 12)}…)` : ' — NO provider selected'}`);
  const thread = await ix('channels.read', { channelId: `conv_${endeavorId}` });
  const bodies = Object.values((thread.bodies ?? {}) as Record<string, unknown>).map((b) => (typeof b === 'string' ? b : JSON.stringify(b)));
  const note = bodies.find((b) => b.includes('ap.offer-selection.v1'));
  if (!note) throw new Error('the endeavor was not told about the campaign (no ap.offer-selection.v1 record on the thread)');
  const fenced = /```ap\.offer-selection\.v1\\n([\s\S]*?)\\n```/.exec(note) ?? /```ap\.offer-selection\.v1\n([\s\S]*?)\n```/.exec(note);
  const selection = JSON.parse((fenced?.[1] ?? '{}').replace(/\\"/g, '"')) as { selected: { provider: string; offerId: string; offerDigest: string } | null; because: string[]; notSelected: Array<{ provider: string; because: string }> };
  console.log(`  the endeavor's record: ${note.split('\n')[0]}`);
  for (const line of note.split('\n').filter((l) => l.startsWith('- '))) console.log(`    ${line}`);
  if (!selection.selected) throw new Error(`the campaign selected nobody: ${JSON.stringify(selection).slice(0, 400)}`);
  console.log(`  selected ${selection.selected.provider} because: ${selection.because.join('; ')}`);
  for (const n of selection.notSelected) console.log(`  not selected ${n.provider}: ${n.because}`);
  if (!eng) throw new Error('the run does not carry the selection');
  if (eng.provider.toLowerCase() !== selection.selected.provider.toLowerCase() || eng.offerDigest.toLowerCase() !== selection.selected.offerDigest.toLowerCase()) throw new Error('the parked run and the recorded selection disagree');
  const OFFER = eng.offerDigest as Hex;
  const PROVIDER = eng.provider.toLowerCase();
  console.log(`  ✓ ${selection.notSelected.length} candidate(s) recorded as not selected, each with its reason; ${note.includes('score') ? '⚠ the note mentions a score' : 'no score anywhere'}`);
  if (/\bscore\b/i.test(note)) throw new Error('the selection carries a score');

  // ── 3. alice claims the run: the mandate must NAME the offer; the provider runs it ─────────────────
  type Reply = { kind?: string; error?: string; runRef?: string; text?: string; resumeToken?: string; requirement?: MandateRequirementV1 & { offerDigest?: Hex }; delegator?: Address; delegate?: Address; capability?: string; routed?: Array<{ agent: string; observedVia: string }>;
    prompt?: { kind?: string; stepRef?: string; digest?: Hex; prompt?: string; signer?: string; payload?: unknown; fields?: Array<{ name: string; type: string; choices?: Array<{ value: string; label?: string; hint?: string }> }> } };
  const mint = async (rep: Reply, withOffer: boolean): Promise<Record<string, unknown>> => {
    const req = rep.requirement!;
    const caveats: Caveat[] = [...paymentHandler.toCaveats(req, ENFORCERS as never), buildDigestBindingCaveat(ENFORCERS.digestBinding, 'intent', req.intentDigest as Hex), ...(withOffer ? [buildDigestBindingCaveat(ENFORCERS.digestBinding, 'offer', OFFER)] : [])];
    let salt = 0n; for (const x of crypto.getRandomValues(new Uint8Array(16))) salt = (salt << 8n) | BigInt(x);
    const d: Delegation = { delegator: rep.delegator!, delegate: rep.delegate!, authority: ROOT_AUTHORITY, caveats, salt, signature: '0x' };
    d.signature = await sign(hashDelegation(d, CHAIN, DM));
    return { ...d, salt: salt.toString() };
  };
  const usdcOf = (hint?: string) => Number(/([\d.]+)\s*USDC/i.exec(hint ?? '')?.[1] ?? '0');
  const answerData = (rep: Reply) => {
    const data: Record<string, unknown> = {};
    for (const f of rep.prompt?.fields ?? []) {
      if (f.choices?.length) { const org = f.choices.find((c) => c.value.toLowerCase() === ORG); const best = org ?? [...f.choices].sort((x, y) => usdcOf(y.hint) - usdcOf(x.hint))[0]!; data[f.name] = best.value; console.log(`  answers ${f.name}: ${best.label ?? best.value}`); }
      else if (f.name === 'payee') data[f.name] = 'nathan.treasury';
      else if (/usdc|amount/i.test(f.name)) data[f.name] = '1';
      else data[f.name] = `venue deposit ${nonce}`;
    }
    return data;
  };
  let r = await post('/harness/ask', { session: token, addressee: ORG, runRef: run.runRef });
  let rep = r.reply as Reply;
  let asked: Reply | null = null;
  for (let turn = 0; turn < 10 && rep?.kind !== 'done'; turn++) {
    console.log(`alice's turn ${turn + 1} → ${rep?.kind}${rep?.kind === 'prompt' ? ` (${rep.prompt?.kind}: "${rep.prompt?.prompt?.slice(0, 70)}")` : rep?.kind === 'authority_required' ? ` (${rep.capability ?? ''}; delegator ${rep.delegator?.slice(0, 10)}…; requirement.offerDigest ${rep.requirement?.offerDigest?.slice(0, 12) ?? 'none'}…)` : rep?.error ? ` ${rep.error}` : ''}`);
    if (rep?.kind === 'refused') throw new Error(`the claimed run was refused: ${rep.error}`);
    if (rep?.kind === 'answer') throw new Error(`the claimed run ANSWERED instead of acting: ${rep.text?.slice(0, 200)}`);
    let presented: unknown = null; const supplied: unknown[] = [];
    if (rep?.kind === 'authority_required') {
      if (!rep.requirement || !rep.delegator || !rep.delegate) throw new Error(`mandate asked without a requirement: ${JSON.stringify(r).slice(0, 400)}`);
      if (rep.requirement.offerDigest?.toLowerCase() !== OFFER.toLowerCase()) throw new Error(`the requirement does not name the selected offer (${rep.requirement.offerDigest ?? 'none'})`);
      // WHO PAYS. missio-nexus.org charters NO typed treasury on faithnet, and the value rail refuses an untyped one
      // (spec 373), so the coordinator's own typed treasury pays for the organization's step — exactly as the
      // committed-step gate (spec 382) established. The point under test is the OFFER binding, not the payer identity.
      if (rep.delegator.toLowerCase() !== ALICE2) throw new Error(`the payer is not alice's typed treasury (${rep.delegator})`);
      asked = rep; presented = await mint(rep, true);
    } else if (rep?.kind === 'prompt' && rep.prompt?.kind === 'data') {
      supplied.push({ stepRef: rep.resumeToken ?? rep.prompt.stepRef ?? 's0', data: answerData(rep) });
    } else if (rep?.kind === 'prompt' && rep.prompt?.kind === 'signature' && rep.prompt.digest) {
      supplied.push({ stepRef: rep.resumeToken ?? rep.prompt.stepRef ?? 's0', signature: { digest: rep.prompt.digest, signer: rep.prompt.signer ?? ALICE, signature: await sign(rep.prompt.digest), ...(rep.prompt.payload !== undefined ? { payload: rep.prompt.payload } : {}) } });
    } else if (rep?.kind === 'prompt' && rep.prompt?.kind === 'confirmation') {
      supplied.push({ stepRef: rep.resumeToken ?? rep.prompt.stepRef ?? 's0', confirmation: true });
    } else throw new Error(`unexpected turn: ${JSON.stringify(r).slice(0, 500)}`);
    r = await post('/harness/ask', { session: token, addressee: ORG, runRef: run.runRef, ...(presented ? { presented } : {}), ...(supplied.length ? { supplied } : {}) });
    rep = r.reply;
  }
  console.log(`  → ${rep?.kind}${rep?.error ? ` ${rep.error}` : ''}; handed to ${rep?.routed?.[0]?.agent?.slice(0, 10) ?? 'nobody'} (${rep?.routed?.[0]?.observedVia ?? '-'}); step recorded: ${JSON.stringify(r.satisfiedStep ?? null)}`);
  if (rep?.kind !== 'done') throw new Error(`the step did not finish: ${JSON.stringify(r).slice(0, 700)}`);
  if (!asked) throw new Error('nobody was asked for a mandate — the step ran on no authority');
  if (rep.routed?.[0]?.agent?.toLowerCase() !== PROVIDER) throw new Error(`the step did not run at the selected provider (${rep.routed?.[0]?.agent ?? 'nobody'})`);
  if (!(r.satisfiedStep as { ok?: boolean })?.ok) throw new Error(`done but not recorded on the endeavor: ${JSON.stringify(r.satisfiedStep)}`);

  // ── 4. the endeavor: satisfied with a receipt that cites the offer ────────────────────────────────
  get = await ix('endeavor.get', { endeavorId });
  const st = ((get.plan?.steps ?? []) as Array<{ stepId: string; satisfied: boolean; evidence?: string }>).find((s) => s.stepId === 'step_venue');
  console.log(`  step_venue satisfied=${st?.satisfied} evidence="${(st?.evidence ?? '').slice(0, 200)}"`);
  if (!st?.satisfied) throw new Error('the step is not satisfied on the endeavor');
  if (!/urn:ap:receipt:run:/.test(st.evidence ?? '') || !new RegExp(`urn:ap:receipt:offer:${OFFER}`, 'i').test(st.evidence ?? '')) throw new Error('the evidence does not cite the run and the offer');
  console.log('  ✓ satisfied by a receipt citing run, mandate, tx and the OFFER the mandate named');

  // ── 5. twin: the same step with a mandate that names NO offer ─────────────────────────────────────
  const plan = { steps: [{ toolId: CAP, args: { payee: 'nathan.treasury', usdc: '1', memo: `twin ${nonce}`, offerDigest: OFFER }, id: 's0', executor: PROVIDER }] };
  let t = await post('/harness/ask', { session: token, addressee: ORG, message: `Pay 1 USDC to nathan.treasury (twin ${nonce})`, plan });
  let trep = t.reply as Reply;
  for (let i = 0; i < 3 && trep?.kind === 'prompt' && trep.prompt?.kind === 'data'; i++) { t = await post('/harness/ask', { session: token, addressee: ORG, runRef: trep.runRef, supplied: [{ stepRef: trep.resumeToken ?? 's0', data: answerData(trep) }] }); trep = t.reply; }
  if (trep?.kind !== 'authority_required' || !trep.requirement) throw new Error(`twin: expected the mandate to be asked: ${JSON.stringify(t).slice(0, 400)}`);
  const t2 = await post('/harness/ask', { session: token, addressee: ORG, runRef: trep.runRef, presented: await mint(trep, false) });
  const trep2 = t2.reply as Reply;
  console.log(`twin (mandate naming no offer) → ${trep2?.kind}: ${(trep2?.error ?? '').slice(0, 160)}`);
  if (trep2?.kind === 'done' || trep2?.kind === 'prompt') throw new Error('a mandate naming no offer was accepted for a step that fulfils one');
  if (!/offer-not-bound|names no offer/i.test(trep2?.error ?? '')) throw new Error(`refused for another reason: ${JSON.stringify(t2).slice(0, 400)}`);
  console.log('  ✓ an offer never becomes a commitment without the signature that names it');
  console.log('\nspec 384 W3 live: an interaction step → candidates from the public tier → probed as the organization → the selection recorded with every reason → the steward\'s mandate names the offer → the provider ran it → the receipt cites the offer. ✓');
} finally {
  await restore();
}
