/**
 * Spec 366 R4 — the RECEIVER half of a cross-deployment routed ask, driven live from outside the Worker.
 *
 *   npx tsx scripts/verify-subject-hop-wire.mts
 *
 * This script stands where another Home's harness would: it resolves alice-home-church.impact's card at
 * the host its name projects, takes the card's A2A 1.0 endpoint, and sends ONE `SendMessage` carrying
 * the subject-ask profile under the asker's Home session — first as alice, a steward there, then as bob,
 * who has no standing. The church's own agent answers the first from its roster and refuses the second
 * in its own words; both come back as the task's `subject-answer` artifact, read by the same reader the
 * in-process hop uses. The SENDER half (a Worker choosing this wire for a foreign host) is proved in
 * `apps/agent-runtime/test/unit/subject-hop.test.ts`; live it needs a second deployment.
 */
import type { Address } from 'viem';
import { subjectAsk } from '@agenticprimitives/a2a';
import { sendSubjectAskOverWire } from '@agenticprimitives/a2a';
import { readSubjectReply } from '../apps/agent-runtime/src/harness-run.js';

const HOME = 'https://faithnet.me';
const CHURCH_NAME = 'alice-home-church.impact';
const CHURCH_HOST = 'alice-home-church.faithnet.ai'; // `.impact` is a name PARENT on faithnet (AGENT_NAME_PARENTS), so the host is the label alone
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 300), _status: r.status }; } };
const signin = async (handle: string) => j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle, client_id: 'demo-web' }) }));

const church = await j(await fetch(`https://${CHURCH_HOST}/.well-known/agent-card.json`));
const churchAgent = typeof church?.agentAddress === 'string' ? church.agentAddress.toLowerCase() : null;
console.log(`card ${CHURCH_NAME} at ${CHURCH_HOST}: ${church?.name ?? JSON.stringify(church).slice(0, 120)}  interfaces ${JSON.stringify((church?.supportedInterfaces ?? []).map((i: { url: string; protocolVersion: string }) => `${i.protocolVersion} ${i.url}`))}`);

const hop = async (handle: string) => {
  const s = await signin(handle);
  const asker = String(s.agent).toLowerCase() as Address;
  // WHAT THE ASKER HOLDS, PRESENTED (spec 366 R2): the stewardship wire their OWN links carry for this
  // subject — the same one the in-process sender reads from their tree. The receiver verifies it against
  // the chain; it reads nothing of the asker's. A person with no wire presents nothing.
  const orgs = ((await j(await fetch(`${HOME}/connect/related-orgs?surface=any`, { headers: { authorization: `Bearer ${s.homeSession}` } }))).orgs ?? []) as Array<{ orgAgent: string; stewardshipDelegation?: unknown }>;
  const wire = orgs.find((o) => churchAgent && o.orgAgent.toLowerCase() === churchAgent)?.stewardshipDelegation ?? null;
  console.log(`  ${handle}: presents ${wire ? 'their stewardship wire' : 'nothing'}`);
  // The subject is the church's agent as ITS card names it; the name is enough for the receiver, which
  // resolves `org` in the asker's tier exactly as the in-process hop's receiver does.
  const profile = subjectAsk({
    request: { capability: 'organization.membership.list', args: { org: churchAgent ?? CHURCH_NAME }, goal: `who are the members of ${CHURCH_NAME}` },
    asker: { agent: asker, credential: { kind: 'home-session', token: s.homeSession }, ...(wire ? { presented: [wire] } : {}) },
    correlation: { operationId: `op-${Date.now()}`, runRef: `run-wire-${handle}-${Date.now()}`, stepRef: 's0', intentDigest: `0x${'ab'.repeat(32)}` },
  });
  const out = await sendSubjectAskOverWire({ cardUrl: `https://${CHURCH_HOST}/.well-known/agent-card.json`, profile, session: s.homeSession, fetch: (u, init) => fetch(u, init) });
  if (!out.ok) { console.log(`  ${handle}: hop refused — ${out.refused}`); return { ok: false as const, refused: out.refused }; }
  const read = readSubjectReply(out.envelope as never, 'organization.membership.list', CHURCH_NAME, 200);
  console.log(`  ${handle}: task ${out.task.status.state}  →  ${read.ok ? `answer ${JSON.stringify(read.result).slice(0, 160)}` : `refused: ${read.refused}`}${read.runRef ? `  (receiver run ${read.runRef.slice(0, 18)}…, ${read.receipts?.length ?? 0} receipt(s))` : ''}`);
  return { ok: true as const, state: out.task.status.state, read };
};

console.log('\n── alice, a steward there ──');
const a = await hop('alice');
if (!a.ok || a.state !== 'TASK_STATE_COMPLETED' || !a.read.ok) throw new Error('the church did not answer its steward over the wire');
console.log('\n── bob, no standing ──');
const b = await hop('bob');
if (!b.ok || b.state !== 'TASK_STATE_REJECTED' || b.read.ok) throw new Error('the church did not refuse a stranger over the wire');
if (!/belong|private|standing|refus/i.test(b.read.refused ?? '')) throw new Error('the refusal was not by standing, in the receiver’s words');
console.log(`\n✓ spec 366 R4 (receiver): resolved through the card, one SendMessage carrying the subject-ask profile; the church answered its steward and refused a stranger, both as the task's subject-answer artifact.`);
