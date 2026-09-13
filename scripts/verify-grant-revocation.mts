/**
 * Spec 338 §7 — a grant you cannot take back is one you should think harder about giving.
 *
 *   npx tsx scripts/verify-grant-revocation.mts
 *
 * Grants Nathan a way to reach one of Alice's treasuries, shows it working, withdraws it, and shows it
 * stop — without touching the record he holds. That is the point: revocation is the ISSUER's, and it
 * takes effect where the grant is USED, not where it is stored.
 */
import { fixture as fx, HOME } from './fixture.mts';
const NATHAN = '0x1dba4a27c53d7babda99513080223fb3bfc4bad1';
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 200), _status: r.status }; } };
let bad = 0;
const check = (label: string, ok: boolean, detail: string) => { console.log(`  ${ok ? '✓' : '✗'} ${label} — ${detail}`); if (!ok) bad++; };

const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
const csrf = (await j(csrfRes)) as { token?: string };
const cookie = (csrfRes.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
const H = { 'content-type': 'application/json', origin: HOME, cookie, 'x-csrf-token': csrf.token ?? '' };
const alice = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: fx.people.steward, client_id: 'demo-jp' }) })) as { homeSession: string };
const nathan = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: fx.people.payeeOwner, client_id: 'demo-jp' }) })) as { homeSession: string };

const orgs = ((await j(await fetch(`${HOME}/connect/related-orgs`, { headers: { authorization: `Bearer ${alice.homeSession}` } }))) as { orgs?: Array<{ orgAgent: string; orgName?: string; kind?: string }> }).orgs ?? [];
const target = orgs.find((o) => o.kind === 'person-treasury' && !String(o.orgName ?? '').includes('.'))?.orgAgent
  ?? orgs.find((o) => o.kind === 'person-treasury')!.orgAgent;
console.log(`── alice grants, then withdraws, a way to reach ${target} ──`);

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
