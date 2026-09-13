/**
 * Spec 400 W1 — AN OUTSIDE ACP RUNTIME AS A WORKSPACE MEMBER, live (a stub ACP agent stands in for goose; no model on
 * the runtime's side, the steward's asks use supplied plans).
 *
 *   npx tsx scripts/verify-runtime-acp-member.mts        (FIXTURE_JSON=… for another estate; the role `acpRuntime` must be set)
 *
 * The steward has chartered `<label>.svc` (charter-coach.mts) and invited it to the organization. This gate:
 *   1. JOINS the runtime as that member — its own key, the session wire the custodian signs, its steward link, vault key
 *      and playbook (`runtimeJoin`, what `ap runtime join` does);
 *   2. the steward DMs the runtime ("summarize the retreat plan") — her act, her mandate, one-prompt;
 *   3. runs the loop ONE turn with the stub ACP agent: the poll (a supplied plan on the standard surface, as the
 *      runtime) finds the message; the agent is prompted with the workspace context; its answer is sent back as the
 *      runtime — and PARKS for the steward's mandate (the runtime holds none); the turn report says so;
 *   4. the steward signs that mandate at her Home and the reply lands (the run completes);
 *   5. the runtime reads the organization's roster AS ITSELF (its membership standing);
 *   6. THE TWIN: the custodian REVOKES the session wire on chain; the next request as the runtime is refused (401) —
 *      everywhere, with no list to update.
 */
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { encodeFunctionData, type Address, type Hex } from 'viem';
import { buildDigestBindingCaveat, buildRevokeDelegationCall, capabilityHandler, hashDelegation, ROOT_AUTHORITY, type Caveat, type Delegation, type MandateRequirementV1 } from '@agenticprimitives/delegation';
import { runtimeJoin, runRuntimeMember, personaCustodian, askAs, loadRuntimeMember, type TurnReport } from '@agenticprimitives/runtime-member';
import { fixture as fx, HOME, A2A, skipUnless } from './fixture.mts';

const R = skipUnless(fx.acpRuntime, 'ACP runtime member (acpRuntime: its .svc and workspace)');
const CHAIN_NAME = process.env.CHAIN_NAME ?? 'faithchain';
const C = ((await import(`@agenticprimitives/contracts/deployments/${CHAIN_NAME}`)) as { CONTRACTS: Record<string, string> & { chainId: number } }).CONTRACTS;
const DM = C.delegationManager as Address;
const ENF = { delegationManager: DM, timestamp: C.timestampEnforcer, allowedTargets: C.allowedTargetsEnforcer, allowedMethods: C.allowedMethodsEnforcer, value: C.valueEnforcer, payment: C.paymentEnforcer, digestBinding: C.digestBindingEnforcer } as const;
const STUB = fileURLToPath(new URL('../packages/acp/bin/acp-stub-agent.mjs', import.meta.url));
const MCP = { command: process.execPath, args: [fileURLToPath(new URL('../packages/runtime-member/bin/ap-runtime.mjs', import.meta.url)), 'mcp', '--member', R.member] };
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 250), _status: r.status }; } };
const fail = (m: string): never => { console.error(`\n✗ ${m}`); process.exit(1); };

// ── the steward, at her Home ──
const steward = await personaCustodian(HOME, fx.people.steward);
const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
const csrf = (await j(csrfRes)) as { token?: string };
const H = { 'content-type': 'application/json', origin: HOME, cookie: (csrfRes.headers.get('set-cookie') ?? '').split(';')[0] ?? '', 'x-csrf-token': csrf.token ?? '' };
const post = async (path: string, body: unknown) => j(await fetch(`${HOME}/a2a${path}`, { method: 'POST', headers: H, body: JSON.stringify(body) }));
type Reply = { kind?: string; error?: string; text?: string; runRef?: string; requirement?: MandateRequirementV1; delegator?: Address; delegate?: Address; alsoApprove?: Array<{ digest: Hex }>; result?: unknown };
/** The steward's one-prompt approval of a run parked at `addressee` (her own agent's, or one she custodies). */
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

// ── 0. the member's invitation (S3b — a service agent is invited like any member); kept when the roster lists it ──
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
      const stored = await j(await fetch(`${HOME}/connect/org-invite/agent`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${steward.bearer}` }, body: JSON.stringify({ org: String(result.org).toLowerCase(), agent: String(result.invitee).toLowerCase(), memberAccessDelegation: result.memberAccessDelegation }) }));
      console.log(`  the organization's half recorded → ${stored.ok === true ? 'ok' : JSON.stringify(stored).slice(0, 160)}`);
    }
  }
}

// ── 1. join ──
const { record } = await runtimeJoin({ home: HOME, edge: fx.edge, a2a: A2A, member: R.member, workspace: R.workspace, contracts: C as never, custodian: steward, registry: { origin: fx.skillsRegistry, context: 'agentic-trust', archetype: 'runtime-member' }, validForSeconds: 3600, log: (l) => console.log(`  join: ${l}`) });

// the cursor BEFORE the steward writes, so the loop answers exactly her message
const before = await askAs(record, record.name, "what's new for me", { plan: { steps: [{ toolId: 'messaging.inbox.list', args: { limit: 1 } }] } });
const cursor = (before.data as { cursor?: string } | undefined)?.cursor;
console.log(`  inbox before: ${before.state} · cursor ${cursor ?? '(empty)'}`);
if (before.state !== 'TASK_STATE_COMPLETED') fail(`the runtime could not read its own inbox as itself: ${JSON.stringify(before).slice(0, 300)}`);

