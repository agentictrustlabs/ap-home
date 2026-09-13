/**
 * Spec 400 W2 (B5) — SEARCH OVER YOUR OWN WORK, live (supplied plans; no model).
 *
 *   npx tsx scripts/verify-search.mts        (FIXTURE_JSON=… for another estate; roles `people.steward`, `people.member`, `org`)
 *
 *   1. the steward sends a member a direct message carrying a phrase nobody has used; the member's inbox admits it and
 *      the recipient's object indexes it at that moment (no rebuild);
 *   2. the MEMBER searches their own work for the phrase → the message is found, cited by conversation and id, in
 *      "their own records";
 *   3. the steward posts the phrase in a topic of the organization she stewards → her search finds the topic post,
 *      cited by org, topic and post, "stewardship";
 *   4. THE TWIN: the member searches for the topic's phrase — the organization is not theirs to steward, so the post is
 *      not in their tier: nothing; and an outsider searching the DM's phrase finds nothing.
 *   5. a rebuild (`search.reindex`) on the steward's own object leaves the DM she SENT findable — the index is a
 *      projection of the records, and a wipe is a rebuild.
 */
import type { Address } from 'viem';
import { buildDigestBindingCaveat, capabilityHandler, hashDelegation, ROOT_AUTHORITY, type Caveat, type Delegation, type MandateRequirementV1 } from '@agenticprimitives/delegation';
import { randomBytes } from 'node:crypto';
import { personaCustodian } from '@agenticprimitives/runtime-member';
import { fixture as fx, HOME, A2A } from './fixture.mts';

