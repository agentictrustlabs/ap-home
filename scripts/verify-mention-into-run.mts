/**
 * Spec 400 W2 (B3) — MENTIONS INTO WORK, live (the deterministic stub ACP agent inside the Container; no model).
 *
 *   npx tsx scripts/verify-mention-into-run.mts        (FIXTURE_JSON=… for another estate; roles `containerRuntime`, `org`)
 *
 * The one Buzz feel the harness lacked: `@goose-2` in a topic is a turn PUT TO that member in the thread, not a new Ask.
 *   1. the steward opens a topic on the workspace (or reuses the gate's);
 *   2. a NAMED MEMBER posts "@<member> …" in it — the org's object resolves the handle to the member and ADMITS the post
 *      into the member's inbox on the topic's thread (`/internal/admit-message`); the member's runtime is woken (W1c);
 *   3. the runtime answers IN THE TOPIC as the member (`messaging.topic.post`, under its open mandate — W2a); the gate
 *      reads the topic and finds the member's post carrying the agent's answer to those words;
 *   4. a second mention in the same topic is the same OPEN RUN: the runtime keeps one ACP session per thread, and the
 *      stub's answer counts the turn — N, then N+1 (the session outlives one gate run while the Container is warm);
 *   5. THE TWIN: the same handle mentioned in a topic of an organization the member does NOT belong to admits nothing —
 *      no wake receipt appears for it; a mention of nobody tells nobody.
 */
import { randomBytes } from 'node:crypto';
import type { Address, Hex } from 'viem';
import { buildDigestBindingCaveat, capabilityHandler, hashDelegation, ROOT_AUTHORITY, type Caveat, type Delegation, type MandateRequirementV1 } from '@agenticprimitives/delegation';
import { personaCustodian } from '@agenticprimitives/runtime-member';
import { fixture as fx, HOME, A2A, skipUnless } from './fixture.mts';

