/**
 * Spec 338 §7 — a grant you cannot take back is one you should think harder about giving.
 *
 *   npx tsx scripts/verify-grant-revocation.mts
 *
 * Grants Nathan a way to reach one of Alice's treasuries, shows it working, withdraws it, and shows it
 * stop — without touching the record he holds. That is the point: revocation is the ISSUER's, and it
 * takes effect where the grant is USED, not where it is stored.
 *
 * THE REQUEST COMES FIRST. A grant is the owner's ANSWER: the issuer's record of it is written onto the holder's
 * request row (`internal.resolution.approve` updates the row it finds and nothing else), so with no request there is
 * nothing to approve and the "issued" grant resolves nothing. Faithnet carried nathan's request from an earlier day;
 * another estate does not — so the holder asks first, through his own agent (`resolution.invitation.request`, a
 * supplied plan, his mandate signed at his Home when the runtime asks for one).
 */
import { randomBytes } from 'node:crypto';
import type { Address, Hex } from 'viem';
import { buildDigestBindingCaveat, capabilityHandler, hashDelegation, ROOT_AUTHORITY, type Caveat, type Delegation, type MandateRequirementV1 } from '@agenticprimitives/delegation';
import { fixture as fx, HOME } from './fixture.mts';
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 200), _status: r.status }; } };
let bad = 0;
const check = (label: string, ok: boolean, detail: string) => { console.log(`  ${ok ? '✓' : '✗'} ${label} — ${detail}`); if (!ok) bad++; };

const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
const csrf = (await j(csrfRes)) as { token?: string };
const cookie = (csrfRes.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
const H = { 'content-type': 'application/json', origin: HOME, cookie, 'x-csrf-token': csrf.token ?? '' };
const alice = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: fx.people.steward, client_id: 'demo-jp' }) })) as { homeSession: string };
const nathan = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: fx.people.payeeOwner, client_id: 'demo-jp' }) })) as { homeSession: string; agent?: string };
const NATHAN = String(nathan.agent ?? '').toLowerCase();   // the holder — the fixture's payee owner
if (!/^0x[0-9a-f]{40}$/.test(NATHAN)) { console.error(`✗ ${fx.people.payeeOwner} could not sign in`); process.exit(1); }

const orgs = ((await j(await fetch(`${HOME}/connect/related-orgs`, { headers: { authorization: `Bearer ${alice.homeSession}` } }))) as { orgs?: Array<{ orgAgent: string; orgName?: string; kind?: string }> }).orgs ?? [];
const target = orgs.find((o) => o.kind === 'person-treasury' && !String(o.orgName ?? '').includes('.'))?.orgAgent
  ?? orgs.find((o) => o.kind === 'person-treasury')!.orgAgent;
console.log(`── ${fx.people.steward} grants, then withdraws, a way to reach ${target} ──`);

