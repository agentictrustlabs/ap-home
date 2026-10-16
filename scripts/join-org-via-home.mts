/**
 * JOIN AN ORGANIZATION AS A PERSONA — the Join chip's ceremony (apps/home/src/home/join-organization.ts), headless, signed by
 * the persona's own Home (`/connect/persona-sign`). For a demo persona whose agent's `organization.membership.accept` step
 * parked on the `org-join` confirmation: run this, then resume or re-ask and the agent reads her records back.
 *
 *   HOME_URL=https://www.impact-agent.me NEXT_PUBLIC_CHAIN_ID=34349 NEXT_PUBLIC_CONTRACTS_JSON="$(cat …/deployments-hopechain.json)" \
 *     npx tsx scripts/join-org-via-home.mts <handle> <org-address> [display name]
 *
 * Nothing signs for anyone but the member. Community messaging provisioning (the chip's last, non-fatal step) is not run.
 */
import type { Address } from '@agenticprimitives/types';

const HOME = (process.env.HOME_URL ?? 'https://www.faithnet.me').replace(/\/$/, '');
const [handle, orgArg, nameArg] = process.argv.slice(2);
if (!handle || !/^0x[0-9a-fA-F]{40}$/.test(orgArg ?? '')) throw new Error('usage: join-org-via-home.mts <handle> <org-address> [display name]');
// The ceremony's modules call the Home by relative path, as the browser does; give them the Home's origin.
const realFetch = globalThis.fetch;
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => realFetch(typeof input === 'string' && input.startsWith('/') ? `${HOME}${input}` : input, init)) as typeof fetch;
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 200), _status: r.status }; } };

const { issueDirectoryListing } = await import('../apps/home/src/home/directory');
const { recordOrgMembership } = await import('../apps/home/src/lib/org-membership');
// The ceremony's countersignature (spec 410 §8) reads the CSRF cookie through `document`, which a script has none of; it
// is best-effort there and is done explicitly below, with the same request the browser makes.
const countersign = async (offer: { digest: string; subject?: string; object?: string }): Promise<string> => {
  const c = await realFetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
  const token = ((await j(c)) as { token?: string }).token ?? '';
  const cookie = (c.headers.get('set-cookie') ?? '').split(';')[0];
  const subjectSignature = await sign(offer.digest as `0x${string}`);
  const out = await j(await realFetch(`${HOME}/a2a/relationships/credential/accept`, { method: 'POST', headers: { 'content-type': 'application/json', origin: HOME, cookie, 'x-csrf-token': token }, body: JSON.stringify({ session: si.homeSession, offer, subjectSignature }) }));
  return JSON.stringify(out).slice(0, 200);
};

const si = await j(await realFetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle, client_id: 'demo-web' }) }));
if (!si.homeSession) throw new Error(`no session for ${handle}: ${JSON.stringify(si).slice(0, 160)}`);
const member = String(si.agent).toLowerCase() as Address;
const org = orgArg!.toLowerCase();
const sign = async (digest: `0x${string}`): Promise<`0x${string}`> => { const b = await j(await realFetch(`${HOME}/connect/persona-sign`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${si.homeSession}` }, body: JSON.stringify({ digest }) })); if (!b.signature) throw new Error(`persona-sign: ${JSON.stringify(b).slice(0, 160)}`); return b.signature; };
const displayName = nameArg ?? String(si.name ?? handle);

const listing = await issueDirectoryListing(member, sign as never, { communityId: org, displayName });
const pub = await j(await realFetch(`${HOME}/connect/directory`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${si.homeSession}` }, body: JSON.stringify({ action: 'publish', listing }) }));
console.log('directory listing →', JSON.stringify(pub).slice(0, 200));
if (pub.ok !== true) process.exit(1);
// The organization's side of the membership credential: OFFER_JSON (the invite act's `relationshipOffer`) when given.
const offer = process.env.OFFER_JSON ? JSON.parse(process.env.OFFER_JSON) : null;
const role = await recordOrgMembership(member, org, sign as never, si.homeSession, null, displayName);
if (offer) console.log('membership credential countersigned →', await countersign(offer));
console.log(`${handle} ${member} joined ${org}${role ? ` as ${JSON.stringify(role).slice(0, 160)}` : ''}`);
