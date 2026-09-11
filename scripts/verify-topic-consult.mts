/**
 * Spec 380 W3 — THE ROUTED TOPIC TURN AS ONE HARNESS RUN, live.
 *
 *   npx tsx scripts/verify-topic-consult.mts
 *
 * alice, a steward of Missio Nexus, mentions the organization's assistant in a topic where routing is on
 * (the org's consult wire and bob's + carol's opt-ins come from `verify-fan-out-consult.mts`). The
 * organization's Durable Object ranks the eligible members and runs ONE harness run at the organization —
 * one `organization.member.consult` step per chosen member — and posts the composer's reply ONCE, with the
 * routed-consultation contextRef: who was consulted, what each member's agent said, who did not answer.
 * No status post, no second synthesis post: exactly one reply from the organization after the mention.
 */
const HOME = 'https://www.faithnet.me';
const ORG = '0x3b99f2b452766de5df0dbcdfc676f27257151333'; // missio-nexus.org
const TITLE = 'Consult gate (spec 380 W3)';
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 250), _status: r.status }; } };
const alice = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: 'alice', client_id: 'demo-web' }) }));
if (!alice.homeSession) throw new Error('no session');
const H = { 'content-type': 'application/json', authorization: `Bearer ${alice.homeSession}` };
const act = async (body: Record<string, unknown>) => j(await fetch(`${HOME}/connect/channels`, { method: 'POST', headers: H, body: JSON.stringify({ communityId: ORG, ...body }) }));
type Msg = { envelope: { id: string; contextRefs?: Array<{ kind: string }>; createdAt?: string }; authorName?: string; actor?: string; bodyText?: string };
type Channel = { descriptor: { id: string; title: string }; assistant?: { mentionHandle?: string; displayName?: string; trigger?: string }; routing?: { enabled?: boolean; maxFanout?: number } | null; messages?: Msg[] };
const list = async (): Promise<Channel[]> => ((await j(await fetch(`${HOME}/connect/channels?communityId=${ORG}`, { headers: H }))).channels ?? []) as Channel[];
// The read returns every channel plus a `bodies` map (message id → text): pick OUR channel and join its bodies.
const read = async (channelId: string): Promise<Channel | null> => {
  const r = await j(await fetch(`${HOME}/connect/channels?communityId=${ORG}&channelId=${channelId}`, { headers: H }));
  const ch = ((r.channels ?? []) as Channel[]).find((c) => c.descriptor.id === channelId) ?? null;
  if (ch) ch.messages = (ch.messages ?? []).map((m) => ({ ...m, bodyText: m.bodyText ?? (r.bodies ?? {})[m.envelope.id] }));
  return ch;
};
const fail = (m: string): never => { console.error(`\n✗ ${m}`); process.exit(1); };

// ── setup: bob and carol are CONSULTABLE in the organization's directory ──────────────────────────────
// Since 380 W3 the GRANT alone makes a member consultable (`verify-fan-out-consult.mts` issued bob's and
// carol's); a directory listing adds their name and org role to the ranking. Best-effort, idempotent: a member
// the organization has not admitted to its directory is still asked, by address.
import { canonicalizeMessage, sha256Hex32 } from '@agenticprimitives/fabric/messaging';
const listed = ((await j(await fetch(`${HOME}/connect/directory?communityId=${ORG}`, { headers: H }))).listings ?? []) as Array<{ listing: { subject: string; consultable?: boolean } }>;
for (const [handle, displayName] of [['bob', 'Bob Tanaka'], ['carol', 'Carol Mbeki']] as const) {
  const s = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle, client_id: 'demo-web' }) }));
  const me = String(s.agent).toLowerCase();
  if (listed.some((l) => l.listing.subject.toLowerCase().endsWith(me) && l.listing.consultable === true)) { console.log(`setup: ${handle} is listed as consultable`); continue; }
  const now = Date.now();
  const draft = { type: 'ap.home.directory-listing.v1', subject: `eip155:34348:${me}`, context: { kind: 'community', id: ORG, label: 'Missio Nexus' }, displayName, roles: [], consultable: true, visibility: 'community', publishedAt: new Date(now).toISOString(), expiresAt: new Date(now + 180 * 86_400_000).toISOString() };
  const digest = await sha256Hex32(canonicalizeMessage(draft as never));
  const sig = await j(await fetch(`${HOME}/connect/persona-sign`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${s.homeSession}` }, body: JSON.stringify({ digest }) }));
  if (!sig.signature) fail(`${handle} could not sign the listing: ${JSON.stringify(sig).slice(0, 160)}`);
  const pub = await j(await fetch(`${HOME}/connect/directory`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${s.homeSession}` }, body: JSON.stringify({ action: 'publish', listing: { ...draft, proof: { signer: `eip155:34348:${me}`, scheme: 'erc1271', signature: sig.signature } } }) }));
  if (pub.ok !== true && !pub.listing) { console.log(`setup: ${handle}'s listing was not published (${String(pub.error ?? '').slice(0, 120)}) — the grant alone makes them consultable (380 W3)`); continue; }
  console.log(`setup: ${handle} published a consultable listing in the organization's directory`);
}

