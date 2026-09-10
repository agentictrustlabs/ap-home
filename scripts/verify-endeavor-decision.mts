/**
 * Spec 393 W1 — DECISIONS BY DECLARED APPROVERS, live on Missio Nexus (no model; the doors and the reducer under test).
 *
 *   npx tsx scripts/verify-endeavor-decision.mts
 *
 * alice (a steward) raises a decision on an endeavor naming carol as its approver. carol's My Work lists it
 * pending. carol records `approved` → the record. THE TWINS: bob (not named) is refused; alice — a steward,
 * NOT named, her organization not named — is refused in those words; carol again is refused: the request is
 * closed and the record immutable. The detail's decisions[] shows the request decided by carol; carol's My
 * Work lists nothing after.
 */
import type { Address } from 'viem';

const HOME = 'https://www.faithnet.me';
const A2A = 'https://a2a.faithnet.io';
const ORG = '0x3b99f2b452766de5df0dbcdfc676f27257151333' as Address; // Missio Nexus
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 250), _status: r.status }; } };
let restoreAutoWork: () => Promise<void> = async () => undefined;
const fail = (m: string): never => { console.error(`\n✗ ${m}`); void restoreAutoWork().finally(() => process.exit(1)); throw new Error(m); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const signin = async (handle: string) => j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle, client_id: 'demo-web' }) }));

const alice = await signin('alice'); const ALICE = String(alice.agent).toLowerCase() as Address;
const bob = await signin('bob'); const BOB = String(bob.agent).toLowerCase() as Address;
const carol = await signin('carol'); const CAROL = String(carol.agent).toLowerCase() as Address;
const related = await j(await fetch(`${HOME}/connect/related-orgs?person=${ALICE}`, { headers: { authorization: `Bearer ${alice.homeSession}` } }));
const stewardship = (related.orgs ?? []).find((o: { orgAgent: string }) => o.orgAgent.toLowerCase() === ORG)?.stewardshipDelegation;
if (!stewardship) fail('alice holds no stewardship wire for Missio Nexus');
type Ix = { ok?: boolean; error?: string; _status?: number; status?: string | number } & Record<string, unknown>;
const ix = async (token: string, op: string, payload: Record<string, unknown>, withStewardship = false): Promise<Ix & { httpStatus: number }> => {
  // The organization's vault verifies its grant per op on a rate-limited RPC; a transient `auth failed — mcp`
  // is re-tried as the SAME call a bounded number of times (ADR-0013: a retry, never another mechanism).
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${A2A}/interactions/${ORG}/${op}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: token, ...(withStewardship ? { stewardship } : {}), ...payload }) });
    const out = await j(res);
    if (res.status === 409 && /auth failed — mcp/.test(String(out.error)) && attempt < 6) { console.log(`  (${op}: the organization's vault budget is spent — waiting ${10 * (attempt + 1)}s)`); await sleep(10_000 * (attempt + 1)); continue; }
    await sleep(op.endsWith('.list') ? 3000 : 1500); // pace the organization's vault budget
    return { ...out, httpStatus: res.status };
  }
};

