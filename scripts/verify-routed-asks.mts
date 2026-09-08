/**
 * Spec 366 R2 — routed asks, one per subject type, and the twin that is refused by standing.
 *
 *   npx tsx scripts/verify-routed-asks.mts
 *
 * A step whose SUBJECT is another agent is sent to that agent's own harness (spec 366 R1); the receiver
 * derives the asker's standing against ITS OWN records and, since R2, against the stewardship wire the
 * asker PRESENTED — it no longer reads the asker's tree (R3). Three subject types route: an organization,
 * a team (org-class), and a treasury. The twin: a person with no standing at the subject is refused by
 * the receiver, in the receiver's words, never answered from a local read.
 */
import type { Address } from 'viem';

const HOME = 'https://faithnet.me';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/128 Safari/537.36';
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 300), _status: r.status }; } };

interface Session { token: string; agent: Address; handle: string; csrf: string; cookie: string; host: string }
async function open(handle: string): Promise<Session> {
  const si = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle, client_id: 'demo-web' }) }));
  const host = `https://${handle}.faithnet.ai`;
  const cr = await fetch(`${host}/auth/csrf`, { headers: { origin: HOME, 'user-agent': UA } });
  const csrf = cr.headers.get('x-csrf-token') || ((await j(cr)) as { token?: string }).token || '';
  const cookie = (cr.headers.get('set-cookie') || '').split(';')[0] ?? '';
  return { token: si.homeSession, agent: String(si.agent).toLowerCase() as Address, handle, csrf, cookie, host };
}
interface Reply { kind?: string; text?: string; error?: string; results?: Array<{ toolId: string; result: unknown }>; prompt?: { prompt?: string }; plannerTrace?: { plan?: unknown[] }; routed?: Array<{ stepRef: string; toolId: string; agent: string; name?: string; observedVia: string; runRef?: string; receipts?: number }> }
async function ask(s: Session, message: string): Promise<Reply> {
  const r = await j(await fetch(`${s.host}/harness/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: HOME, cookie: s.cookie, 'x-csrf-token': s.csrf, 'user-agent': UA },
    body: JSON.stringify({ session: s.token, addressee: s.agent, message }),
  }));
  return (r.reply ?? { kind: 'envelope-error', error: r.error }) as Reply;
}
/** The hop, as the reply records it (spec 366 `routed`). */
const viaOf = (r: Reply) => { const v = (r.routed ?? [])[0]; return v ? { ...v, receipts: v.receipts ? new Array(v.receipts) : [] } : null; };
const show = (label: string, r: Reply) => {
  const via = viaOf(r);
  console.log(`  ${label.padEnd(44)} ${r.kind}${via ? `  via ${via.name ?? via.agent} (${via.observedVia}${via.runRef ? `, run ${via.runRef.slice(0, 18)}…` : ''}${via.receipts?.length ? `, ${via.receipts.length} receipt(s)` : ''})` : ''}`);
  console.log(`    ${JSON.stringify(r.text ?? r.error ?? r.prompt?.prompt ?? '').slice(0, 200)}`);
  return via;
};

const alice = await open('alice');
const bob = await open('bob');
const related = async (s: Session) => ((await j(await fetch(`${HOME}/connect/related-orgs?surface=any`, { headers: { authorization: `Bearer ${s.token}` } }))).orgs ?? []) as Array<{ orgAgent: string; orgName: string; kind?: string; relationship?: string }>;
const aliceOrgs = await related(alice);
const bobOrgs = await related(bob);
const bobHas = new Set(bobOrgs.map((o) => o.orgAgent.toLowerCase()));
const team = aliceOrgs.find((o) => (o.kind ?? '') === 'team' && o.relationship === 'steward');
const org = aliceOrgs.find((o) => (o.kind ?? 'org') === 'org' && o.relationship === 'steward' && /missio/i.test(o.orgName)) ?? aliceOrgs.find((o) => (o.kind ?? 'org') === 'org' && o.relationship === 'steward');
const strangerOrg = aliceOrgs.find((o) => o.relationship === 'steward' && !bobHas.has(o.orgAgent.toLowerCase()) && (o.kind ?? 'org') === 'org');
console.log(`alice ${alice.agent}  org ${org?.orgName}  team ${team?.orgName}  · bob ${bob.agent} has no link to ${strangerOrg?.orgName}`);
if (!org || !team || !strangerOrg) throw new Error('the estate lacks a subject of each kind for this gate');

console.log('\n── routed reads, one per subject type ──');
const r1 = await ask(alice, `who are the members of ${org.orgName}`);
const v1 = show(`organization: members of ${org.orgName}`, r1);
if (r1.kind !== 'answer' || !v1) throw new Error('the organization subject did not route to its own agent');

const r2 = await ask(alice, `what endeavors does ${team.orgName} have`);
const v2 = show(`team: endeavors of ${team.orgName}`, r2);
if (r2.kind !== 'answer' || !v2) throw new Error('the team subject did not route to its own agent');

const r3 = await ask(alice, 'what is the balance of alice3.treasury');
const v3 = show('treasury: balance of alice3.treasury', r3);
if (r3.kind !== 'answer' || !v3) throw new Error('the treasury subject did not route to its own agent');
if (/alice2\.treasury/.test(r3.text ?? '')) throw new Error('a routed treasury read answered with another treasury beside it');

console.log('\n── the twin: no standing at the subject ⇒ refused by the receiver ──');
const r4 = await ask(bob, `who are the members of ${strangerOrg.orgName}`);
const v4 = show(`bob asks about ${strangerOrg.orgName}`, r4);
const refusedText = `${r4.text ?? ''} ${r4.error ?? ''}`;
if (r4.kind === 'answer' && /member/i.test(refusedText) && !/refus|no standing|not a member|cannot|private|only someone who belongs/i.test(refusedText)) throw new Error('bob was answered a roster he has no standing to read');
// R3: the refusal is the RECEIVER's — the ask routed, and the words come from the subject's own agent.
// Before the typed-name fix, bob's planner dropped the name and his own harness narrated his empty
// roster as the church's; a refusal that never left bob's agent would hide that shape again.
if (!v4) throw new Error('the stranger’s ask did not route — the refusal must be the subject agent’s own, never a local read or a local guess');
if (!/private|only someone who belongs|no standing|refus/i.test(refusedText)) throw new Error('the receiver did not refuse by standing');

console.log(`\n✓ spec 366 R2+R3: an organization, a team and a treasury each answered by their own agent under the asker's presented standing; a stranger's ask routed and was refused BY THE SUBJECT'S AGENT, never read locally.`);
