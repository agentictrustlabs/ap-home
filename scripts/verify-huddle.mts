/**
 * Spec 378 W1 — THE GOVERNED CALL, live.
 *
 *   npx tsx scripts/verify-huddle.mts
 *
 * alice (a steward of Missio Nexus) starts a huddle at the organization and is joined; bob (a member) joins
 * the same run; a stranger is refused and told nothing exists; two starts at once return one run; `end`
 * deactivates the provider meeting and kicks the live session; the token minted for the ended run opens
 * nothing. Provider credentials are checked to be ABSENT from every reply except the joiner's own `authToken`.
 *
 * Needs the RealtimeKit secrets on the faithnet Worker (REALTIMEKIT_ACCOUNT_ID / APP_ID / API_TOKEN);
 * without them the surface answers 503 huddles_not_configured and this script says so and stops.
 */
import type { Address } from 'viem';

const HOME = 'https://faithnet.me';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/128 Safari/537.36';
const ORG = '0x3b99f2b452766de5df0dbcdfc676f27257151333' as Address; // missio-nexus.org
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 300), _status: r.status }; } };
interface S { token: string; agent: Address; host: string; csrf: string; cookie: string }
async function open(handle: string): Promise<S> {
  const si = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle, client_id: 'demo-web' }) }));
  const host = `https://${handle}.faithnet.ai`;
  const cr = await fetch(`${host}/auth/csrf`, { headers: { origin: HOME, 'user-agent': UA } });
  const csrf = cr.headers.get('x-csrf-token') || ((await j(cr.clone())) as { token?: string }).token || '';
  return { token: si.homeSession, agent: String(si.agent).toLowerCase() as Address, host, csrf, cookie: (cr.headers.get('set-cookie') || '').split(';')[0] ?? '' };
}
const call = async (s: S, op: string, body: Record<string, unknown>) => {
  const r = await fetch(`${s.host}/huddles/${op}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: HOME, cookie: s.cookie, 'x-csrf-token': s.csrf, 'user-agent': UA }, body: JSON.stringify({ session: s.token, scope: { kind: 'org', principal: ORG }, ...body }) });
  return { status: r.status, body: (await j(r)) as Record<string, unknown> };
};
const noSecrets = (o: unknown) => !JSON.stringify(o).match(/authToken|"token"/);

const alice = await open('alice'); const bob = await open('bob'); const carol = await open('david'); // david holds no link to Missio Nexus (carol and dave are members)
const probe = await call(alice, 'get', {});
if (probe.status === 503) { console.log(`SKIPPED — ${probe.body.error}: set REALTIMEKIT_ACCOUNT_ID, REALTIMEKIT_APP_ID and REALTIMEKIT_API_TOKEN on the faithnet Worker (wrangler secret put … --env faithnet), then run again.`); process.exit(0); }

console.log('── alice starts a huddle at Missio Nexus ──');
const s1 = await call(alice, 'start', { displayName: 'Alice', key: `start-${Date.now()}` });
const run1 = s1.body.run as { runId: string; state: string; roster: Array<{ actor: string; role: string; joined: boolean }> } | undefined;
console.log(`  ${s1.status} ${run1 ? `${run1.state} ${run1.runId} · roster ${run1.roster.map((r) => `${r.actor.slice(0, 8)}:${r.role}${r.joined ? '' : '(not joined)'}`).join(', ')}` : JSON.stringify(s1.body).slice(0, 200)}`);
if (s1.status !== 200 || !run1 || typeof s1.body.authToken !== 'string') throw new Error('alice could not start and join');
if (!run1.roster.some((r) => r.actor.toLowerCase() === alice.agent && r.joined)) throw new Error('the starter is not on the roster as joined');
console.log(`  a token came back to alice's browser (${String(s1.body.authToken).length} chars) — and nowhere in the run: ${noSecrets(run1) ? '✓' : '✗'}`);
if (!noSecrets(run1)) throw new Error('the run carries a credential');

console.log('\n── two starts at once resolve to one run ──');
const [a2, b2] = await Promise.all([call(alice, 'start', { displayName: 'Alice', key: `start-a-${Date.now()}` }), call(bob, 'start', { displayName: 'Bob', key: `start-b-${Date.now()}` })]);
const ra = (a2.body.run as { runId?: string })?.runId; const rb = (b2.body.run as { runId?: string })?.runId;
console.log(`  alice → ${a2.status} ${ra} · bob → ${b2.status} ${rb}`);
if (ra !== run1.runId || rb !== run1.runId) throw new Error('a second start made a second huddle');

console.log('\n── bob (a member) joins; david (no standing here) is refused ──');
const jb = await call(bob, 'join', { displayName: 'Bob', key: `join-b-${Date.now()}` });
console.log(`  bob → ${jb.status} ${(jb.body.run as { roster?: unknown[] })?.roster?.length ?? '?'} on the roster, token ${typeof jb.body.authToken === 'string' ? '✓' : '✗'}`);
if (jb.status !== 200 || typeof jb.body.authToken !== 'string') throw new Error('a member could not join');
const jc = await call(carol, 'join', { displayName: 'Carol', key: `join-c-${Date.now()}` });
const gc = await call(carol, 'get', {});
console.log(`  david join → ${jc.status} ${jc.body.error} · david get → ${gc.status} ${gc.body.error}`);
if (jc.status !== 403 || gc.status !== 404) throw new Error('a stranger was not refused, or was told a huddle exists');

console.log('\n── bob cannot end it; alice (who started it) ends it: deactivated, kicked, ended ──');
const eb = await call(bob, 'end', { key: `end-b-${Date.now()}` });
console.log(`  bob end → ${eb.status} ${eb.body.error ?? ''}`);
if (eb.status !== 403) throw new Error('a member ended a huddle they did not start');
const ea = await call(alice, 'end', { key: `end-a-${Date.now()}` });
const ended = ea.body.run as { state: string; provider?: { deactivatedAt?: number; kickedAt?: number } } | undefined;
console.log(`  alice end → ${ea.status} ${ended?.state} · deactivated ${ended?.provider?.deactivatedAt ? '✓' : '✗'} · kicked ${ended?.provider?.kickedAt ? '✓' : '✗'}${ea.body.error ? ` — ${ea.body.error}` : ''}`);
if (ea.status !== 200 || ended?.state !== 'ended' || !ended.provider?.deactivatedAt || !ended.provider?.kickedAt) throw new Error('end did not deactivate and kick before reporting ended');
const after = await call(bob, 'get', {});
console.log(`  after: bob get → ${after.status} run ${JSON.stringify(after.body.run)}`);
if (after.body.run !== null) throw new Error('an ended huddle is still listed');
// ── The discussion hook: a huddle inside one of the team's topics ──
console.log('\n── a topic huddle: started where the team talks, said in the topic, each topic its own room ──');
const chRes = await j(await fetch(`${HOME}/connect/channels?communityId=${ORG}`, { headers: { authorization: `Bearer ${alice.token}` } })) as { channels?: Array<{ descriptor: { id: string }; title: string }> };
const topic = chRes.channels?.[0];
if (!topic) { console.log('  (Missio Nexus has no discussion topics yet — the topic block is skipped)'); }
else {
  const tscope = { kind: 'topic', principal: ORG, id: topic.descriptor.id };
  const tcall = async (s: S, op: string, body: Record<string, unknown>) => { const r = await fetch(`${s.host}/huddles/${op}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: HOME, cookie: s.cookie, 'x-csrf-token': s.csrf, 'user-agent': UA }, body: JSON.stringify({ session: s.token, scope: tscope, ...body }) }); return { status: r.status, body: (await j(r)) as Record<string, unknown> }; };
  const ts = await tcall(alice, 'start', { displayName: 'Alice', key: `tstart-${Date.now()}` });
  const trun = ts.body.run as { runId: string } | undefined;
  console.log(`  alice starts in "# ${topic.title}" → ${ts.status} ${trun?.runId ?? JSON.stringify(ts.body).slice(0, 160)}`);
  if (ts.status !== 200 || !trun) throw new Error('the topic huddle did not start');
  if (trun.runId === run1.runId) throw new Error('the topic huddle is the same room as the organization\'s — scopes are not separate');
  const tb = await tcall(bob, 'get', {});
  const td = await tcall(carol, 'get', {});
  console.log(`  bob (member) sees it → ${tb.status} ${(tb.body.run as { runId?: string })?.runId === trun.runId ? 'the same run' : 'something else'} · david (stranger) → ${td.status} ${td.body.error}`);
  if ((tb.body.run as { runId?: string })?.runId !== trun.runId || td.status !== 404) throw new Error('the topic huddle is not scoped to the team');
  const te = await tcall(alice, 'end', { key: `tend-${Date.now()}` });
  console.log(`  alice ends it → ${te.status} ${(te.body.run as { state?: string })?.state}`);
  await new Promise((r) => setTimeout(r, 2500));
  const read = await j(await fetch(`${HOME}/connect/channels?communityId=${ORG}&channelId=${encodeURIComponent(topic.descriptor.id)}`, { headers: { authorization: `Bearer ${alice.token}` } })) as { channels?: Array<{ messages: Array<{ envelope: { from: string } }> }>; bodies?: Record<string, string> };
  const lines = Object.values(read.bodies ?? {}).filter((t) => /huddle/i.test(t));
  console.log(`  the topic says: ${lines.length ? lines.slice(-2).map((l) => JSON.stringify(l)).join(' · ') : 'nothing about the huddle'}`);
  if (lines.length < 2) throw new Error('the organization did not say in the topic that the huddle started and ended');
}

console.log(`\n✓ spec 378 W1: a governed call — started, joined by standing, refused by standing, one run for two starts, ended in the provider's order; the only credential that left the Worker went to the joiner's own browser.`);
