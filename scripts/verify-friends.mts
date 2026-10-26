/**
 * Spec 401 §10 — FRIENDSHIP is two-way, live (supplied plans; no model).
 *
 *   npx tsx scripts/verify-friends.mts        (FIXTURE_JSON=… for another estate)
 *
 * Two people, each acting through their own agent under their own mandate. The steward OFFERS friendship to the member
 * (her half: her grant, her record, typed `family`) — a request, not yet a friendship. The member SEES the request and
 * ACCEPTS (his half). Both now list each other as friends. Then the member REMOVES her (his grant revoked on chain, a
 * transaction): she sees "removed you" — ENDED, never silently a friend — and withdraws her own half.
 * THE TWINS: an organization is refused as a friend; a service (the ACP runtime, when the estate has one) is refused.
 */
import { randomBytes } from 'node:crypto';
import type { Address, Hex } from 'viem';
import { buildDigestBindingCaveat, capabilityHandler, hashDelegation, ROOT_AUTHORITY, type Caveat, type Delegation, type MandateRequirementV1 } from '@agenticprimitives/delegation';
import { personaCustodian } from '@agenticprimitives/runtime-member';
import { fixture as fx, HOME } from './fixture.mts';

const C = ((await import(`@agenticprimitives/contracts/deployments/${process.env.CHAIN_NAME ?? 'faithchain'}`)) as { CONTRACTS: Record<string, string> & { chainId: number } }).CONTRACTS;
const DM = C.delegationManager as Address;
const ENF = { delegationManager: DM, timestamp: C.timestampEnforcer, allowedTargets: C.allowedTargetsEnforcer, allowedMethods: C.allowedMethodsEnforcer, value: C.valueEnforcer, payment: C.paymentEnforcer, digestBinding: C.digestBindingEnforcer } as const;
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 250), _status: r.status }; } };
const fail = (m: string): never => { console.error(`\n✗ ${m}`); process.exit(1); };
type Reply = { kind?: string; error?: string; text?: string; runRef?: string; resumeToken?: string; requirement?: MandateRequirementV1; delegator?: Address; delegate?: Address; alsoApprove?: Array<{ digest: Hex }>; prompt?: { kind?: string; digest?: Hex; stepRef?: string; signer?: string; payload?: unknown }; result?: unknown; results?: Array<{ toolId: string; result: unknown }> };
type Person = Awaited<ReturnType<typeof personaCustodian>>;

const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
const csrf = (await j(csrfRes)) as { token?: string };
const H = { 'content-type': 'application/json', origin: HOME, cookie: (csrfRes.headers.get('set-cookie') ?? '').split(';')[0] ?? '', 'x-csrf-token': csrf.token ?? '' };
const post = async (who: Person, path: string, body: unknown) => j(await fetch(`${HOME}/a2a${path}`, { method: 'POST', headers: H, body: JSON.stringify({ session: who.bearer, ...(body as object) }) }));