let topic = (await list()).find((c) => c.descriptor.title === TITLE);
if (!topic) {
  const c = await act({ action: 'create', title: TITLE, participationPolicy: 'open' });
  if (!c.ok && !c.channelId && !c.channel) fail(`could not create the topic: ${JSON.stringify(c).slice(0, 200)}`);
  topic = (await list()).find((x) => x.descriptor.title === TITLE) ?? fail('the topic did not appear');
}
const channelId = topic!.descriptor.id;
if (!topic!.assistant) { const a = await act({ action: 'assistantEnable', channelId, trigger: 'mention', displayName: 'Missio Nexus' }); if (a.ok !== true) fail(`assistantEnable: ${JSON.stringify(a).slice(0, 200)}`); }
const r = await act({ action: 'routingEnable', channelId, maxFanout: 3 });
if (r.ok !== true) fail(`routingEnable: ${JSON.stringify(r).slice(0, 200)} — run verify-fan-out-consult.mts first (the org's consult wire)`);
topic = (await list()).find((c) => c.descriptor.id === channelId)!;
const handle = topic.assistant?.mentionHandle ?? 'missio-nexus';
console.log(`topic "${TITLE}" ${channelId} · assistant @${handle} (${topic.assistant?.trigger}) · routing ${JSON.stringify(topic.routing)}`);

const before = (await read(channelId))?.messages?.length ?? 0;
const nonce = Date.now().toString(36);
const question = `@${handle} are you available this saturday for the food drive? (gate ${nonce})`;
const posted = await act({ action: 'post', channelId, bodyText: question });
if (posted.ok !== true && !posted.messageId) fail(`post: ${JSON.stringify(posted).slice(0, 200)}`);
console.log(`alice posted: "${question}"`);

// ONE reply from the organization, carrying the routed-consultation contextRef.
const t0 = Date.now();
let orgPosts: Msg[] = [];
for (let i = 0; i < 40; i++) {
  await new Promise((res) => setTimeout(res, 5000));
  const ch = await read(channelId);
  const msgs = (ch?.messages ?? []).slice(before);
  orgPosts = msgs.filter((m) => (m.actor ?? '').toLowerCase() === ORG || m.authorName === (topic!.assistant?.displayName ?? 'Missio Nexus'));
  if (orgPosts.length > 0 && Date.now() - t0 > 20_000) break; // give a stray second post time to show up
}
console.log(`\n── the organization's post(s) after ${((Date.now() - t0) / 1000).toFixed(0)}s ──`);
for (const m of orgPosts) console.log(`  [${(m.envelope.contextRefs ?? []).map((c) => c.kind).join(',') || 'no contextRef'}] ${(m.bodyText ?? '').slice(0, 600)}`);
if (orgPosts.length === 0) fail('the organization did not reply to the mention');
if (orgPosts.length !== 1) fail(`expected exactly ONE reply (the harness run's), got ${orgPosts.length}`);
const reply = orgPosts[0]!;
if (!(reply.envelope.contextRefs ?? []).some((c) => c.kind === 'routed-consultation')) fail('the reply carries no routed-consultation contextRef');
const body = reply.bodyText ?? '';
const named = ['bob', 'carol'].filter((n) => new RegExp(n, 'i').test(body));
if (named.length < 1) fail('the reply names none of the consulted members');
console.log(`\n✓ spec 380 W3: one reply from the organization, composed from its members' agents' words (${named.join(', ')} named), with the routed-consultation contextRef — no status post, no second synthesis turn.`);
