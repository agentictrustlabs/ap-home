/**
 * Spec 375 — the `on-commitment` EVENT trigger fires live: a signed commitment on the team's endeavor log
 * starts the coordinator's run ("allocate the contribution that was just committed…"), the agent as the asker
 * holding nothing; the act it reaches parks for a steward.
 *
 *   npx tsx scripts/verify-on-commitment.mts
 *
 * playwright-demo-team holds the Coordinator playbook. alice (its steward) requests, adopts, proposes and
 * adopts a one-step plan, offers as a participant, allocates to herself and commits — the product's own
 * ops, each re-validated by the reducer. Then the team's `on-commitment` row records the fired run.
 */
import { canonicalizeMessage, sha256Hex32 } from '../packages/fabric/src/messaging/index.js';
import type { Address, Hex } from 'viem';

const HOME = 'https://www.faithnet.me';
const A2A = 'https://a2a.faithnet.io';
const TEAM = '0x728b2b19a92afd51be1b4f9f0b823959255b481b' as Address; // playwright-demo-team
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 250), _status: r.status }; } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fail = (m: string): never => { console.error(`\n✗ ${m}`); process.exit(1); };
const alice = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: 'alice', client_id: 'demo-web' }) }));
const ALICE = String(alice.agent).toLowerCase() as Address;
const sign = async (digest: Hex): Promise<Hex> => { const b = await j(await fetch(`${HOME}/connect/persona-sign`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.homeSession}` }, body: JSON.stringify({ digest }) })); if (!b.signature) throw new Error(JSON.stringify(b).slice(0, 200)); return b.signature; };
const related = await j(await fetch(`${HOME}/connect/related-orgs?person=${ALICE}`, { headers: { authorization: `Bearer ${alice.homeSession}` } }));
const stewardship = (related.orgs ?? []).find((o: { orgAgent: string }) => o.orgAgent.toLowerCase() === TEAM)?.stewardshipDelegation;
if (!stewardship) fail('alice holds no stewardship wire for playwright-demo-team');
const ix = async (op: string, payload: Record<string, unknown>, withStewardship = false) => {
  const out = await j(await fetch(`${A2A}/interactions/${TEAM}/${op}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: alice.homeSession, ...(withStewardship ? { stewardship } : {}), ...payload }) }));
  if (!/\.(get|list)$/.test(op)) await sleep(900);
  return out;
};
const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
const csrf = (await j(csrfRes)) as { token?: string };
const cookie = (csrfRes.headers.get('set-cookie') ?? '').split(';')[0];
const post = async (path: string, body: unknown) => j(await fetch(`${HOME}/a2a${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: HOME, cookie, 'x-csrf-token': csrf.token ?? '' }, body: JSON.stringify(body) }));
type Row = { triggerId: string; kind?: string; lastRunRef?: string; lastOutcome?: string; lastSaid?: string };
const rowsOf = async () => ((await post('/harness/triggers', { session: alice.homeSession, addressee: TEAM })) as { triggers?: Row[] }).triggers ?? [];
const before = (await rowsOf()).find((r) => r.triggerId === 'on-commitment');
if (!before || before.kind !== 'event') fail('the team declares no on-commitment event trigger — republish the coordinator and reassign');
console.log(`on-commitment before: ${before!.lastRunRef ?? '(never fired)'}`);

const autoBefore = await ix('autowork.get', {}, true);
if (autoBefore.enabled) { await ix('autowork.disable', {}, true); console.log('setup: auto-work paused'); }
try {
  const nonce = Date.now().toString(36);
  const requested = await ix('endeavor.request', { goal: `Trigger check ${nonce}: one step to commit`, entryPoint: 'home-request' }, true);
  const requestId = requested.requestId ?? requested.request?.requestId;
  if (!requestId) fail(`endeavor.request: ${JSON.stringify(requested).slice(0, 300)}`);
  const findEndeavor = async (): Promise<string | undefined> => {
    const list = await ix('endeavor.list', {}, true);
    return ((list.endeavors ?? list.rows ?? []) as Array<Record<string, unknown>>).find((e) => `${e.title ?? ''}${e.goal ?? ''}`.includes(nonce))?.endeavorId as string | undefined;
  };
  let endeavorId = await findEndeavor();
  if (!endeavorId) { await ix('endeavor.create', { requestId, decision: 'adopt' }, true).catch(() => ({})); for (let i = 0; i < 10 && !endeavorId; i++) { await sleep(2500); endeavorId = await findEndeavor(); } }
  if (!endeavorId) fail('the request never became an endeavor');
  console.log(`endeavor ${endeavorId}`);
  const steps = [{ stepId: 'step_one', kind: 'contribution', description: 'Pay 1 USDC to nathan.treasury', capabilityRequirements: [{ capabilityIri: 'urn:ap:cap:treasury.payment.execute', minAssertionStrength: 'declared' }] }];
  const proposed = await ix('endeavor.proposePlan', { endeavorId, steps, edges: [], milestones: [] }, true);
  if (!proposed.ok) fail(`proposePlan: ${JSON.stringify(proposed).slice(0, 300)}`);
  const get = await ix('endeavor.get', { endeavorId }, true);
  const mine = ((get.plans ?? []) as Array<{ planId: string; revision: number; contentHash: string }>).find((p) => p.planId === proposed.planId && p.revision === proposed.revision) ?? (get.plan?.planId === proposed.planId ? get.plan : null);
  const planRef = { planId: proposed.planId, revision: proposed.revision, hash: (mine?.contentHash ?? get.plan?.contentHash) as string };
  const adopted = await ix('endeavor.adoptPlan', { endeavorId, planRef }, true);
  if (!adopted.ok) fail(`adoptPlan: ${JSON.stringify(adopted).slice(0, 300)}`);
  const offer = await ix('endeavor.propose', { endeavorId, planRef, steps: ['step_one'], note: 'I will pay it' });
  if (!offer.ok) fail(`offer: ${JSON.stringify(offer).slice(0, 300)}`);
  const alloc = await ix('endeavor.allocate', { endeavorId, proposalRef: offer.proposalId, participant: ALICE, steps: ['step_one'] }, true);
  if (!alloc.ok) fail(`allocate: ${JSON.stringify(alloc).slice(0, 300)}`);
  const payloadHash = await sha256Hex32(canonicalizeMessage({ endeavorId, allocationRef: alloc.allocationId, planRef, steps: ['step_one'] }));
  const committed = await ix('endeavor.commit', { endeavorId, allocationRef: alloc.allocationId, participant: ALICE, planRef, steps: ['step_one'], signature: { payloadHash, signer: ALICE, scheme: 'erc1271', signature: await sign(payloadHash as Hex) } });
  if (!committed.ok) fail(`commit: ${JSON.stringify(committed).slice(0, 300)}`);
  console.log(`  committed ${committed.commitmentId} — ContributionCommitted is on the team's log`);

  let fired: Row | undefined;
  for (let i = 0; i < 30; i++) {
    fired = (await rowsOf()).find((r) => r.triggerId === 'on-commitment');
    if (fired?.lastRunRef && fired.lastRunRef !== before!.lastRunRef) break;
    await sleep(3000);
  }
  console.log(`on-commitment → ${fired?.lastRunRef && fired.lastRunRef !== before!.lastRunRef ? `${fired.lastOutcome} (run ${fired.lastRunRef}) — "${(fired.lastSaid ?? '').slice(0, 160)}"` : 'did not fire'}`);
  if (!fired?.lastRunRef || fired.lastRunRef === before!.lastRunRef) fail('ContributionCommitted did not fire the coordinator\'s on-commitment trigger');
  if (fired.lastOutcome === 'failed') fail(`the fired run failed: ${fired.lastSaid}`);
  console.log(`\n✓ spec 375: a signed commitment fired the coordinator's on-commitment run at the team — the agent asked as itself, presenting nothing${fired.lastOutcome === 'parked' ? '; the act it reached parks for a steward' : ''}.`);
} finally {
  if (autoBefore.enabled) await ix('autowork.enable', {}, true).catch(() => undefined);
}