// ── 2. the steward DMs the runtime (her act; her mandate) ──
const nonce = Date.now().toString(36);
const dmText = `summarize the retreat plan (${nonce})`;
let dm = (await post('/harness/ask', { session: steward.bearer, addressee: steward.agent, message: `send ${R.member} a message: ${dmText}`, plan: { steps: [{ toolId: 'messaging.direct.send', args: { recipient: R.member, message: dmText } }] } })).reply as Reply;
if (dm.kind === 'authority_required') dm = await approve(steward.agent, dm.runRef!, dm);
console.log(`  steward → ${R.member}: ${dm.kind}${dm.error ? ` ${dm.error}` : ''}`);
if (dm.kind !== 'done' && dm.kind !== 'answer') fail(`the steward's message did not go: ${JSON.stringify(dm).slice(0, 300)}`);

// ── 3. one turn of the loop with the stub agent ──
const turns: TurnReport[] = [];
await runRuntimeMember({ member: R.member, agent: [process.execPath, STUB], mcpCommand: MCP, ...(cursor ? { since: cursor } : {}), maxTurns: 1, pollMs: 3000, log: (l) => console.log(`  loop: ${l}`), onTurn: (t) => turns.push(t) });
const t = turns[0];
if (!t) fail('the loop saw no message from the steward');
console.log(`  turn: from ${t!.fromName ?? t!.from} · agent said "${t!.answer.slice(0, 70)}…" · reply: ${t!.reply.slice(0, 90)}`);
if (!t!.answer.includes(`heard "`) || !t!.answer.includes(nonce)) fail('the agent was not prompted with the steward\'s message');
if (!t!.answer.includes('local tool refused')) fail('the host allowed the agent\'s local shell by default');
if (!t!.parkedRunRef) fail(`the runtime's reply did not park for a mandate: ${t!.reply}`);

// ── 4. the steward signs the runtime's reply at her Home (she custodies the member) ──
const parked = (await post('/harness/ask', { session: steward.bearer, addressee: member, runRef: t!.parkedRunRef })).reply as Reply;
console.log(`  resumed at her Home → ${parked.kind} · delegator ${String(parked.delegator ?? '').slice(0, 12)}… (the member is ${member.slice(0, 12)}…, she is ${steward.agent.slice(0, 12)}…)`);
const landed = parked.kind === 'authority_required' ? await approve(member, t!.parkedRunRef!, parked) : parked;
console.log(`  the steward signed the reply → ${landed.kind}${landed.error ? ` ${landed.error}` : ''}`);
if (landed.kind !== 'done' && landed.kind !== 'answer') fail(`the runtime's reply did not land after the steward signed: ${JSON.stringify(landed).slice(0, 300)}`);

// ── 5. the runtime reads the organization as a member ──
const roster = await askAs(record, R.workspace, 'who are the members', { plan: { steps: [{ toolId: 'organization.membership.list', args: { org: R.workspace } }] } });
console.log(`  roster as ${R.member}: ${roster.state} · ${roster.text.replace(/\s+/g, ' ').slice(0, 120)}`);
if (roster.state !== 'TASK_STATE_COMPLETED') fail(`the runtime could not read the roster as a member: ${JSON.stringify(roster).slice(0, 300)}`);
const rosterText = `${roster.text} ${JSON.stringify(roster.data ?? '')}`.toLowerCase();
if (!/member/.test(rosterText) || /requires authorization|not authorized|private and/i.test(roster.text)) fail(`the roster did not answer the runtime as a member: ${roster.text.slice(0, 200)}`);

// ── 6. twin: the custodian revokes the wire on chain; the runtime is refused ──
const rec = loadRuntimeMember(R.member);
const wire = rec.wire as unknown as Delegation & { salt: string };
const call = buildRevokeDelegationCall({ ...wire, salt: BigInt(wire.salt) } as Delegation, DM);
const EXECUTE_ABI = [{ type: 'function', name: 'execute', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' }], outputs: [] }] as const;
const callData = encodeFunctionData({ abi: EXECUTE_ABI, functionName: 'execute', args: [call.to, call.value, call.data] });
const b = await post('/account/build-call-userop', { sender: member, callData }) as { ok?: boolean; userOpHash?: Hex; userOp?: Record<string, unknown>; error?: string };
if (!b.ok || !b.userOpHash) fail(`revoke build: ${JSON.stringify(b).slice(0, 200)}`);
const out = await post('/account/submit-call-userop', { userOp: { ...b.userOp, signature: await steward.signDigest(b.userOpHash!) } }) as { ok?: boolean; transactionHash?: string; error?: string };
if (!out.ok) fail(`revoke submit: ${JSON.stringify(out).slice(0, 200)}`);
console.log(`  wire revoked on chain (tx ${String(out.transactionHash).slice(0, 18)}…)`);
let refused = false;
for (let i = 0; i < 6 && !refused; i++) {
  await new Promise((r) => setTimeout(r, 3000));
  const after = await askAs(record, record.name, "what's new for me", { plan: { steps: [{ toolId: 'messaging.inbox.list', args: { limit: 1 } }] } }).catch((e: Error) => ({ state: 'REFUSED', text: e.message, parked: false }));
  refused = after.state === 'REFUSED' || /401|revoked|unauthori/i.test(after.text);
  console.log(`  after revocation: ${after.state} · ${after.text.slice(0, 100)}`);
}
if (!refused) fail('the runtime still spoke after its wire was revoked');

console.log(`\n✓ spec 400 W1: an ACP runtime joined ${R.workspace} as ${R.member} (its own key, the custodian's wire, its playbook), received the steward's message through its own inbox as itself, answered through the stub agent — its local shell refused, the workspace's tools allowed — its reply parked for the steward's mandate and landed when she signed, it read the roster as a member, and once its wire was revoked on chain it was refused everywhere.`);
