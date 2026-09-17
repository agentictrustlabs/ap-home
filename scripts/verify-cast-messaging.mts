/**
 * A CHARACTER'S OWN VOICE IN ANOTHER CHARACTER'S INBOX — the rail a played night needs, proven for one pair.
 *
 *   npx tsx scripts/verify-cast-messaging.mts [--note demo/commission-cast.faithnet.json] [--from returnee --to household]
 *
 * Reads the note `equip-cast-messaging.mts` wrote and does exactly what Game Night's `cast-messaging.ts` does — as the
 * character, on its ask wire: ask the character's own agent to send, with the plan supplied; when the run parks
 * AUTH_REQUIRED, derive the mandate from the standing grant and continue the same task presenting [child, standing];
 * then read BOTH inboxes at their custodians' Homes and find the one conversation the message made.
 *
 * WHAT WAS TRIED FIRST, AND WHY NOT. `messaging.deliver` at the recipient's own subdomain, signed with the cast wires
 * `mint-cast-wires.mts` minted: refused `gateway_assertion_required` — that door is behind the estate's edge secret,
 * which the card room does not hold and must not. And the standard surface asked AS THE HOUSE: "a direct message is
 * sent as you, and there is no signed-in person on this run". The run has to be the character's own (spec 400 W2a).
 *
 * The session key is read from ~/pokernight/.house-a2a-session.json (0600); nothing is minted here.
 */
import { readFileSync } from 'node:fs';
import type { Address, Hex } from 'viem';
import { privateKeyToAccount, sign } from 'viem/accounts';
import { deriveForNeed, parkedNeedOf, type StandingGrantV1 } from '../packages/runtime-member/src/standing.js';
import { askAs, continueAs } from '../packages/runtime-member/src/client.js';
import type { RuntimeMemberRecordV1 } from '../packages/runtime-member/src/record.js';

const HOME = process.env.HOME_URL ?? 'https://www.faithnet.me';
const A2A = process.env.A2A_URL ?? 'https://a2a.faithnet.io';
const argv = process.argv.slice(2);
const arg = (n: string, d?: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1]! : d; };
const NOTE = arg('note', 'demo/commission-cast.faithnet.json')!;
const EQUIPPED = arg('equipped', NOTE.replace('.faithnet.json', '-messaging.faithnet.json'))!;
const FROM = arg('from', 'returnee')!, TO = arg('to', 'household')!;
const SESSION_KEY_FILE = process.env.HOUSE_SESSION_KEY_FILE ?? `${process.env.HOME}/pokernight/.house-a2a-session.json`;
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 300), _status: r.status }; } };

type Part = { name: string; sa: string; custodian: string; character: string; role: string };
const cast: Part[] = JSON.parse(readFileSync(NOTE, 'utf8')).cast ?? [];
const eq = JSON.parse(readFileSync(EQUIPPED, 'utf8')) as { sessionKey: Address; chainId: number; edge: string; parts: Record<string, { sa: Address; wire: Record<string, unknown>; standing: StandingGrantV1 }> };
const me = cast.find((p) => p.role === FROM)!, you = cast.find((p) => p.role === TO)!;
if (!me || !you || !eq.parts[me.name]) throw new Error(`need equipped parts for --from ${FROM} and --to ${TO}`);
const key = (JSON.parse(readFileSync(SESSION_KEY_FILE, 'utf8')) as { privateKey: Hex }).privateKey;
if (privateKeyToAccount(key).address.toLowerCase() !== eq.sessionKey.toLowerCase()) throw new Error('the local session key is not the one the note was minted for');
const part = eq.parts[me.name]!;
const rec: RuntimeMemberRecordV1 = { v: 1, name: me.name, agent: part.sa, workspace: { name: '-', agent: '0x0000000000000000000000000000000000000000' }, key, address: eq.sessionKey, wire: part.wire, wireRef: '0x', validUntil: 0, edge: eq.edge, audience: eq.edge, a2a: A2A, chainId: eq.chainId, home: HOME, joinedAt: '', standing: part.standing };

const words = `${me.character} here, for you alone, ${you.character}: what I carry does not travel past this room. (${new Date().toISOString().slice(11, 16)})`;
const plan = { steps: [{ toolId: 'messaging.direct.send', args: { recipient: you.sa.toLowerCase(), message: words } }] };
console.log(`${me.character} → ${you.character}, as ${me.name}'s own runtime`);
const first = await askAs(rec, me.name, `Whisper to ${you.character}: ${words}`, { plan, timeoutMs: 90_000 });
console.log(`  ask      → ${first.state}${first.parked ? '' : ` · ${first.text.slice(0, 160)}`}`);
if (first.state !== 'TASK_STATE_COMPLETED') {
  if (!first.parked || !first.taskId) process.exit(1);
  const need = parkedNeedOf(first.data); if (!need) { console.log('  parked without a need:', JSON.stringify(first.data).slice(0, 300)); process.exit(1); }
  const derived = await deriveForNeed(part.standing, need, part.sa, (h) => sign({ hash: h, privateKey: key, to: 'hex' }));
  if (!derived.ok) { console.log(`  ✗ derive: ${derived.reason}`); process.exit(1); }
  console.log(`  derived  → child ${derived.childRef.slice(0, 14)}… of standing ${part.standing.ref.slice(0, 14)}…`);
  const second = await continueAs(rec, me.name, first.taskId, derived.presented, { timeoutMs: 90_000 });
  console.log(`  continue → ${second.state} · ${second.text.slice(0, 120)}`);
  if (second.state !== 'TASK_STATE_COMPLETED') process.exit(1);
}

// both inboxes, as the custodians
for (const p of [you, me]) {
  const si = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: p.custodian, client_id: 'demo-web' }) }));
  const links = await j(await fetch(`${HOME}/connect/related-orgs`, { headers: { authorization: `Bearer ${si.homeSession}` } }));
  const stewardship = (links.orgs as Array<Record<string, unknown>> | undefined)?.find((o) => String(o.orgAgent).toLowerCase() === p.sa.toLowerCase())?.stewardshipDelegation;
  const box = await j(await fetch(`${A2A}/interactions/${p.sa.toLowerCase()}/inbox.get`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: si.homeSession, ...(stewardship ? { stewardship } : {}) }) }));
  const envs = (box.doc?.envelopes ?? []) as Array<{ from: string; to: string[]; createdAt: string; conversationId: string }>;
  const mine = envs.filter((e) => e.from.toLowerCase().endsWith(me.sa.toLowerCase()) && e.to.some((t) => t.toLowerCase().endsWith(you.sa.toLowerCase())));
  const last = mine[mine.length - 1];
  console.log(`  ${p.character.padEnd(16)} inbox (${p.custodian}'s Home): ${envs.length} envelope(s), ${mine.length} from ${me.character} → ${you.character}${last ? ` · latest ${last.createdAt} in ${last.conversationId.slice(0, 20)}…` : ''}`);
  if (!mine.length) process.exit(1);
}
console.log('\n✓ one conversation, both sides');
