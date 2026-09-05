/**
 * Spec 338 §7 — a grant you cannot take back is one you should think harder about giving.
 *
 *   npx tsx scripts/verify-grant-revocation.mts
 *
 * Grants Nathan a way to reach one of Alice's treasuries, shows it working, withdraws it, and shows it
 * stop — without touching the record he holds. That is the point: revocation is the ISSUER's, and it
 * takes effect where the grant is USED, not where it is stored.
 */
const HOME = 'https://www.faithnet.me';
const NATHAN = '0x1dba4a27c53d7babda99513080223fb3bfc4bad1';
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 200), _status: r.status }; } };
let bad = 0;
const check = (label: string, ok: boolean, detail: string) => { console.log(`  ${ok ? '✓' : '✗'} ${label} — ${detail}`); if (!ok) bad++; };

const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
const csrf = (await j(csrfRes)) as { token?: string };
const cookie = (csrfRes.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
const H = { 'content-type': 'application/json', origin: HOME, cookie, 'x-csrf-token': csrf.token ?? '' };
const alice = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: 'alice', client_id: 'demo-jp' }) })) as { homeSession: string };
const nathan = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: 'nathan', client_id: 'demo-jp' }) })) as { homeSession: string };

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

/** Can Nathan reach it? Asked of the agent, which is the only side that decides. */
const reachable = async (): Promise<boolean> => {
  const caps = ((await j(await fetch(`${HOME}/a2a/harness/vocabulary`))) as { capabilities: Array<{ id: string }> }).capabilities.map((c) => c.id);
  const t = await j(await fetch(`${HOME}/a2a/harness/ask`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ session: nathan.homeSession, addressee: NATHAN, message: 'send 1 usdc to alice', surface: { ceremonies: ['data', 'confirmation', 'signature'], capabilities: caps }, runRef: `rev-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}` }),
  })) as { reply?: { prompt?: { fields?: Array<{ choices?: Array<{ value: string }> }> }; parties?: Array<{ agent: string }> } };
  const r = t.reply ?? {};
  const offered = (r.prompt?.fields?.[0]?.choices ?? []).map((c) => c.value.toLowerCase());
  const chosen = (r.parties ?? []).map((p) => p.agent.toLowerCase());
  return [...offered, ...chosen].includes(target.toLowerCase());
};

check('nathan can reach it while the grant stands', await reachable(), target);

const revoked = await j(await fetch(`${HOME}/a2a/resolution/revoke`, { method: 'POST', headers: H, body: JSON.stringify({ session: alice.homeSession, grantId: issued.grantId }) })) as { ok?: boolean; error?: string };
check('alice withdraws it', revoked.ok === true, revoked.error ?? issued.grantId ?? '');

// The record is still in his vault — revocation does not reach in and delete it, and does not need to.
const stillHeld = (((await j(await fetch(`${HOME}/a2a/resolution/grants`, { headers: { authorization: `Bearer ${nathan.homeSession}` } }))) as { grants?: Array<{ grantId?: string }> }).grants ?? [])
  .some((g) => g.grantId === issued.grantId);
check('he still HOLDS the record — nothing reached into his vault', stillHeld, 'held');
check('and it no longer works', !(await reachable()), 'the treasury is not offered');

console.log(`\n${bad === 0 ? '✓' : '✗'} revocation: the issuer withdrew it and it stopped, without touching what the holder keeps — ${bad} failure(s).`);
if (bad) process.exit(1);