// 0. the holder ASKS for a way to reach a treasury of hers — the row her answer will be written onto
{
  const C = ((await import(`@agenticprimitives/contracts/deployments/${process.env.CHAIN_NAME ?? 'faithchain'}`)) as { CONTRACTS: Record<string, string> & { chainId: number } }).CONTRACTS;
  const ENF = { delegationManager: C.delegationManager, timestamp: C.timestampEnforcer, allowedTargets: C.allowedTargetsEnforcer, allowedMethods: C.allowedMethodsEnforcer, value: C.valueEnforcer, payment: C.paymentEnforcer, digestBinding: C.digestBindingEnforcer } as const;
  const ask = async (body: Record<string, unknown>) => j(await fetch(`${HOME}/a2a/harness/ask`, { method: 'POST', headers: H, body: JSON.stringify({ session: nathan.homeSession, addressee: NATHAN, ...body }) })) as { reply?: { kind?: string; error?: string; runRef?: string; requirement?: MandateRequirementV1; delegator?: Address; delegate?: Address; alsoApprove?: Array<{ digest: Hex }> } };
  let r = await ask({ message: `ask ${fx.people.steward}.me for a way to reach a treasury of theirs (revocation gate ${Date.now().toString(36)})`, plan: { steps: [{ toolId: 'resolution.invitation.request', args: { owner: `${fx.people.steward}.me`, wants: 'treasury', purpose: 'the revocation gate' } }] } });
  let rep = r.reply;
  if (rep?.kind === 'authority_required' && rep.requirement && rep.delegator && rep.delegate) {
    const caveats: Caveat[] = [...capabilityHandler.toCaveats(rep.requirement, ENF as never), buildDigestBindingCaveat(ENF.digestBinding as Address, 'intent', rep.requirement.intentDigest as Hex)];
    let salt = 0n; for (const b of randomBytes(16)) salt = (salt << 8n) | BigInt(b);
    const mandate: Delegation = { delegator: rep.delegator, delegate: rep.delegate, authority: ROOT_AUTHORITY, caveats, salt, signature: '0x' };
    const authorize = async (body: Record<string, unknown>) => j(await fetch(`${HOME}/a2a/harness/authorize`, { method: 'POST', headers: H, body: JSON.stringify({ session: nathan.homeSession, delegator: rep!.delegator, ...body }) }));
    const a = await authorize({ digests: [hashDelegation(mandate, C.chainId, C.delegationManager as Address), ...(rep.alsoApprove ?? []).map((x) => x.digest)] });
    const sig = await j(await fetch(`${HOME}/connect/persona-sign`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${nathan.homeSession}` }, body: JSON.stringify({ digest: a.userOpHash }) })) as { signature?: Hex };
    const b2 = await authorize({ userOp: a.userOp, signature: sig.signature });
    if (b2.ok !== true) { console.error(`✗ the holder's mandate for the request was not accepted: ${JSON.stringify(b2).slice(0, 200)}`); process.exit(1); }
    mandate.signature = '0x03';
    r = await ask({ runRef: rep.runRef, presented: { ...mandate, salt: salt.toString() } });
    rep = r.reply;
  }
  console.log(`  the holder asked for a way to reach her treasury → ${rep?.kind}${rep?.error ? ` ${rep.error}` : ''}`);
  if (rep?.kind !== 'done' && rep?.kind !== 'answer') { console.error(`✗ the request did not land: ${JSON.stringify(r).slice(0, 300)}`); process.exit(1); }
}

const post = async (payload: unknown) => j(await fetch(`${HOME}/a2a/resolution/grant`, { method: 'POST', headers: H, body: JSON.stringify(payload) }));
const base = { session: alice.homeSession, requester: NATHAN, targetAgent: target, wants: 'treasury' };
const prep = await post({ ...base, prepare: true }) as { ok?: boolean; grant?: Record<string, unknown>; digest?: string };
const sig = await j(await fetch(`${HOME}/connect/persona-sign`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.homeSession}` }, body: JSON.stringify({ digest: prep.digest }) })) as { signature?: string };
if (!sig.signature) console.log('  persona-sign said:', JSON.stringify(sig).slice(0, 200), '| prepare ok:', prep.ok, 'digest:', String(prep.digest ?? '').slice(0, 14));
const issued = await post({ ...base, grant: prep.grant, signature: sig.signature }) as { ok?: boolean; grantId?: string; error?: string };
check('the grant is issued, signed by her', issued.ok === true, issued.grantId ?? issued.error ?? '');

/** Can Nathan reach it? Asked of the RESOLVER, which is the only side that decides (spec 338 §7): the grant is
 *  presented where it is used, and the answer is the target or the refusal. (It used to be asked through "send 1
 *  usdc to alice" — but "alice" is decided by the household rule (spec 368, `payment.recipient`) to her MARKED
 *  account, so a nameless treasury she granted a way to is correctly never the answer to that word. Reachability is
 *  resolution, never selection.) */
const owner = String(prep.grant?.issuer ?? '').match(/0x[0-9a-fA-F]{40}$/)?.[0] ?? '';
const resolve = async () => j(await fetch(`${HOME}/a2a/resolution/resolve`, { method: 'POST', headers: H, body: JSON.stringify({ session: nathan.homeSession, owner, grantId: issued.grantId }) })) as { ok?: boolean; targetAgent?: string; error?: string };
const standing = await resolve();
check('nathan can reach it while the grant stands', standing.ok === true && String(standing.targetAgent ?? '').toLowerCase() === target.toLowerCase(), standing.ok ? String(standing.targetAgent) : `refused: ${standing.error}`);

const revoked = await j(await fetch(`${HOME}/a2a/resolution/revoke`, { method: 'POST', headers: H, body: JSON.stringify({ session: alice.homeSession, grantId: issued.grantId }) })) as { ok?: boolean; error?: string };
check('alice withdraws it', revoked.ok === true, revoked.error ?? issued.grantId ?? '');

// The record is still in his vault — revocation does not reach in and delete it, and does not need to.
const stillHeld = (((await j(await fetch(`${HOME}/a2a/resolution/grants`, { headers: { authorization: `Bearer ${nathan.homeSession}` } }))) as { grants?: Array<{ grantId?: string }> }).grants ?? [])
  .some((g) => g.grantId === issued.grantId);
check('he still HOLDS the record — nothing reached into his vault', stillHeld, 'held');
const after = await resolve();
check('and it no longer works', after.ok === false && /withdrawn/.test(String(after.error)), after.ok ? `STILL RESOLVES to ${after.targetAgent}` : String(after.error));

console.log(`\n${bad === 0 ? '✓' : '✗'} revocation: the issuer withdrew it and it stopped, without touching what the holder keeps — ${bad} failure(s).`);
if (bad) process.exit(1);
