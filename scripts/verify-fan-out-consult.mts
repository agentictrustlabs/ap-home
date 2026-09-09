/**
 * Spec 380 W1 — FAN-OUT CONSULT, live.
 *
 *   npx tsx scripts/verify-fan-out-consult.mts
 *
 * Setup (idempotent, the product's own ceremonies): alice, a steward of Missio Nexus, enables member
 * routing (mints the org's consult wire); bob and carol opt in to being consulted by Missio Nexus (each
 * signs their own consultability delegation); dave does not. Then alice asks her agent to ask each
 * member whether they are available on Saturday. Her agent routes the roster and the N consults to the
 * organization (spec 366); the organization asks bob's and carol's agents through the consult rail and
 * SKIPS dave (no opt-in) with a receipt saying so. The composed answer names each source. Twin: a
 * stranger (david) asking the same is refused at the organization.
 */
import { hashDelegation, buildCaveat, encodeTimestampTerms, encodeAllowedTargetsTerms, encodeAllowedMethodsTerms, ROOT_AUTHORITY, type Delegation, type Caveat } from '../packages/delegation/src/index.js';
import { keccak256, toBytes, type Address, type Hex } from 'viem';

const HOME = 'https://www.faithnet.me';
const CHAIN = 34348;
const DM = '0x710cb1bF08C234Df397e0910331e0A29710EF4F7' as Address;
const ENF = { timestamp: '0x73A7B878168b7DE48677617179A8bE894f0Dfe96', allowedTargets: '0x2156311097A936de1916a878bF53Bfd43c7b5715', allowedMethods: '0xdBb2E47793393C499efB0f3fcbf6Ca8669791a41' } as const;
const ORG = '0x3b99f2b452766de5df0dbcdfc676f27257151333' as Address; // Missio Nexus
const CONSULT_SELECTOR = keccak256(toBytes('discussion.consult')).slice(0, 10) as Hex;
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/128 Safari/537.36';
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 250), _status: r.status }; } };
const signin = async (handle: string) => j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle, client_id: 'demo-web' }) }));
const signerFor = (token: string) => async (digest: Hex): Promise<Hex> => {
  const b = await j(await fetch(`${HOME}/connect/persona-sign`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ digest }) }));
  if (!b.signature) throw new Error(`persona-sign refused: ${JSON.stringify(b).slice(0, 200)}`);
  return b.signature;
};
const home = (token: string) => ({ 'content-type': 'application/json', authorization: `Bearer ${token}` });
const randSalt = () => { let s = 0n; for (const b of crypto.getRandomValues(new Uint8Array(16))) s = (s << 8n) | BigInt(b); return s; };
const wireOf = (d: Delegation) => ({ ...d, salt: d.salt.toString() });

// ── setup 1: the organization's consult wire (alice, steward) ─────────────────────────────────────────
const alice = await signin('alice');
const ALICE = String(alice.agent).toLowerCase() as Address;
const st = await j(await fetch(`${HOME}/connect/channels`, { method: 'POST', headers: home(alice.homeSession), body: JSON.stringify({ action: 'routingStatus', communityId: ORG }) }));
if (!st.ok) throw new Error(`routingStatus: ${JSON.stringify(st).slice(0, 200)}`);
if (!st.wirePresent) {
  const validUntil = Math.floor(Date.now() / 1000) + 180 * 86400;
  const caveats: Caveat[] = [
    buildCaveat(ENF.timestamp, encodeTimestampTerms(0, validUntil)),
    buildCaveat(ENF.allowedTargets, encodeAllowedTargetsTerms([ORG])),
    buildCaveat(ENF.allowedMethods, encodeAllowedMethodsTerms([CONSULT_SELECTOR])),
  ];
  const d: Delegation = { delegator: ORG, delegate: st.sessionKey as Address, authority: ROOT_AUTHORITY, caveats, salt: randSalt(), signature: '0x' };
  d.signature = await signerFor(alice.homeSession)(hashDelegation(d, CHAIN, DM));
  const ch = await j(await fetch(`${HOME}/connect/channels?communityId=${ORG}`, { headers: home(alice.homeSession) }));
  const channelId = ch.channels?.[0]?.descriptor?.id;
  if (!channelId) throw new Error('Missio Nexus has no topic to enable routing on');
  const en = await j(await fetch(`${HOME}/connect/channels`, { method: 'POST', headers: home(alice.homeSession), body: JSON.stringify({ action: 'routingEnable', communityId: ORG, channelId, maxFanout: 3, delegation: wireOf(d) }) }));
  if (!en.ok) throw new Error(`routingEnable: ${JSON.stringify(en).slice(0, 300)}`);
  console.log('setup: alice minted the organization\'s consult wire (routing enabled)');
} else console.log('setup: the organization\'s consult wire is present');

