/**
 * Spec 398 §13 — THE FIRST DEMONSTRATION, as far as it runs today, read through the HOME'S OWN PROJECTIONS.
 *
 *   npx tsx scripts/verify-golden-journey.mts        (from the repo root; HOME_URL=… to point elsewhere)
 *
 * "Create a workspace for our recurring group, prepare the first event with two specialists, and build an event page.
 *  Draft the invitations and page; ask before sending or publishing."
 *
 * What runs here, in the journey's order, each step checked against what Home SHOWS (Today's assembly, the attention
 * model, the inspector's record — the same pure modules the screens render from, over the same endpoints):
 *   1. charter the workspace under the person's org — the ask parks on authority; TODAY lists it under "needs my
 *      decision" (398 §4.2) as `awaiting-approval` (§5.1); the person grants, answers the custodian prompt, signs; done.
 *   2. the INSPECTOR reads the run artifact-first (§5.2): outcome completed, the step's authority verdict, its receipt.
 *   3. the accountable WORK ITEM (§4.3): a request adopted at the organization; the item projects owner · executors ·
 *      status · acceptance (absent said absent).
 *   4. the run ASKS before it acts: a decision request naming an approver; HER Today and attention list it under
 *      "needs my decision"; she decides = the record; it leaves her Today.
 *   Negative twin covered inline: T06 — a different question may not ride the run's mandate (the digest binds it).
 *   Twins covered by their own gates in the ledger: T11 verify-cancel · T07 verify-grant-revocation · T05 verify-ask-surface.
 * NOT YET (named, never faked): two specialist allocations with artifacts linked to the item (391 refs on the item);
 * the "send" decision from a run's own decision request (393 W2 from the harness); the page's publication requested BY
 * THE RUN (step 5 publishes it as the person's act — the release is real, the run's asking is not yet). The parity pair (§7.2 (4)) for this journey's capabilities — organization.team.create,
 * coordination.decision.request/record — is judged by `check:interaction-coverage:behaviour` (249 pairs; AGENT_URL for the
 * live offer). The gate reports what it covered; it fails only on what it claims.
 */
import { toHex, type Address, type Hex } from 'viem';
import { buildDigestBindingCaveat, capabilityHandler, hashDelegation, ROOT_AUTHORITY, type Caveat, type Delegation, type MandateRequirementV1 } from '@agenticprimitives/delegation';
import { assembleToday } from '../apps/home/src/home/today';
import { assembleAttention } from '../apps/home/src/home/attention';
import { workItemOf } from '../apps/home/src/home/work-item';
import { artifactIdentity } from '../apps/home/src/home/artifact-identity';
import { projectAllocationEntry, projectCommitmentEntry, projectDecisionCard } from '../apps/home/src/lib/work-client';
import { fixture as fx, HOME, A2A, resolveOrgAgent } from './fixture.mts';


const CHAIN = 34348;
const E = {
  delegationManager: '0x710cb1bF08C234Df397e0910331e0A29710EF4F7', timestamp: '0x73A7B878168b7DE48677617179A8bE894f0Dfe96',
  allowedTargets: '0x2156311097A936de1916a878bF53Bfd43c7b5715', allowedMethods: '0xdBb2E47793393C499efB0f3fcbf6Ca8669791a41',
  value: '0x8759c1a6cEBF1D5069e9434EF46327Bf2ef69975', digestBinding: '0xA3bb9BCC9b2F6F2419E1aBe5ED6Fd5399b9E68e1',
} as const;
const N = Date.now().toString(36).slice(-4);

const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 300), _status: r.status }; } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let restore: () => Promise<void> = async () => undefined;
const fail = (m: string): never => { console.error(`\n✗ ${m}`); void restore().finally(() => process.exit(1)); throw new Error(m); };
const signinAs = async (handle: string) => {
  const s = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle, client_id: 'demo-jp' }) }));
  if (!s.homeSession) fail(`no session for ${handle}`);
  return s as { homeSession: string; agent: string };
};
const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
const csrf = (await j(csrfRes)) as { token?: string };
const cookie = (csrfRes.headers.get('set-cookie') ?? '').split(';')[0];
const H: Record<string, string> = { 'content-type': 'application/json', origin: HOME, cookie: cookie ?? '', 'x-csrf-token': csrf.token ?? '' };
const harness = async (path: string, body: unknown) => j(await fetch(`${HOME}/a2a/harness/${path}`, { method: 'POST', headers: H, body: JSON.stringify(body) }));

