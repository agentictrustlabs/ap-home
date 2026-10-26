/**
 * Spec 401 C1 — FRIENDSHIP BY EMAIL INVITATION, live (supplied plans; no model). The variant of verify-friends where
 * the inviter cannot name the invitee's agent when she sends.
 *
 *   npx tsx scripts/verify-friends-invitation.mts        (FIXTURE_JSON=… for another estate)
 *
 * The steward invites by email (to an `.invalid` address — nothing is delivered anywhere) and signs her half at once:
 * one grant to her own agent, kept beside the invitation. The member accepts with the token — his own add, nothing
 * more — and both list each other as friends: her half was completed by her agent from the grant she signed.
 * Then she removes him (her ROOT grant revoked on chain) and he sees ENDED.
 * THE TWINS: a forged signature keeps nothing; the same invitation accepted again completes nothing a second time.
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

// The runtime, through the Home's proxy — or straight (VIA_RUNTIME=1), for an estate whose proxy times out on-chain steps.
const RT = process.env.VIA_RUNTIME === '1' ? fx.a2a : `${HOME}/a2a`;
const csrfRes = await fetch(`${RT}/auth/csrf`, { headers: { origin: HOME } });
const csrf = (await j(csrfRes)) as { token?: string };
const H = { 'content-type': 'application/json', origin: HOME, cookie: (csrfRes.headers.get('set-cookie') ?? '').split(';')[0] ?? '', 'x-csrf-token': csrf.token ?? '' };
const post = async (who: Person, path: string, body: unknown) => j(await fetch(`${RT}${path}`, { method: 'POST', headers: H, body: JSON.stringify({ session: who.bearer, ...(body as object) }) }));
/** A call under the person's own bearer — the Home's routes and the runtime's session-gated ones. */
const asPerson = async (who: Person, url: string, body: unknown) => j(await fetch(url, { method: 'POST', headers: { ...H, authorization: `Bearer ${who.bearer}` }, body: JSON.stringify(body) }));

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
type View = { friends?: Array<{ agent: string }>; requests?: Array<{ agent: string }>; requested?: Array<{ agent: string }>; ended?: Array<{ agent: string }> };
const friendsOf = async (who: Person): Promise<View> => resultOf(await act(who, 'who are my friends', 'person.friend.list', {}), 'person.friend.list') as View;
const has = (rows: Array<{ agent: string }> | undefined, sa: string) => (rows ?? []).some((r) => r.agent.toLowerCase() === sa.toLowerCase());
const ok = (rep: Reply) => rep.kind === 'done' || rep.kind === 'answer';

const her = await personaCustodian(HOME, fx.people.steward);
const him = await personaCustodian(HOME, fx.people.member);
const sheSa = her.agent.toLowerCase(); const heSa = him.agent.toLowerCase();
console.log(`── ${fx.people.steward} ${sheSa} invites · ${fx.people.member} ${heSa} accepts ──`);

for (const [who, other, name] of [[her, heSa, fx.people.member], [him, sheSa, fx.people.steward]] as const) {
  const v = await friendsOf(who);
  if (has(v.friends, other) || has(v.requested, other) || has(v.ended, other)) {
    const rm = await act(who, `remove ${name} as a friend`, 'person.friend.remove', { friend: other });
    console.log(`  (withdrew a standing offer from an earlier run → ${rm.kind}${rm.error ? ` ${rm.error}` : ''})`);
    if (!ok(rm)) fail('a standing offer from an earlier run could not be withdrawn');
  }
}

// 1. she invites by email — an address that is never delivered to
const email = `friend-gate-${randomBytes(4).toString('hex')}@example.invalid`;
const sent = (await asPerson(her, `${HOME}/connect/friend-invite/email`, { email, fromName: fx.people.steward })) as { ok?: boolean; token?: string; expiresAt?: string; error?: string };
if (!sent.ok || !sent.token || !sent.expiresAt) fail(`the invitation was not made: ${JSON.stringify(sent).slice(0, 300)}`);
const token = sent.token!; const expiresAt = Date.parse(sent.expiresAt!);
console.log(`  invitation made (${email})`);