const CHAIN_NAME = process.env.CHAIN_NAME ?? 'faithchain';
const C = ((await import(`@agenticprimitives/contracts/deployments/${CHAIN_NAME}`)) as { CONTRACTS: Record<string, string> & { chainId: number } }).CONTRACTS;
const DM = C.delegationManager as Address;
const ENF = { delegationManager: DM, timestamp: C.timestampEnforcer, allowedTargets: C.allowedTargetsEnforcer, allowedMethods: C.allowedMethodsEnforcer, value: C.valueEnforcer, payment: C.paymentEnforcer, digestBinding: C.digestBindingEnforcer };
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 250), _status: r.status }; } };
const fail = (m: string): never => { console.error(`\n✗ ${m}`); process.exit(1); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nameInfo = async (n: string): Promise<Address> => { const r = await j(await fetch(`${HOME}/connect/name-info?name=${encodeURIComponent(n)}`)); if (!r.exists || !r.agent) fail(`${n} does not resolve at ${HOME}`); return String(r.agent).toLowerCase() as Address; };

const steward = await personaCustodian(HOME, fx.people.steward);
const member = await personaCustodian(HOME, fx.people.member);
const outsider = await personaCustodian(HOME, fx.people.outsider);
const org = await nameInfo(fx.org.handle);
const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
const csrf = (await j(csrfRes)) as { token?: string };
const H = { 'content-type': 'application/json', origin: HOME, cookie: (csrfRes.headers.get('set-cookie') ?? '').split(';')[0] ?? '', 'x-csrf-token': csrf.token ?? '' };
const post = async (path: string, body: unknown) => j(await fetch(`${HOME}/a2a${path}`, { method: 'POST', headers: H, body: JSON.stringify(body) }));
type Reply = { kind?: string; error?: string; text?: string; runRef?: string; requirement?: MandateRequirementV1; delegator?: Address; delegate?: Address; alsoApprove?: Array<{ digest: `0x${string}` }>; result?: unknown; results?: Array<{ toolId: string; result: unknown }> };
async function approve(who: { bearer: string; signDigest: (d: `0x${string}`) => Promise<`0x${string}`> }, addressee: Address, runRef: string, rep: Reply): Promise<Reply> {
  if (!rep.requirement || !rep.delegator || !rep.delegate) fail(`nothing to approve on ${runRef}: ${JSON.stringify(rep).slice(0, 200)}`);
  const caveats: Caveat[] = [...capabilityHandler.toCaveats(rep.requirement!, ENF as never), buildDigestBindingCaveat(ENF.digestBinding as Address, 'intent', rep.requirement!.intentDigest as `0x${string}`)];
  let salt = 0n; for (const b of randomBytes(16)) salt = (salt << 8n) | BigInt(b);
  const mandate: Delegation = { delegator: rep.delegator!, delegate: rep.delegate!, authority: ROOT_AUTHORITY, caveats, salt, signature: '0x' };
  const a = await post('/harness/authorize', { session: who.bearer, delegator: rep.delegator, digests: [hashDelegation(mandate, C.chainId, DM), ...(rep.alsoApprove ?? []).map((x) => x.digest)] });
  if (a.ok !== true) fail(`authorize build: ${JSON.stringify(a).slice(0, 300)}`);
  const b2 = await post('/harness/authorize', { session: who.bearer, delegator: rep.delegator, userOp: a.userOp, signature: await who.signDigest(a.userOpHash) });
  if (b2.ok !== true) fail(`authorize submit: ${JSON.stringify(b2).slice(0, 300)}`);
  mandate.signature = '0x03';
  return ((await post('/harness/ask', { session: who.bearer, addressee, runRef, presented: { ...mandate, salt: salt.toString() } })).reply ?? {}) as Reply;
}
type Hit = { id: string; kind: string; snippet: string; where: { subject: string; why: string }; ref: { conversationId?: string; messageId?: string; org?: string; channelId?: string } };
async function search(who: { bearer: string; agent: Address }, query: string): Promise<{ results: Hit[]; searched: unknown[] }> {
  const r = (await post('/harness/ask', { session: who.bearer, addressee: who.agent, message: `search my work for ${query}`, plan: { steps: [{ toolId: 'person.work.search', args: { query } }] } })).reply as Reply;
  if (r.kind !== 'answer') fail(`the search did not answer: ${JSON.stringify(r).slice(0, 300)}`);
  const out = (r.results ?? []).find((x) => x.toolId === 'person.work.search')?.result as { results?: Hit[]; searched?: unknown[] } | undefined;
  return { results: out?.results ?? [], searched: out?.searched ?? [] };
}
const links = ((await j(await fetch(`${HOME}/connect/related-orgs?surface=any`, { headers: { authorization: `Bearer ${steward.bearer}` } }))).orgs ?? []) as Array<{ orgAgent: string; relationship?: string; stewardshipDelegation?: unknown }>;
const stewardship = links.find((l) => l.orgAgent.toLowerCase() === org && l.relationship === 'steward')?.stewardshipDelegation;
if (!stewardship) fail(`${fx.people.steward} holds no steward link for ${fx.org.handle}`);
const orgOp = async (name: string, body: Record<string, unknown>) => j(await fetch(`${A2A}/interactions/${org}/${name}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: steward.bearer, stewardship, ...body }) }));

const nonce = Date.now().toString(36);
const dmPhrase = `zebra ledger ${nonce}`;
const topicPhrase = `quokka roster ${nonce}`;
console.log(`── search · steward ${fx.people.steward} · member ${fx.people.member} · outsider ${fx.people.outsider} · org ${fx.org.handle} ──`);

// ── 1. a DM carrying the phrase ──
let dm = (await post('/harness/ask', { session: steward.bearer, addressee: steward.agent, message: `send ${fx.people.member} a message: ${dmPhrase}`, plan: { steps: [{ toolId: 'messaging.direct.send', args: { recipient: `${fx.people.member}.me`, message: `about the ${dmPhrase} — see the notes` } }] } })).reply as Reply;
if (dm.kind === 'authority_required') dm = await approve(steward, steward.agent, dm.runRef!, dm);
if (dm.kind !== 'done' && dm.kind !== 'answer') fail(`the message did not go: ${JSON.stringify(dm).slice(0, 300)}`);
const dmId = (dm.result as { messageId?: string } | undefined)?.messageId ?? '';
console.log(`  steward → ${fx.people.member}: "${dmPhrase}" (${dmId || 'id not reported'})`);

// ── 2. the member finds it in their own records — indexed at admission ──
await sleep(2500);
const mine = await search(member, dmPhrase);
const hit = mine.results.find((h) => h.kind === 'message' && h.snippet.includes(dmPhrase));
if (!hit) fail(`the member's search did not find the message: ${JSON.stringify(mine.results.slice(0, 3)).slice(0, 400)}`);
if (hit!.where.why !== 'self' || (dmId && hit!.ref.messageId !== dmId)) fail(`the hit does not cite the member's own record: ${JSON.stringify(hit)}`);
console.log(`  ${fx.people.member} found it: ${hit!.kind} ${hit!.ref.messageId} in ${hit!.ref.conversationId} (self)`);

// ── 3. a topic post carrying a phrase; the steward finds it under her stewardship ──
const list = await orgOp('channels.list', {}) as { channels?: Array<{ descriptor: { id: string; title: string } }> };
const channelId = (list.channels ?? []).find((c) => c.descriptor.title === 'Search gate')?.descriptor.id ?? ((await orgOp('channels.create', { title: 'Search gate', participationPolicy: 'open' })) as { channelId?: string }).channelId;
if (!channelId) fail('could not open the topic');
const posted = await orgOp('channels.post', { channelId, bodyText: `the ${topicPhrase} is due friday` }) as { messageId?: string; error?: string };
if (!posted.messageId) fail(`the steward could not post: ${posted.error}`);
await sleep(1500);
const hers = await search(steward, topicPhrase);
const topicHit = hers.results.find((h) => h.kind === 'topic' && h.snippet.includes(topicPhrase));
if (!topicHit) fail(`the steward's search did not find the topic post: ${JSON.stringify(hers.results.slice(0, 3)).slice(0, 400)}`);
if (topicHit!.where.why !== 'stewardship' || topicHit!.ref.org !== org || topicHit!.ref.channelId !== channelId) fail(`the topic hit is not cited as the org's post: ${JSON.stringify(topicHit)}`);
console.log(`  ${fx.people.steward} found the topic post: ${topicHit!.ref.messageId} in topic ${channelId} of ${fx.org.handle} (stewardship)`);

// ── 4. twins ──
const memberTopic = await search(member, topicPhrase);
if (memberTopic.results.some((h) => h.snippet.includes(topicPhrase))) fail('the member found a post in an organization they do not steward');
const outsiderDm = await search(outsider, dmPhrase);
if (outsiderDm.results.some((h) => h.snippet.includes(dmPhrase))) fail('an outsider found a message that was never theirs');
console.log(`  twins: ${fx.people.member} does not see the org's topic (not a steward); ${fx.people.outsider} does not see the DM`);

// ── 5. a rebuild keeps the sent copy findable ──
const re = await j(await fetch(`${A2A}/interactions/${steward.agent}/search.reindex`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: steward.bearer }) })) as { ok?: boolean; indexed?: number; error?: string };
if (re.ok !== true) fail(`reindex refused: ${re.error}`);
const after = await search(steward, dmPhrase);
if (!after.results.some((h) => h.kind === 'message' && h.snippet.includes(dmPhrase))) fail('after a rebuild the steward no longer finds the message she sent');
console.log(`  rebuilt ${re.indexed} document(s) on ${fx.people.steward}'s object; the sent message is still found`);

console.log(`\n✓ spec 400 W2 (B5) on ${CHAIN_NAME}: search over one's own tier — a DM indexed at admission and found by its recipient (cited by id), a topic post found by the org's steward (cited by org and topic), not by a member or an outsider; a rebuild is a rebuild.`);