// ── setup: auto-work OFF for the run (the organization's coordinator answers a request with plan-drafting turns
// that spend the organization's vault budget — 120 verified calls a minute — beside the gate's own ops; past it,
// every op answers `auth failed — mcp`). Restored at the end, whatever happens.
const autoBefore = await ix(alice.homeSession, 'autowork.get', {}, true);
restoreAutoWork = async () => { if (autoBefore.enabled) await ix(alice.homeSession, 'autowork.enable', {}, true).catch(() => undefined); };
if (autoBefore.enabled) { await ix(alice.homeSession, 'autowork.disable', {}, true); console.log('setup: auto-work paused for the run'); }
try {

// ── 0. an endeavor to decide on (the steward adopts; with auto-work paused the organization's agent does not) ──
const nonce = Date.now().toString(36);
const LABEL = `Lodge decision ${nonce}`;
const requested = await ix(alice.homeSession, 'endeavor.request', { goal: `${LABEL}: book the lodge for the retreat?`, entryPoint: 'home-request' }, true);
const requestId = (requested.requestId ?? (requested.request as { requestId?: string } | undefined)?.requestId) as string | undefined;
if (!requestId) fail(`endeavor.request: ${JSON.stringify(requested).slice(0, 300)}`);
// The steward adopts (auto-work is paused, so the organization's agent does not race it). `endeavor.list` is
// a read of EVERY endeavor's log — dozens on this organization — so it is called as few times as possible.
const created = await ix(alice.homeSession, 'endeavor.create', { requestId, decision: 'adopt', title: LABEL }, true);
let endeavorId = typeof created.endeavorId === 'string' ? created.endeavorId : undefined;
if (!endeavorId) {
  const list = await ix(alice.homeSession, 'endeavor.list', {}, true);
  endeavorId = ((list.endeavors ?? []) as Array<Record<string, unknown>>).find((e) => `${e.title ?? ''}${e.goal ?? ''}`.includes(nonce))?.endeavorId as string | undefined;
}
if (!endeavorId) fail(`the request never became an endeavor: ${JSON.stringify(created).slice(0, 200)}`);
console.log(`endeavor ${endeavorId} (${LABEL})`);

// ── 1. the steward raises the decision, naming carol ──
const raised = await ix(alice.homeSession, 'endeavor.decision.request', { endeavorId, title: 'Book the lodge for the retreat?', decisionKind: 'go-no-go', summary: 'Two nights, 40 beds, $3,200 deposit.', approvers: [CAROL] }, true);
if (raised.ok !== true || typeof raised.decisionId !== 'string') fail(`decision.request: ${JSON.stringify(raised).slice(0, 300)}`);
const decisionId = raised.decisionId as string;
console.log(`  raised ${decisionId} for carol (${CAROL}) — status ${raised.status}`);

// ── 2. carol's My Work lists it pending ──
const listBefore = await ix(carol.homeSession, 'endeavor.list', {});
const mineBefore = ((listBefore.mine as { decisions?: Array<Record<string, unknown>> } | undefined)?.decisions ?? []).filter((d) => d.decisionId === decisionId);
console.log(`  carol's My Work before: ${mineBefore.length ? `pending — "${mineBefore[0]!.title}" (approver ${mineBefore[0]!.approver})` : 'NOT LISTED'}`);
if (mineBefore.length !== 1 || mineBefore[0]!.status !== 'pending') fail(`carol's My Work does not list the pending decision: ${JSON.stringify(listBefore).slice(0, 400)}`);

// ── 3. the twins first: bob (not named) and alice (a steward, not named) are refused ──
const byBob = await ix(bob.homeSession, 'endeavor.decide', { endeavorId, decisionId, outcome: 'approved', reason: 'looks fine' });
console.log(`  bob decides → ${byBob.httpStatus} ${byBob.error ?? ''}`);
if (byBob.httpStatus !== 403 || !/not a declared approver/.test(String(byBob.error))) fail(`bob should be refused as not a declared approver: ${JSON.stringify(byBob).slice(0, 300)}`);
const byAlice = await ix(alice.homeSession, 'endeavor.decide', { endeavorId, decisionId, outcome: 'approved', reason: 'as steward' }, true);
console.log(`  alice (steward, un-named) decides → ${byAlice.httpStatus} ${byAlice.error ?? ''}`);
if (byAlice.httpStatus !== 403 || !/steward standing never substitutes/.test(String(byAlice.error))) fail(`the un-named steward should be refused in those words: ${JSON.stringify(byAlice).slice(0, 300)}`);

// ── 4. carol decides ──
const byCarol = await ix(carol.homeSession, 'endeavor.decide', { endeavorId, decisionId, outcome: 'approved', reason: 'The deposit is within the retreat budget.' });
console.log(`  carol decides → ${byCarol.httpStatus} ${byCarol.ok === true ? `${byCarol.outcome} by ${byCarol.decidedBy} (${byCarol.status})` : byCarol.error}`);
if (byCarol.ok !== true || byCarol.outcome !== 'approved' || String(byCarol.decidedBy).toLowerCase() !== CAROL) fail(`carol's decision: ${JSON.stringify(byCarol).slice(0, 300)}`);

// ── 5. the record is immutable: carol again is refused ──
const again = await ix(carol.homeSession, 'endeavor.decide', { endeavorId, decisionId, outcome: 'rejected', reason: 'changed my mind' });
console.log(`  carol again → ${again.httpStatus} ${again.error ?? ''}`);
if (again.httpStatus !== 409 || !/already decided/.test(String(again.error))) fail(`a closed request should refuse a second record: ${JSON.stringify(again).slice(0, 300)}`);

// ── 6. the detail carries the record; carol's My Work lists nothing after ──
const detail = await ix(alice.homeSession, 'endeavor.get', { endeavorId }, true);
const row = ((detail.decisions ?? []) as Array<Record<string, unknown>>).find((d) => d.decisionId === decisionId);
console.log(`  detail: ${row ? `${row.status} · ${row.outcome} by ${row.decidedBy} · "${row.rationale}"` : 'NO ROW'}`);
if (!row || row.status !== 'recorded' || row.outcome !== 'approved' || String(row.decidedBy).toLowerCase() !== CAROL) fail(`the detail does not carry carol's record: ${JSON.stringify(detail.decisions).slice(0, 400)}`);
const listAfter = await ix(carol.homeSession, 'endeavor.list', {});
const mineAfter = ((listAfter.mine as { decisions?: Array<Record<string, unknown>> } | undefined)?.decisions ?? []).filter((d) => d.decisionId === decisionId);
console.log(`  carol's My Work after: ${mineAfter.length === 0 ? 'nothing pending' : 'STILL LISTED'}`);
if (mineAfter.length !== 0) fail('the decided request still lists as pending for carol');
console.log(`\n✓ spec 393 W1: the steward raised it naming carol; only carol could record it (bob refused, the un-named steward refused in those words); recorded once, immutable; the detail and My Work agree.`);
} finally { await restoreAutoWork(); }