/** One act of a person's: the plan supplied, the mandate signed one-prompt, a signature prompt answered by their custodian. */
async function act(who: Person, message: string, toolId: string, args: Record<string, unknown>): Promise<Reply> {
  let r = await post(who, '/harness/ask', { addressee: who.agent, message, plan: { steps: [{ toolId, args }] } });
  let rep = (r.reply ?? {}) as Reply;
  for (let i = 0; i < 4; i++) {
    if (rep.kind === 'authority_required' && rep.requirement && rep.delegator && rep.delegate) {
      const caveats: Caveat[] = [...capabilityHandler.toCaveats(rep.requirement, ENF as never), buildDigestBindingCaveat(ENF.digestBinding as Address, 'intent', rep.requirement.intentDigest as Hex)];
      let salt = 0n; for (const b of randomBytes(16)) salt = (salt << 8n) | BigInt(b);
      const mandate: Delegation = { delegator: rep.delegator, delegate: rep.delegate, authority: ROOT_AUTHORITY, caveats, salt, signature: '0x' };
      const a = await post(who, '/harness/authorize', { delegator: rep.delegator, digests: [hashDelegation(mandate, C.chainId, DM), ...(rep.alsoApprove ?? []).map((x) => x.digest)] });
      if (a.ok !== true) fail(`authorize build: ${JSON.stringify(a).slice(0, 300)}`);
      const b2 = await post(who, '/harness/authorize', { delegator: rep.delegator, userOp: a.userOp, signature: await who.signDigest(a.userOpHash as Hex) });
      if (b2.ok !== true) fail(`authorize submit: ${JSON.stringify(b2).slice(0, 300)}`);
      mandate.signature = '0x03';
      r = await post(who, '/harness/ask', { addressee: who.agent, runRef: rep.runRef, presented: { ...mandate, salt: salt.toString() } });
      rep = (r.reply ?? {}) as Reply; continue;
    }
    if (rep.kind === 'prompt' && rep.prompt?.kind === 'signature' && rep.prompt.digest) {
      const p = rep.prompt;
      r = await post(who, '/harness/ask', { addressee: who.agent, runRef: rep.runRef, supplied: [{ stepRef: rep.resumeToken ?? p.stepRef, signature: { digest: p.digest, signer: p.signer ?? who.agent, signature: await who.signDigest(p.digest), ...(p.payload !== undefined ? { payload: p.payload } : {}) } }] });
      rep = (r.reply ?? {}) as Reply; continue;
    }
    break;
  }
  return rep;
}
const resultOf = (rep: Reply, toolId: string): Record<string, unknown> => ((rep.results?.find((x) => x.toolId === toolId)?.result ?? rep.result ?? {}) as Record<string, unknown>);
type View = { friends?: Array<{ agent: string; type: string }>; requests?: Array<{ agent: string }>; requested?: Array<{ agent: string }>; ended?: Array<{ agent: string }> };
const friendsOf = async (who: Person): Promise<View> => resultOf(await act(who, 'who are my friends', 'person.friend.list', {}), 'person.friend.list') as View;
const has = (rows: Array<{ agent: string }> | undefined, sa: string) => (rows ?? []).some((r) => r.agent.toLowerCase() === sa.toLowerCase());
const ok = (rep: Reply) => rep.kind === 'done' || rep.kind === 'answer';

const her = await personaCustodian(HOME, fx.people.steward);
const him = await personaCustodian(HOME, fx.people.member);
const sheSa = her.agent.toLowerCase(); const heSa = him.agent.toLowerCase();
console.log(`── ${fx.people.steward} ${sheSa} · ${fx.people.member} ${heSa} ──`);

// A clean start: each withdraws a standing offer to the other from an earlier run.
for (const [who, other, name] of [[her, heSa, fx.people.member], [him, sheSa, fx.people.steward]] as const) {
  const v = await friendsOf(who);
  if (has(v.friends, other) || has(v.requested, other) || has(v.ended, other)) {
    const rm = await act(who, `remove ${name} as a friend`, 'person.friend.remove', { friend: other });
    console.log(`  (withdrew a standing offer from an earlier run → ${rm.kind}${rm.error ? ` ${rm.error}` : ''})`);
    if (!ok(rm)) fail('a standing offer from an earlier run could not be withdrawn');
  }
}

// 1. her half: a request, not a friendship
const offered = await act(her, `add ${fx.people.member} as a friend (family)`, 'person.friend.add', { friend: heSa, type: 'family' });
const or = resultOf(offered, 'person.friend.add') as { added?: boolean; type?: string; friends?: boolean };
console.log(`  ${fx.people.steward} offers → ${offered.kind}: added=${or.added} type=${or.type} friends=${or.friends}`);
if (!ok(offered) || or.added !== true || or.type !== 'family' || or.friends !== false) fail(`her offer was not recorded as a request: ${JSON.stringify(offered).slice(0, 400)}`);
if (!has((await friendsOf(her)).requested, heSa)) fail('her list does not show the request she sent');
if (!has((await friendsOf(him)).requests, sheSa)) fail('his list does not show her request');