// 2. her half, signed now: the grant to her own agent
const prepared = (await asPerson(her, `${RT}/friend-invitation/prepare`, { token, expiresAt })) as { ok?: boolean; digest?: Hex; grant?: { delegator: string; delegate: string }; error?: string };
if (!prepared.ok || !prepared.digest) fail(`her half could not be prepared: ${JSON.stringify(prepared).slice(0, 300)}`);
if (prepared.grant?.delegator.toLowerCase() !== sheSa) fail('the prepared grant is not hers');
const forged = (await asPerson(her, `${RT}/friend-invitation/offer`, { token, expiresAt, signature: await him.signDigest(prepared.digest!) })) as { ok?: boolean; error?: string };
console.log(`  twin · his signature on her half → ${forged.ok ? 'KEPT' : `refused: ${forged.error}`}`);
if (forged.ok) fail('a signature that is not hers was kept as her half');
const kept = (await asPerson(her, `${RT}/friend-invitation/offer`, { token, expiresAt, signature: await her.signDigest(prepared.digest!) })) as { ok?: boolean; status?: string; error?: string };
console.log(`  her half kept → ${kept.ok ? kept.status : `refused: ${kept.error}`}`);
if (!kept.ok || kept.status !== 'pending') fail(`her half was not kept: ${JSON.stringify(kept).slice(0, 300)}`);

// 3. he accepts with the token: his own add — and they are friends, on both sides
const accepted = await act(him, `accept ${fx.people.steward}'s invitation`, 'person.friend.add', { friend: sheSa, invitation: token });
const ar = resultOf(accepted, 'person.friend.add') as { added?: boolean; friends?: boolean; invitation?: { redeemed?: boolean; reason?: string } };
console.log(`  ${fx.people.member} accepts → ${accepted.kind}: friends=${ar.friends} invitation=${JSON.stringify(ar.invitation)}`);
if (!ok(accepted) || ar.friends !== true || ar.invitation?.redeemed !== true) fail(`accepting the invitation did not make them friends: ${JSON.stringify(accepted).slice(0, 500)}`);
if (!has((await friendsOf(her)).friends, heSa)) fail('she does not list him as a friend');
if (!has((await friendsOf(him)).friends, sheSa)) fail('he does not list her as a friend');

// twin: the same invitation again completes nothing a second time
const again = await act(him, `accept ${fx.people.steward}'s invitation`, 'person.friend.add', { friend: sheSa, invitation: token });
const gr = resultOf(again, 'person.friend.add') as { invitation?: { redeemed?: boolean; reason?: string } };
console.log(`  twin · accepted again → ${again.kind}: redeemed=${gr.invitation?.redeemed} (${gr.invitation?.reason})`);
if (!ok(again)) fail(`accepting again did not answer: ${JSON.stringify(again).slice(0, 400)}`);
if (gr.invitation?.redeemed !== false) fail(`the invitation was redeemed a second time: ${JSON.stringify(gr).slice(0, 400)}`);

// 4. she removes him: her ROOT grant revoked on chain; he sees ENDED
const removed = await act(her, `remove ${fx.people.member} as a friend`, 'person.friend.remove', { friend: heSa });
const rr = resultOf(removed, 'person.friend.remove') as { removed?: boolean; txHash?: string };
console.log(`  ${fx.people.steward} removes him → ${removed.kind}: removed=${rr.removed} tx=${rr.txHash ?? '—'}`);
if (!ok(removed) || rr.removed !== true || !rr.txHash) fail(`her removal did not revoke on chain: ${JSON.stringify(removed).slice(0, 400)}`);
if (!has((await friendsOf(him)).ended, sheSa)) fail('he is not shown that she removed him');
const his = await act(him, `remove ${fx.people.steward} as a friend`, 'person.friend.remove', { friend: sheSa });
if (!ok(his)) fail('he could not withdraw his half');
await asPerson(her, `${HOME}/connect/friend-invite/email`, { token, cancel: true }).catch(() => undefined);

console.log(`\n✓ spec 401 C1: ${fx.people.steward} invited by email and signed her half at once (a forged half refused); ${fx.people.member} accepted with the token and both were friends from his one act (single-use); her removal revoked her root grant on chain and he saw it ENDED.`);