// ── setup 2: bob and carol opt in; dave stays out ────────────────────────────────────────────────────
const optIn = async (handle: string) => {
  const s = await signin(handle);
  const me = String(s.agent).toLowerCase() as Address;
  const rows = await j(await fetch(`${HOME}/connect/consultability`, { headers: home(s.homeSession) }));
  const row = (rows.orgs ?? []).find((o: { orgAgent: string }) => o.orgAgent.toLowerCase() === ORG);
  if (row?.consultable) { console.log(`setup: ${handle} already opted in`); return me; }
  const validUntil = Math.floor(Date.now() / 1000) + 180 * 86400;
  const caveats: Caveat[] = [
    buildCaveat(ENF.timestamp, encodeTimestampTerms(0, validUntil)),
    buildCaveat(ENF.allowedTargets, encodeAllowedTargetsTerms([me])),
    buildCaveat(ENF.allowedMethods, encodeAllowedMethodsTerms([CONSULT_SELECTOR])),
  ];
  const d: Delegation = { delegator: me, delegate: ORG, authority: ROOT_AUTHORITY, caveats, salt: randSalt(), signature: '0x' };
  d.signature = await signerFor(s.homeSession)(hashDelegation(d, CHAIN, DM));
  const r = await j(await fetch(`${HOME}/connect/consultability`, { method: 'POST', headers: home(s.homeSession), body: JSON.stringify({ action: 'grant', org: ORG, delegation: wireOf(d) }) }));
  if (!r.ok) throw new Error(`${handle} opt-in: ${JSON.stringify(r).slice(0, 300)}`);
  console.log(`setup: ${handle} opted in to being consulted by Missio Nexus`);
  return me;
};
const BOB = await optIn('bob');
const CAROL = await optIn('carol');
const dave = await signin('dave');
const DAVE = String(dave.agent).toLowerCase();
const drows = await j(await fetch(`${HOME}/connect/consultability`, { headers: home(dave.homeSession) }));
if ((drows.orgs ?? []).find((o: { orgAgent: string; consultable: boolean }) => o.orgAgent.toLowerCase() === ORG)?.consultable) throw new Error('dave is opted in — the skip twin needs him out');
console.log(`setup: dave (${DAVE.slice(0, 10)}…) is NOT opted in`);

// ── the ask, at alice's agent ────────────────────────────────────────────────────────────────────────
const A2A = 'https://alice.faithnet.ai';
const csrfRes = await fetch(`${A2A}/auth/csrf`, { headers: { origin: HOME, 'user-agent': UA } });
const csrfTok = csrfRes.headers.get('x-csrf-token') || ((await j(csrfRes.clone())) as { token?: string }).token || '';
const cookie = (csrfRes.headers.get('set-cookie') ?? '').split(';')[0];
const H = { 'content-type': 'application/json', origin: HOME, cookie, 'x-csrf-token': csrfTok, 'user-agent': UA };
const post = async (path: string, body: unknown) => j(await fetch(`${A2A}${path}`, { method: 'POST', headers: H, body: JSON.stringify(body) }));
type Reply = { kind?: string; text?: string; error?: string; runRef?: string; evidence?: Array<{ toolId: string; interpretation?: string; reason?: string }>; routed?: Array<{ stepRef: string; agent: string; name?: string }> };