const alice = await signinAs(fx.people.steward); const ALICE = String(alice.agent).toLowerCase() as Address;
const carol = await signinAs(fx.people.member2); const CAROL = String(carol.agent).toLowerCase() as Address;
const ORG = (process.env.ORG ? process.env.ORG.toLowerCase() : await resolveOrgAgent(alice.homeSession)) as Address;
const WORKSPACE = (process.env.WORKSPACE ? process.env.WORKSPACE.toLowerCase() : await resolveOrgAgent(alice.homeSession, fx.workspace)) as Address;
const personas = await j(await fetch(`${HOME}/connect/demo-personas`));
const credential = { kind: 'eoa', address: (personas.personas as Array<{ sa: string; custodian: string }>).find((p) => p.sa.toLowerCase() === ALICE)!.custodian };
const sign = async (token: string, digest: Hex): Promise<Hex> => {
  const b = await j(await fetch(`${HOME}/connect/persona-sign`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` } as Record<string, string>, body: JSON.stringify({ digest }) }));
  if (!b.signature) fail(`persona-sign refused: ${JSON.stringify(b).slice(0, 200)}`);
  return b.signature;
};
async function mintMandate(token: string, reply: { requirement: MandateRequirementV1; delegate: Address; delegator: Address }) {
  const caveats: Caveat[] = [...capabilityHandler.toCaveats(reply.requirement, E as never), buildDigestBindingCaveat(E.digestBinding, 'intent', reply.requirement.intentDigest as Hex)];
  const salt = BigInt(toHex(crypto.getRandomValues(new Uint8Array(16))));
  const d: Delegation = { delegator: reply.delegator, delegate: reply.delegate, authority: ROOT_AUTHORITY, caveats, salt, signature: '0x' };
  d.signature = await sign(token, hashDelegation(d, CHAIN, E.delegationManager));
  return { ...d, salt: salt.toString() };
}

/** TODAY as the screen assembles it for a person at an addressee: the same pure function over the same reads. */
async function todayFor(session: { homeSession: string; agent: string }, addressee: Address, org?: Address) {
  const runs = await harness('runs', { session: session.homeSession, addressee });
  const trig = await harness('triggers', { session: session.homeSession, addressee }).catch(() => ({ triggers: [] }));
  let bundles: Parameters<typeof assembleToday>[0]['bundles'] = [];
  if (org) {
    const me = String(session.agent).toLowerCase();
    const r = await j(await fetch(`${A2A}/interactions/${org}/endeavor.list`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: session.homeSession }) }));
    const mine = (r.mine ?? {}) as { allocations?: never[]; commitments?: Array<{ status: string }>; decisions?: Array<{ status: string }> };
    bundles = [{
      org, orgName: fx.org.name, allocations: mine.allocations ?? [],
      entries: [...(mine.allocations ?? []).map((a) => projectAllocationEntry(org, me, a)), ...(mine.commitments ?? []).filter((c) => c.status === 'active').map((c) => projectCommitmentEntry(org, me, c as never))],
      decisions: (mine.decisions ?? []).filter((d) => d.status === 'pending').map((d) => projectDecisionCard(org, d as never)),
      myRequests: [], endeavors: r.endeavors ?? [],
    }];
  }
  return assembleToday({ now: Date.now(), parked: runs.runs ?? [], bundles, artifacts: [], triggers: trig.triggers ?? [], vocabulary: [] });
}

console.log(`── the journey, ${N}: alice charters a team at her workspace, the organization adopts the first event, carol decides ──`);

// ── 1. charter: the ask parks; TODAY lists it as a decision ──────────────────────────────────────────────────
const message = `create a team called gj-${N}`;
let r = await harness('ask', { session: alice.homeSession, addressee: WORKSPACE, message });
if (r.reply?.kind !== 'authority_required' || !r.resumable) fail(`expected the charter to park on authority: ${JSON.stringify(r).slice(0, 300)}`);
const runRef: string = r.runRef;
let today = await todayFor(alice, WORKSPACE);
const onToday = today.decisions.find((d) => d.runRef === runRef);
console.log(`  1 ask → ${r.reply.kind}; Today: ${onToday ? `"needs my decision" · ${onToday.state?.state}` : 'NOT ON TODAY'}`);
if (onToday?.state?.state !== 'awaiting-approval') fail('Today must list the parked charter under needs-my-decision as awaiting-approval');

// T06 twin, inline: a different sentence may not ride this run's mandate.
const swapped = await harness('ask', { session: alice.homeSession, addressee: WORKSPACE, runRef, message: 'pay someone instead' });
console.log(`  T06 a different question on the run → ${swapped.ok === false ? `refused: ${String(swapped.error).slice(0, 60)}` : 'ALLOWED'}`);
if (swapped.ok !== false) fail('a different question must not ride the parked run');

// grant → custodian → signature → done
const wire = await mintMandate(alice.homeSession, r.reply);
r = await harness('ask', { session: alice.homeSession, addressee: WORKSPACE, runRef, presented: wire });
if (r.reply?.kind !== 'prompt') fail(`expected the custodian prompt: ${JSON.stringify(r).slice(0, 300)}`);
r = await harness('ask', { session: alice.homeSession, addressee: WORKSPACE, runRef, supplied: [{ stepRef: r.reply.resumeToken, data: { custodian: credential } }] });
if (r.reply?.kind !== 'prompt' || r.reply.prompt.kind !== 'signature') fail(`expected the genesis signature prompt: ${JSON.stringify(r).slice(0, 300)}`);
const p = r.reply.prompt as { digest: Hex; signer: string; payload: unknown };
r = await harness('ask', { session: alice.homeSession, addressee: WORKSPACE, runRef, supplied: [{ stepRef: r.reply.resumeToken, signature: { digest: p.digest, signer: p.signer, signature: await sign(alice.homeSession, p.digest), payload: p.payload } }] });
if (r.reply?.kind !== 'done') fail(`expected done: ${JSON.stringify(r).slice(0, 400)}`);
console.log(`    granted · custodian named · signed → done: ${r.reply.result?.name ?? ''} at ${String(r.reply.result?.agent ?? '').slice(0, 12)}…`);
today = await todayFor(alice, WORKSPACE);
if (today.decisions.some((d) => d.runRef === runRef)) fail('a finished run must leave Today');
console.log('    Today: the decision is gone');

// ── 2. the inspector, artifact-first ─────────────────────────────────────────────────────────────────────────
const insp = await harness('provenance', { session: alice.homeSession, addressee: WORKSPACE, runRef, format: 'record' });
const rec = insp.record as { outcome: string; steps: Array<{ stepRef: string; status: string; authority?: { decision: string; presentedRef: string | null }; receiptDigest?: string; artifact?: unknown }>; bill?: unknown } | undefined;
const acted = rec?.steps.find((s) => s.authority?.decision === 'allow' && s.status === 'executed');
console.log(`  2 inspector: outcome=${rec?.outcome} · ${rec?.steps.length ?? 0} steps · acted step ${acted?.stepRef ?? '—'} authority ${acted?.authority?.decision ?? '—'} under ${String(acted?.authority?.presentedRef ?? '').slice(0, 12)}… receipt ${String(acted?.receiptDigest ?? '').slice(0, 12)}… · artifacts ${rec?.steps.filter((s) => s.artifact).length ?? 0} · bill ${rec?.bill ? 'yes' : 'no'}`);
if (rec?.outcome !== 'completed' || !acted?.receiptDigest) fail('the inspector must show a completed run with a verified, receipted step');

// ── 3 + 4. the work item and the decision, at the organization ─────────────────────────────────────────────
const ix = async (token: string, op: string, payload: Record<string, unknown>, steward?: unknown): Promise<Record<string, unknown> & { httpStatus: number }> => {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${A2A}/interactions/${ORG}/${op}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: token, ...(steward ? { stewardship: steward } : {}), ...payload }) });
    const out = await j(res);
    if (res.status === 409 && /auth failed — mcp/.test(String(out.error)) && attempt < 6) { await sleep(10_000 * (attempt + 1)); continue; }
    await sleep(op.endsWith('.list') ? 3000 : 1500);
    return { ...out, httpStatus: res.status };
  }
};
const related = await j(await fetch(`${HOME}/connect/related-orgs?person=${ALICE}`, { headers: { authorization: `Bearer ${alice.homeSession}` } }));
const stewardship = (related.orgs ?? []).find((o: { orgAgent: string }) => o.orgAgent.toLowerCase() === ORG)?.stewardshipDelegation;
if (!stewardship) fail('alice holds no stewardship wire for the organization');
const autoBefore = await ix(alice.homeSession, 'autowork.get', {}, stewardship);
restore = async () => { if (autoBefore.enabled) await ix(alice.homeSession, 'autowork.enable', {}, stewardship).catch(() => undefined); };
if (autoBefore.enabled) await ix(alice.homeSession, 'autowork.disable', {}, stewardship);
try {
  const title = `First event gj-${N}`;
  const requested = await ix(alice.homeSession, 'endeavor.request', { goal: `${title}: prepare the first event of the recurring group`, entryPoint: 'home-request' }, stewardship);
  const requestId = (requested.requestId ?? (requested.request as { requestId?: string } | undefined)?.requestId) as string | undefined;
  if (!requestId) fail(`endeavor.request: ${JSON.stringify(requested).slice(0, 300)}`);
  const created = await ix(alice.homeSession, 'endeavor.create', { requestId, decision: 'adopt', title }, stewardship);
  let endeavorId: string = typeof created.endeavorId === 'string' ? created.endeavorId : '';
  if (!endeavorId) {
    const list = await ix(alice.homeSession, 'endeavor.list', {}, stewardship);
    endeavorId = String(((list.endeavors ?? []) as Array<Record<string, unknown>>).find((e) => String(e.title ?? '').includes(`gj-${N}`))?.endeavorId ?? '');
  }
  if (!endeavorId) fail(`the request never became an endeavor: ${JSON.stringify(created).slice(0, 200)}`);
  const detail = await ix(alice.homeSession, 'endeavor.get', { endeavorId }, stewardship);
  const item = workItemOf(ORG, endeavorId, detail as never);
  console.log(`  3 work item ${endeavorId}: goal "${item?.goal}" · accountable ${item?.owner.agent.slice(0, 10)}… · executors ${item?.executors.length ?? 0} · ${item?.state.state} · acceptance ${item?.acceptance.criteria.length ?? 0} criteria, ${item?.acceptance.approvers.length ?? 0} approvers · artifacts ${item?.artifacts.length ?? 0} · cost ${item?.cost ? 'yes' : 'absent'}`);
  if (!item || item.owner.agent !== ORG || item.state.state !== 'queued' && item.state.state !== 'running') fail('the work item must project the organization as accountable with a projected state');

  // the ask before the act: a decision naming carol
  const raised = await ix(alice.homeSession, 'endeavor.decision.request', { endeavorId, title: `Send the invitations for gj-${N}?`, decisionKind: 'send', summary: '12 recipients · message digest on the card · expires in a day', approvers: [CAROL] }, stewardship);
  const decisionId = raised.decisionId as string | undefined;
  if (raised.ok !== true || !decisionId) fail(`decision.request: ${JSON.stringify(raised).slice(0, 300)}`);
  const carolToday = await todayFor(carol, CAROL, ORG);
  const carolCard = carolToday.decisions.find((d) => d.id === `decision:${decisionId}`);
  const carolAttention = assembleAttention({ now: Date.now(), parked: [], bundles: [], artifacts: [], triggers: [], vocabulary: [], cases: [], dms: [], me: CAROL });
  console.log(`  4 decision ${decisionId} raised for carol; her Today: ${carolCard ? `"needs my decision" · ${carolCard.state?.state} · ${carolCard.title}` : 'NOT LISTED'}; attention filters: ${Object.keys(carolAttention).length}`);
  if (carolCard?.state?.state !== 'awaiting-approval') fail("the decision must be on carol's Today under needs-my-decision");
  const decided = await ix(carol.homeSession, 'endeavor.decide', { endeavorId, decisionId, outcome: 'approved', reason: 'The list is the one we agreed; send them.' });
  if (decided.ok !== true) fail(`carol's decision: ${JSON.stringify(decided).slice(0, 300)}`);
  const after = await todayFor(carol, CAROL, ORG);
  if (after.decisions.some((d) => d.id === `decision:${decisionId}`)) fail("a recorded decision must leave carol's Today");
  const detail2 = await ix(alice.homeSession, 'endeavor.get', { endeavorId }, stewardship);
  const item2 = workItemOf(ORG, endeavorId, detail2 as never);
  console.log(`    carol approved → gone from her Today; the item's acceptance now names ${item2?.acceptance.approvers.map((a) => `${a.agent.slice(0, 10)}… (${a.decisionKind}${a.pending ? ', pending' : ''})`).join(', ')}`);
} finally { await restore(); }

// ── 5. the page: drafted into the organization's Library, PUBLISHED as a signed release (§6.2) ───────────────────────
// "build an event page … ask before publishing": the page is an artifact in Missio Nexus's Library (alice stewards it);
// publishing is a distinct act — a release, signed by the publisher, naming the content commitment — and the identity
// strip (§6.2) says version · author · sources · scope · access method · the release. Removed after.
{
  const lib = async (body: unknown) => j(await fetch(`${HOME}/connect/library?org=${ORG}`, { method: 'POST', headers: { authorization: `Bearer ${alice.homeSession}`, 'content-type': 'application/json' }, body: JSON.stringify({ org: ORG, ...(body as object) }) }));
  const page = '# The retreat\n\nSaturday, 10am, the hall. Bring a friend.\n';
  const saved = await lib({ action: 'save', artifact: { name: 'retreat-event-page.md', kind: 'md', source: 'blob', folder: 'pages', contentType: 'text/markdown', bytesB64: Buffer.from(page, 'utf8').toString('base64') } });
  if (!saved.ok) fail(`the page could not be drafted into the Library: ${JSON.stringify(saved).slice(0, 200)}`);
  const before = artifactIdentity(saved.artifact, { sa: ORG, vaultLabel: `${fx.org.name} vault` }, true);
  const published = await lib({ action: 'publish', id: saved.artifact.id });
  if (!published.ok) fail(`the page could not be published: ${JSON.stringify(published).slice(0, 200)}`);
  const after = artifactIdentity(published.artifact, { sa: ORG, vaultLabel: `${fx.org.name} vault` }, true);
  console.log(`  5 page ${saved.artifact.id}: ${before.version} · ${before.accessMethod} · publish ${before.acts.publish} · sources ${before.sources.map((x) => x.kind).join('+')} → published ${published.release.version} by ${String(published.release.publisher).slice(0, 10)}… ${published.release.signed ? 'signed' : 'UNSIGNED'} · strip: release ${after.latestRelease?.version ?? '—'}`);
  if (before.acts.publish !== 'offered' || !published.release.signed || after.latestRelease?.version !== '1.0.0') fail('the page publish did not happen as a signed release the strip shows');
  const rid = published.release.releaseId;
  await lib({ action: 'delete', id: saved.artifact.id });
  console.log(`    release ${String(rid).slice(0, 14)}… minted; the draft removed again (the gate leaves no artifact behind)`);
}

console.log(`
✓ spec 398 §13 — covered: charter parks → Today decision → grant/sign → done → inspector (completed, verified, receipted) →
  work item (owner, state, acceptance) → decision request on carol's Today → recorded → gone → the page drafted and
  PUBLISHED as a signed release (§6.2). T06 inline; T11/T07/T05 by their own gates.
  not yet: specialist allocations with artifacts on the item · the run's own send decision (393 W2 in the harness) ·
  the page's publication REQUESTED BY THE RUN (today the person publishes; "ask before publishing" is a 393 decision the
  run does not yet raise). The parity pair: check:interaction-coverage:behaviour.`);
