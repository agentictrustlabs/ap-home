/**
 * Spec 400 W1c — A RUNTIME MEMBER ON A CONTAINER, WOKEN BY THE WORKER, live (the deterministic stub ACP agent inside the
 * Container; the steward's asks use supplied plans; no model anywhere).
 *
 *   npx tsx scripts/verify-runtime-wake.mts        (FIXTURE_JSON=… for another estate; the role `containerRuntime` must be set)
 *
 * The member was chartered and JOINED once by hand (`ap runtime join … --wake container --days 30`), its portable record
 * and wire key are the Worker's secrets (AP_RUNTIME_RECORD_<NAME> / AP_RUNTIME_KEY_<NAME>), the Worker binds the
 * Container (`RUNTIME`) and the wake queue (`RUNTIME_WAKE`). Nothing on this machine speaks for the member. This gate:
 *   0. makes sure the member is invited to the workspace (S3b; kept when the roster lists it);
 *   1. reads the custodian's host declaration on the member's object — it must say `container`;
 *   2. the steward DMs the member (her act, her mandate, one prompt);
 *   3. waits for the WAKE RECEIPT on the member's object: the Worker enqueued after admission, the consumer woke the
 *      Container, the Container ran one pass — the agent was prompted with the steward's words, its local shell refused,
 *      the workspace tool allowed — and its reply PARKED for the steward's mandate (the parked run ref is in the receipt);
 *   4. the reply LANDS: under the OPEN MANDATE (spec 400 W2a — a standing grant the custodian signed once, the child the
 *      runtime derived for this intent, the chain verified by the harness) it went through without a signature and the
 *      receipt names both refs; with no grant it parked and the steward signs it at her Home;
 *   5. THE TWIN: the custodian CLEARS the host declaration; another message is admitted and NO wake is delivered (the
 *      Worker wakes nothing it was not told about); the declaration is restored.
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

// ── the steward, at her Home ──
const steward = await personaCustodian(HOME, fx.people.steward);
const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
const csrf = (await j(csrfRes)) as { token?: string };
const H = { 'content-type': 'application/json', origin: HOME, cookie: (csrfRes.headers.get('set-cookie') ?? '').split(';')[0] ?? '', 'x-csrf-token': csrf.token ?? '' };
const post = async (path: string, body: unknown) => j(await fetch(`${HOME}/a2a${path}`, { method: 'POST', headers: H, body: JSON.stringify(body) }));
type Reply = { kind?: string; error?: string; text?: string; runRef?: string; requirement?: MandateRequirementV1; delegator?: Address; delegate?: Address; alsoApprove?: Array<{ digest: Hex }>; result?: unknown };
async function approve(addressee: Address, runRef: string, rep: Reply): Promise<Reply> {
  if (!rep.requirement || !rep.delegator || !rep.delegate) fail(`nothing to approve on ${runRef}: ${JSON.stringify(rep).slice(0, 200)}`);
  const caveats: Caveat[] = [...capabilityHandler.toCaveats(rep.requirement!, ENF as never), buildDigestBindingCaveat(ENF.digestBinding as Address, 'intent', rep.requirement!.intentDigest as Hex)];
  let salt = 0n; for (const b of randomBytes(16)) salt = (salt << 8n) | BigInt(b);
  const mandate: Delegation = { delegator: rep.delegator!, delegate: rep.delegate!, authority: ROOT_AUTHORITY, caveats, salt, signature: '0x' };
  const a = await post('/harness/authorize', { session: steward.bearer, delegator: rep.delegator, digests: [hashDelegation(mandate, C.chainId, DM), ...(rep.alsoApprove ?? []).map((x) => x.digest)] });
  if (a.ok !== true) fail(`authorize build: ${JSON.stringify(a).slice(0, 300)}`);
  const b2 = await post('/harness/authorize', { session: steward.bearer, delegator: rep.delegator, userOp: a.userOp, signature: await steward.signDigest(a.userOpHash as Hex) });
  if (b2.ok !== true) fail(`authorize submit: ${JSON.stringify(b2).slice(0, 300)}`);
  mandate.signature = '0x03';
  const r = await post('/harness/ask', { session: steward.bearer, addressee, runRef, presented: { ...mandate, salt: salt.toString() } });
  return (r.reply ?? {}) as Reply;
}
const nameInfo = async (n: string): Promise<Address> => { const r = await j(await fetch(`${HOME}/connect/name-info?name=${encodeURIComponent(n)}`)); if (!r.exists || !r.agent) fail(`${n} does not resolve at ${HOME}`); return String(r.agent).toLowerCase() as Address; };
const member = await nameInfo(R.member);
const org = await nameInfo(R.workspace);
console.log(`── ${R.member} ${member} · workspace ${R.workspace} ${org} · steward ${fx.people.steward} ──`);

// The steward's link for the member (what `ap runtime join` recorded) — the proof the member's object takes for its ops.
const links = ((await j(await fetch(`${HOME}/connect/related-orgs?surface=any`, { headers: { authorization: `Bearer ${steward.bearer}` } }))).orgs ?? []) as Array<{ orgAgent: string; relationship?: string; stewardshipDelegation?: unknown }>;
const stewardship = links.find((l) => l.orgAgent.toLowerCase() === member && l.relationship === 'steward')?.stewardshipDelegation;
if (!stewardship) fail(`${fx.people.steward} holds no steward link for ${R.member} — \`ap runtime join … --wake container\` first`);
const memberOp = async (op: string, body: Record<string, unknown> = {}) => j(await fetch(`${A2A}/interactions/${member}/${op}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: steward.bearer, stewardship, ...body }) }));

// ── 0. the member's invitation (S3b) ──
{
  const listed = (await post('/harness/ask', { session: steward.bearer, addressee: org, message: 'who are the members', plan: { steps: [{ toolId: 'organization.membership.list', args: { org } }] } })).reply as Reply;
  const has = String(listed.text ?? '').toLowerCase().includes(R.member.toLowerCase()) || JSON.stringify(listed.result ?? '').toLowerCase().includes(member);
  if (has) console.log(`  ${R.member} is already a member of ${R.workspace}`);
  else {
    let inv = (await post('/harness/ask', { session: steward.bearer, addressee: org, message: `invite ${R.member} to this organization`, plan: { steps: [{ toolId: 'organization.membership.invite', args: { org, invitee: R.member } }] } })).reply as Reply;
    if (inv.kind === 'authority_required') inv = await approve(org, inv.runRef!, inv);
    console.log(`  invited ${R.member} → ${inv.kind}${inv.error ? ` ${inv.error}` : ''}`);
    if (inv.kind !== 'done' && inv.kind !== 'answer') fail(`the invitation did not go: ${JSON.stringify(inv).slice(0, 300)}`);
    const result = (inv.result ?? {}) as { org?: string; invitee?: string; memberAccessDelegation?: unknown; invited?: boolean };
    if (result.invited && result.memberAccessDelegation) {
      const stored = await j(await fetch(`${HOME}/connect/org-invite/agent`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${steward.bearer}` }, body: JSON.stringify({ org: String(result.org ?? org).toLowerCase(), agent: String(result.invitee ?? member).toLowerCase(), memberAccessDelegation: result.memberAccessDelegation }) }));
      console.log(`  the organization's half recorded → ${stored.ok === true ? 'ok' : JSON.stringify(stored).slice(0, 160)}`);
    }
  }
}

// ── 1. the host declaration ──
const declared = await memberOp('runtime.host.get') as { ok?: boolean; host?: { kind?: string } | null; error?: string };
console.log(`  host declared: ${declared.host ? declared.host.kind : `(none) ${declared.error ?? ''}`}`);
if (declared.host?.kind !== 'container') fail(`${R.member} declares no Container host — \`ap runtime host --member ${R.member} --handle ${fx.people.steward} container\``);

// ── 2. the steward DMs the member ──
async function dm(text: string): Promise<string> {
  let r = (await post('/harness/ask', { session: steward.bearer, addressee: steward.agent, message: `send ${R.member} a message: ${text}`, plan: { steps: [{ toolId: 'messaging.direct.send', args: { recipient: R.member, message: text } }] } })).reply as Reply;
  if (r.kind === 'authority_required') r = await approve(steward.agent, r.runRef!, r);
  if (r.kind !== 'done' && r.kind !== 'answer') throw new Error(`the steward's message did not go: ${JSON.stringify(r).slice(0, 300)}`);
  const id = (r.result as { messageId?: string } | undefined)?.messageId ?? '';
  console.log(`  steward → ${R.member}: ${r.kind} · message ${id || '(id not reported)'}`);
  return id;
}
const nonce = Date.now().toString(36);
const sentAt = Date.now();
const messageId = await dm(`summarize the retreat plan (${nonce})`).catch((e: Error) => fail(e.message));

// ── 3. the wake receipt: enqueued after admission, the Container woken, one pass, the reply parked ──
type Receipt = { messageId: string; outcome: string; status: number | null; error?: string; wokeAt: string; turns: Array<{ messageId: string; fromName: string | null; answer: string; reply: string; parkedRunRef?: string; underStandingGrant?: { childRef: string; standingRef: string } }> };
let receipt: Receipt | undefined;
for (let i = 0; i < 40 && !receipt; i++) {
  await sleep(3000);
  const got = await memberOp('runtime.wake.get', messageId ? { messageId } : { limit: 5 }) as { wakes?: Receipt[] };
  receipt = (got.wakes ?? []).find((w) => (messageId ? w.messageId === messageId : w.turns.some((t) => t.answer.includes(nonce))));
  if (!receipt && i % 5 === 4) console.log(`  … no wake receipt yet (${(Date.now() - sentAt) / 1000 | 0}s; a cold Container takes a while)`);
}
if (!receipt) fail('no wake receipt within two minutes — the Worker did not wake the Container, or the Container did not answer');
console.log(`  woken: ${receipt!.outcome} (${receipt!.status}) ${((Date.parse(receipt!.wokeAt) - sentAt) / 1000).toFixed(1)}s after the send · ${receipt!.turns.length} turn(s)${receipt!.error ? ` · ${receipt!.error}` : ''}`);
if (receipt!.outcome !== 'woken') fail(`the Container was not woken: ${receipt!.error ?? receipt!.status}`);
const t = receipt!.turns.find((x) => x.answer.includes(nonce));
if (!t) fail(`the Container's pass did not answer the steward's message: ${JSON.stringify(receipt!.turns).slice(0, 300)}`);
console.log(`  turn: from ${t!.fromName} · agent said "${t!.answer.slice(0, 70)}…" · reply: ${t!.reply.slice(0, 90)}`);
if (!t!.answer.includes('local tool refused')) fail('the host in the Container allowed the agent\'s local shell by default');
if (!t!.answer.includes('workspace tool allowed')) fail('the workspace tool was not allowed to the agent');

// ── 4. the reply lands — under the open mandate (no signature), else after the steward signs ──
if (t!.underStandingGrant) {
  console.log(`  under the OPEN MANDATE: standing ${t!.underStandingGrant.standingRef.slice(0, 14)}… → child ${t!.underStandingGrant.childRef.slice(0, 14)}… · reply "${t!.reply.slice(0, 60)}"`);
  if (t!.parkedRunRef) fail(`the reply went under the standing grant yet still parked: ${t!.reply}`);
  if (/^parked:|^failed:|^refused:/.test(t!.reply)) fail(`the reply did not land under the standing grant: ${t!.reply}`);
} else {
  if (!t!.parkedRunRef) fail(`the runtime's reply did not park for a mandate and no standing grant carried it: ${t!.reply}`);
  const parked = (await post('/harness/ask', { session: steward.bearer, addressee: member, runRef: t!.parkedRunRef })).reply as Reply;
  const landed = parked.kind === 'authority_required' ? await approve(member, t!.parkedRunRef!, parked) : parked;
  console.log(`  no standing grant — the steward signed the reply → ${landed.kind}${landed.error ? ` ${landed.error}` : ''}`);
  if (landed.kind !== 'done' && landed.kind !== 'answer') fail(`the runtime's reply did not land after the steward signed: ${JSON.stringify(landed).slice(0, 300)}`);
}

// ── 5. twin: no declaration, no wake ──
const cleared = await memberOp('runtime.host.put', { host: null }) as { ok?: boolean };
if (cleared.ok !== true) fail(`could not clear the host declaration: ${JSON.stringify(cleared).slice(0, 200)}`);
// The declaration is restored WHATEVER happens in the twin — `fail` exits the process, so the verdict is kept and
// raised after the restore, never before it (a gate that leaves the member undeclared breaks the next run).
let twinVerdict: string | null = null;
try {
  const twinId = await dm(`and now, with no host declared (${nonce}-twin)`).catch((e: Error) => { twinVerdict = `the twin's message did not go: ${e.message}`; return ''; });
  if (!twinVerdict) {
    await sleep(20_000);
    const got = await memberOp('runtime.wake.get', { limit: 10 }) as { wakes?: Receipt[] };
    const stray = (got.wakes ?? []).find((w) => (twinId ? w.messageId === twinId : w.turns.some((x) => x.answer.includes(`${nonce}-twin`))));
    if (stray) twinVerdict = `the Worker woke the Container with no host declared: ${JSON.stringify(stray).slice(0, 200)}`;
    else console.log('  twin: no host declared → no wake delivered (20s)');
  }
} finally {
  const back = await memberOp('runtime.host.put', { host: { v: 1, kind: 'container' } }) as { ok?: boolean };
  console.log(`  host declaration restored → ${back.ok === true ? 'container' : JSON.stringify(back).slice(0, 120)}`);
}
if (twinVerdict) fail(twinVerdict);

console.log(`\n✓ spec 400 W1c on ${CHAIN_NAME}: ${R.member} on a Container, woken by the Worker after admission — the agent prompted, its shell refused, the workspace allowed, the reply landed (under the open mandate, or after the steward signed); with no host declared, nothing was woken.`);