const t0 = Date.now();
const r1 = await post('/harness/ask', { session: alice.homeSession, addressee: ALICE, message: 'ask each member of Missio Nexus whether they are available on Saturday' });
const rep = r1.reply as Reply;
console.log(`\nask → ${rep?.kind} (${((Date.now() - t0) / 1000).toFixed(1)}s)\n  ${(rep?.text ?? rep?.error ?? '').slice(0, 700)}`);
if (rep?.kind !== 'answer') throw new Error(`expected an answer: ${JSON.stringify(r1).slice(0, 800)}`);
const ev = rep.evidence ?? [];
const consults = ev.filter((e) => e.toolId === 'organization.member.consult');
console.log(`  evidence: ${consults.length} consult line(s)`);
for (const c of consults) console.log(`    · ${c.interpretation ?? c.reason ?? ''}`);
const asked = consults.filter((c) => /^asked /.test(c.interpretation ?? ''));
const skipped = consults.filter((c) => /^skipped /.test(c.interpretation ?? ''));
if (asked.length < 2) throw new Error(`expected bob's and carol's agents to be asked; asked ${asked.length}`);
if (!skipped.length) throw new Error('expected at least one member skipped for want of an opt-in');
if (!skipped.some((c) => /no consultability grant/.test(c.interpretation ?? ''))) throw new Error('the skip does not say why');
const text = rep.text ?? '';
if (!/\bbob\b/i.test(text) || !/\bcarol\b/i.test(text)) throw new Error('the answer does not name bob and carol as sources');
if (!/\bdave\b/i.test(text)) throw new Error('the answer does not say dave was not asked');
console.log(`  ✓ N consults as steps: ${asked.length} asked, ${skipped.length} skipped with the reason; the answer names each source`);
// Spec 380 W2 — each member's OWN WORDS reach the asker as evidence (the consults ran at the organization):
// an answer, or a decline WITH ITS REASON in the member's agent's words, or not asked and why. The Home
// lists exactly these lines under the answer.
const worded = consults.filter((c) => /— it (answered|declined)/.test(c.interpretation ?? ''));
const reasons = consults.filter((c) => /— it declined: .{8,}/.test(c.interpretation ?? ''));
if (worded.length < 2) throw new Error(`expected bob's and carol's agents' own words on the evidence; got ${worded.length}`);
console.log(`  ✓ each member's own words are on the evidence (${worded.length} answered/declined, ${reasons.length} decline reason(s) in the member's agent's words)`);
console.log(`  routed: ${(rep.routed ?? []).map((r) => `${r.stepRef}→${r.name ?? r.agent.slice(0, 10)}`).join(', ')}`);

// ── twin: a stranger asking the organization's members is refused ──────────────────────────────────
const david = await signin('david');
const DAVID = String(david.agent).toLowerCase() as Address;
const S2 = 'https://david.faithnet.ai';
const c2 = await fetch(`${S2}/auth/csrf`, { headers: { origin: HOME, 'user-agent': UA } });
const H2 = { 'content-type': 'application/json', origin: HOME, cookie: (c2.headers.get('set-cookie') ?? '').split(';')[0], 'x-csrf-token': c2.headers.get('x-csrf-token') || ((await j(c2.clone())) as { token?: string }).token || '', 'user-agent': UA };
const r2 = await j(await fetch(`${S2}/harness/ask`, { method: 'POST', headers: H2, body: JSON.stringify({ session: david.homeSession, addressee: DAVID, message: 'ask each member of Missio Nexus whether they are available on Saturday' }) }));
const rep2 = r2.reply as Reply;
console.log(`\ntwin (david, a stranger) → ${rep2?.kind}: ${(rep2?.error ?? rep2?.text ?? '').slice(0, 240)}`);
if (rep2?.kind === 'answer' && /\bbob\b|\bcarol\b/i.test(rep2.text ?? '')) throw new Error('a stranger was told what the members said');
if (!(rep2?.kind === 'refused' || rep2?.kind === 'prompt' || rep2?.kind === 'answer')) throw new Error(`unexpected twin reply: ${JSON.stringify(r2).slice(0, 400)}`);
console.log('  ✓ the stranger got no member\'s words');
console.log('\nspec 380 W1 live: N routed consults, N receipts, one composed answer with each source named; the un-opted-in member skipped with a receipt. ✓');