// twins: an organization, a service
const orgSa = String((await j(await fetch(`${HOME}/connect/name-info?name=${encodeURIComponent(fx.org.handle)}`))).agent ?? '').toLowerCase();
const orgTry = await act(her, `add ${fx.org.handle} as a friend`, 'person.friend.add', { friend: orgSa });
console.log(`  twin · an organization as a friend → ${orgTry.kind}: ${String(orgTry.error ?? orgTry.text ?? '').slice(0, 100)}`);
if (ok(orgTry) && (resultOf(orgTry, 'person.friend.add') as { added?: boolean }).added) fail('an organization was added as a friend');
if (fx.acpRuntime?.member) {
  const svcTry = await act(her, `add ${fx.acpRuntime.member} as a friend`, 'person.friend.add', { friend: fx.acpRuntime.member });
  console.log(`  twin · a service as a friend → ${svcTry.kind}: ${String(svcTry.error ?? svcTry.text ?? '').slice(0, 100)}`);
  if (ok(svcTry) && (resultOf(svcTry, 'person.friend.add') as { added?: boolean }).added) fail('a service was added as a friend');
}

// 2. his half: accepting makes it a friendship, on both sides
const accepted = await act(him, `accept ${fx.people.steward}'s friend request`, 'person.friend.add', { friend: sheSa });
const ar = resultOf(accepted, 'person.friend.add') as { added?: boolean; friends?: boolean };
console.log(`  ${fx.people.member} accepts → ${accepted.kind}: friends=${ar.friends}`);
if (!ok(accepted) || ar.friends !== true) fail(`accepting did not make them friends: ${JSON.stringify(accepted).slice(0, 400)}`);
const hersNow = await friendsOf(her);
if (!(hersNow.friends ?? []).some((f) => f.agent.toLowerCase() === heSa && f.type === 'family')) fail('she does not list him as a friend (family)');
if (!has((await friendsOf(him)).friends, sheSa)) fail('he does not list her as a friend');

// 3. he ends it: his grant revoked on chain; she sees ENDED
const removed = await act(him, `remove ${fx.people.steward} as a friend`, 'person.friend.remove', { friend: sheSa });
const rr = resultOf(removed, 'person.friend.remove') as { removed?: boolean; txHash?: string };
console.log(`  ${fx.people.member} removes her → ${removed.kind}: removed=${rr.removed} tx=${rr.txHash ?? '—'}`);
if (!ok(removed) || rr.removed !== true || !rr.txHash) fail(`his removal did not revoke on chain: ${JSON.stringify(removed).slice(0, 400)}`);
const afterHis = await friendsOf(her);
if (has(afterHis.friends, heSa)) fail('she still lists him as a friend after he removed her');
if (!has(afterHis.ended, heSa)) fail('she is not shown that he removed her');

// 4. she withdraws her half too
const hersGone = await act(her, `remove ${fx.people.member} as a friend`, 'person.friend.remove', { friend: heSa });
if (!ok(hersGone) || (resultOf(hersGone, 'person.friend.remove') as { removed?: boolean }).removed !== true) fail('she could not withdraw her half');
const last = await friendsOf(her);
if (has(last.friends, heSa) || has(last.ended, heSa) || has(last.requested, heSa)) fail('nothing should stand between them now');

console.log(`\n✓ spec 401 §10: ${fx.people.steward} offered friendship (a request until accepted), ${fx.people.member} accepted (friends, typed by each), an organization${fx.acpRuntime?.member ? ' and a service were' : ' was'} refused, he removed her (revoked on chain) and she saw it ENDED, then withdrew her own half.`);