const R = skipUnless(fx.containerRuntime, 'runtime member on a Container (containerRuntime: its .svc and workspace)');
const CHAIN_NAME = process.env.CHAIN_NAME ?? 'faithchain';
const C = ((await import(`@agenticprimitives/contracts/deployments/${CHAIN_NAME}`)) as { CONTRACTS: Record<string, string> & { chainId: number } }).CONTRACTS;
const DM = C.delegationManager as Address;
const ENF = { delegationManager: DM, timestamp: C.timestampEnforcer, allowedTargets: C.allowedTargetsEnforcer, allowedMethods: C.allowedMethodsEnforcer, value: C.valueEnforcer, payment: C.paymentEnforcer, digestBinding: C.digestBindingEnforcer };
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 250), _status: r.status }; } };
const fail = (m: string): never => { console.error(`\n✗ ${m}`); process.exit(1); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nameInfo = async (n: string): Promise<Address> => { const r = await j(await fetch(`${HOME}/connect/name-info?name=${encodeURIComponent(n)}`)); if (!r.exists || !r.agent) fail(`${n} does not resolve at ${HOME}`); return String(r.agent).toLowerCase() as Address; };

const steward = await personaCustodian(HOME, fx.people.steward);
const poster = await personaCustodian(HOME, fx.people.member);   // a named member of the workspace who is not its steward
const member = await nameInfo(R.member);
const org = await nameInfo(R.workspace);
const otherOrg = await nameInfo(fx.workspace.handle);   // an org-class agent the steward drives where the member is NOT a member
const label = R.member.split('.')[0]!;
console.log(`── @${label} (${member}) · topic on ${R.workspace} ${org} · poster ${fx.people.member} · steward ${fx.people.steward} ──`);

const links = ((await j(await fetch(`${HOME}/connect/related-orgs?surface=any`, { headers: { authorization: `Bearer ${steward.bearer}` } }))).orgs ?? []) as Array<{ orgAgent: string; relationship?: string; stewardshipDelegation?: unknown }>;
const stewardshipFor = (agent: Address) => links.find((l) => l.orgAgent.toLowerCase() === agent && l.relationship === 'steward')?.stewardshipDelegation;
const memberStewardship = stewardshipFor(member);
if (!memberStewardship) fail(`${fx.people.steward} holds no steward link for ${R.member}`);
const op = async (agent: Address, name: string, body: Record<string, unknown>, who = steward, stewardship?: unknown) => j(await fetch(`${A2A}/interactions/${agent}/${name}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: who.bearer, ...(stewardship ? { stewardship } : {}), ...body }) }));

// ── 1. the topic ──
async function topicOn(orgAgent: Address, title: string): Promise<string> {
  const stewardship = stewardshipFor(orgAgent);
  const list = await op(orgAgent, 'channels.list', {}, steward, stewardship) as { channels?: Array<{ descriptor?: { id?: string; title?: string }; id?: string; title?: string }>; error?: string };
  const have = (list.channels ?? []).find((c) => (c.descriptor?.title ?? c.title) === title);
  const id = have?.descriptor?.id ?? have?.id;
  if (id) return id;
  const made = await op(orgAgent, 'channels.create', { title, participationPolicy: 'open' }, steward, stewardship) as { channelId?: string; error?: string };
  if (!made.channelId) fail(`could not open the topic on ${orgAgent}: ${made.error ?? JSON.stringify(made).slice(0, 200)}`);
  return made.channelId!;
}
const channelId = await topicOn(org, 'Mentions gate');
console.log(`  topic "Mentions gate" ${channelId}`);

// ── 2. a member mentions the runtime ──
const nonce = Date.now().toString(36);
const posted = await op(org, 'channels.post', { channelId, bodyText: `@${label} what is the retreat plan? (${nonce})` }, poster) as { ok?: boolean; messageId?: string; error?: string; code?: string };
if (!posted.messageId) fail(`${fx.people.member} could not post: ${posted.error ?? JSON.stringify(posted).slice(0, 200)}`);
console.log(`  ${fx.people.member} posted @${label} (${posted.messageId})`);
const sentAt = Date.now();

// ── 3. the member answers in the topic ──
type Post = { id: string; from: string; actor?: string; authorName?: string; bodyText?: string; createdAt: string };
/** The topic's posts with their bodies (`channels.read` returns the envelopes and, batched, the bodies by id). */
async function topicPosts(): Promise<Post[]> {
  const r = await op(org, 'channels.read', { channelId }, steward, stewardshipFor(org)) as { channels?: Array<{ descriptor: { id: string }; messages?: Array<{ envelope: { id: string; from: string; actor?: string; createdAt: string }; authorName?: string }> }>; bodies?: Record<string, string> };
  const ch = (r.channels ?? []).find((c) => c.descriptor.id === channelId);
  return (ch?.messages ?? []).map((m) => ({ id: m.envelope.id, from: m.envelope.from, ...(m.envelope.actor ? { actor: m.envelope.actor } : {}), ...(m.authorName ? { authorName: m.authorName } : {}), createdAt: m.envelope.createdAt, bodyText: r.bodies?.[m.envelope.id] ?? '' }));
}
const addrOf = (caip: string | undefined) => (String(caip ?? '').match(/0x[0-9a-fA-F]{40}$/)?.[0] ?? '').toLowerCase();
let reply: Post | undefined;
for (let i = 0; i < 40 && !reply; i++) {
  await sleep(3000);
  reply = (await topicPosts()).find((p) => addrOf(p.from) === member && (p.bodyText ?? '').includes(nonce));
  if (!reply && i % 5 === 4) console.log(`  … no reply in the topic yet (${(Date.now() - sentAt) / 1000 | 0}s)`);
}
if (!reply) fail(`no post by ${R.member} carrying the mention's words appeared in the topic within two minutes`);
console.log(`  ${R.member} answered in the topic ${((Date.parse(reply!.createdAt) - sentAt) / 1000).toFixed(1)}s after the mention: "${(reply!.bodyText ?? '').slice(0, 90)}…"`);
// The stub counts its turns PER SESSION, and the runtime keeps one session per thread for as long as it is warm —
// so the first reply may already be turn N of this topic (an earlier run of this gate). Continuity is N → N+1.
const turnOf = (t: string | undefined) => Number(/turn (\d+)\b/.exec(t ?? '')?.[1] ?? NaN);
const n1 = turnOf(reply!.bodyText);
if (!Number.isFinite(n1)) fail(`the reply does not count its turn: ${reply!.bodyText}`);
if (!/local tool refused/.test(reply!.bodyText ?? '')) fail('the host allowed the agent\'s local shell');

// ── 4. a second mention is the same open run (one session per thread — turn 2) ──
const nonce2 = `${nonce}-b`;
const posted2 = await op(org, 'channels.post', { channelId, bodyText: `@${label} and who is bringing the food? (${nonce2})` }, poster) as { messageId?: string; error?: string };
if (!posted2.messageId) fail(`second post did not go: ${posted2.error}`);
let reply2: Post | undefined;
for (let i = 0; i < 30 && !reply2; i++) { await sleep(3000); reply2 = (await topicPosts()).find((p) => addrOf(p.from) === member && (p.bodyText ?? '').includes(nonce2)); }
if (!reply2) fail('the second mention was not answered in the topic');
console.log(`  second mention → "${(reply2!.bodyText ?? '').slice(0, 90)}…"`);
if (turnOf(reply2!.bodyText) !== n1 + 1) fail(`the second mention did not continue the same run on this thread (expected turn ${n1 + 1}): ${reply2!.bodyText}`);

// ── 5. twin: the same handle in a topic of an organization the member does not belong to ──
const twinChannel = await topicOn(otherOrg, 'Mentions gate (twin)');
const wakesBefore = ((await op(member, 'runtime.wake.get', { limit: 10 }, steward, memberStewardship)) as { wakes?: Array<{ messageId: string }> }).wakes ?? [];
const twinPost = await op(otherOrg, 'channels.post', { channelId: twinChannel, bodyText: `@${label} are you here? (${nonce}-twin)` }, steward, stewardshipFor(otherOrg)) as { messageId?: string; error?: string; code?: string };
if (!twinPost.messageId) fail(`the twin's post did not go on ${fx.workspace.handle}: ${twinPost.error ?? twinPost.code}`);
console.log(`  twin posted @${label} on ${fx.workspace.handle} (${twinPost.messageId})`);
await sleep(20_000);
const wakesAfter = ((await op(member, 'runtime.wake.get', { limit: 10 }, steward, memberStewardship)) as { wakes?: Array<{ messageId: string }> }).wakes ?? [];
const newWakes = wakesAfter.filter((w) => !wakesBefore.some((b) => b.messageId === w.messageId));
if (newWakes.length) fail(`a mention in ${fx.workspace.handle}, where ${R.member} is not a member, woke it: ${JSON.stringify(newWakes).slice(0, 200)}`);
console.log(`  twin: @${label} in a topic of ${fx.workspace.handle} (not a member there) → nothing admitted, nothing woken (20s)`);

console.log(`\n✓ spec 400 W2 (B3) on ${CHAIN_NAME}: @${label} in a topic reached ${R.member} on the topic's thread, it answered IN the topic as itself under its open mandate, a second mention continued the same run (turn ${n1} → ${n1 + 1}), and a mention where it is not a member told nobody.`);
void randomBytes; void buildDigestBindingCaveat; void capabilityHandler; void hashDelegation; void ROOT_AUTHORITY; void ENF;
