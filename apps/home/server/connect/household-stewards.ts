// /connect/household-stewards — a household's stewards and members as Home knows them, and the steward invitation
// (src/lib/household-steward-invitation.ts says what it is and why).
//
//   GET  ?org=<household>                         a steward or member: the roster (each steward's household grant
//                                                 re-verified on chain on this read) + the steward invitations;
//                                                 an invitee with a pending invitation: their own invitation only.
//   POST { action: 'invite', org, invitee, label?, delegation }   a steward, from Home's approval page
//   POST { action: 'accept', org }                                the invitee, from their own Home
//   POST { action: 'cancel', org, invitee }                       a steward; a pending invitation only
//
// READ with a Home session OR a registered app's id_token (an app reads who may decide). WRITE with a Home session
// only: an app can neither invite nor accept — those are the two people's own acts at their own Homes.
//
// A steward who reads the roster and is not on it yet is recorded on it (their grant verified first): that is how the
// household's founder — whose grant lives only on their own link — appears to the second steward.
import type { FnContext } from '../_lib/server-broker';
import { personFromBearer } from '../_lib/person-bearer';
import { verifyStewardship } from '../_lib/verify-stewardship';
import { verifyDelegation, type IncomingDelegation } from '../_lib/verify-delegation';
import { mergeRelationshipEntry } from '../lib/relationships-doc';
import {
  KEYS, StewardInvitationError, accept, assembleRoster, cancel, invite, isAgent, viewOf, withSteward,
  type StewardEntry, type StewardInvitation, type Verify,
} from '../../src/lib/household-steward-invitation';

const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, authorization' };
const json = (b: unknown, s = 200): Response => new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...cors } });
const refusal = (code: string, error: string, status: number) => json({ ok: false, code, error }, status);

export const onRequestOptions = async (): Promise<Response> => new Response(null, { status: 204, headers: cors });

type Env = FnContext['env'];
/** Seams for tests. Production passes none. */
export interface Deps { verify?: Verify; verifyMember?: (grant: IncomingDelegation) => Promise<boolean>; now?: () => number; merge?: typeof mergeRelationshipEntry }

const getJson = async <T,>(env: Env, key: string, dflt: T): Promise<T> => {
  const raw = await env.AUTH_CODES.get(key);
  if (!raw) return dflt;
  try { return JSON.parse(raw) as T; } catch { return dflt; }
};
const verifierOf = (env: Env, deps: Deps): Verify => deps.verify ?? ((org, person, wire) => verifyStewardship(env, org, person, wire as IncomingDelegation));

/** The caller's own standing, from their link: a household grant that verifies is a steward; a member link, or a row
 *  in the household's member index, is a member. */
async function standingOf(env: Env, person: string, org: string, verify: Verify, verifyMember?: (grant: IncomingDelegation) => Promise<boolean>): Promise<{ you: 'steward' | 'member' | null; wire: unknown }> {
  const link = await getJson<{ relationship?: string; stewardshipDelegation?: unknown; memberAccessDelegation?: IncomingDelegation | null; status?: string } | null>(env, `related:${person}:${org}`, null);
  if (link?.stewardshipDelegation && (await verify(org, person, link.stewardshipDelegation).catch(() => false))) return { you: 'steward', wire: link.stewardshipDelegation };
  // MEMBERSHIP IS THE HOUSEHOLD'S GRANT, NOT THE PERSON'S OWN NOTE (spec 445 RUNC-2). A person can write their own
  // `related:` link (relationship 'member') and can append themselves to `delegated-idx:<org>` with a delegation THEY
  // signed — so neither proves the household admitted them, and either would let anyone read any household's roster.
  // A member is someone holding a member-access grant the HOUSEHOLD signed to them (ERC-1271 by the household, in its
  // time window), exactly as the steward above holds the household's stewardship grant.
  const mad = link?.memberAccessDelegation;
  if (mad && (!link?.status || link.status === 'active')
      && String(mad.delegator ?? '').toLowerCase() === org && String(mad.delegate ?? '').toLowerCase() === person
      && (await (verifyMember ?? ((g: IncomingDelegation) => verifyMemberGrant(env, g)))(mad).catch(() => false))) return { you: 'member', wire: null };
  return { you: null, wire: null };
}
async function verifyMemberGrant(env: Env, grant: IncomingDelegation): Promise<boolean> {
  try { return (await verifyDelegation(env as { RPC_URL?: string }, grant)).ok; } catch { return false; }
}
async function invitationsOf(env: Env, org: string): Promise<StewardInvitation[]> {
  const idx = await getJson<string[]>(env, KEYS.invites(org), []);
  const rows = await Promise.all(idx.map((invitee) => getJson<StewardInvitation | null>(env, KEYS.invite(org, invitee), null)));
  return rows.filter((r): r is StewardInvitation => !!r);
}
async function putInvitation(env: Env, inv: StewardInvitation): Promise<void> {
  await env.AUTH_CODES.put(KEYS.invite(inv.org, inv.invitee), JSON.stringify(inv));
  const idx = await getJson<string[]>(env, KEYS.invites(inv.org), []);
  if (!idx.includes(inv.invitee)) await env.AUTH_CODES.put(KEYS.invites(inv.org), JSON.stringify([...idx, inv.invitee]));
}
async function addToRoster(env: Env, org: string, entry: StewardEntry): Promise<void> {
  const list = await getJson<StewardEntry[]>(env, KEYS.roster(org), []);
  const next = withSteward(list, entry);
  if (next !== list) await env.AUTH_CODES.put(KEYS.roster(org), JSON.stringify(next));
}

export async function handleGet({ request, env }: FnContext, deps: Deps = {}): Promise<Response> {
  const who = await personFromBearer(request, env);
  if (!who) return refusal('sign_in_required', 'Sign in with Home first.', 401);
  const org = (new URL(request.url).searchParams.get('org') ?? '').toLowerCase();
  if (!isAgent(org)) return refusal('invalid_request', 'org (the household agent address) is required.', 400);
  const verify = verifierOf(env, deps);
  const now = deps.now?.() ?? Date.now();
  const mine = await standingOf(env, who.person, org, verify, deps.verifyMember);
  if (!mine.you) {
    const own = await getJson<StewardInvitation | null>(env, KEYS.invite(org, who.person), null);
    if (own && own.state === 'pending') return json({ ok: true, org, you: 'invited', people: [], lapsed: [], invitations: [viewOf(own)] });
    return refusal('not_in_household', 'Home does not list you as a steward or member of that household.', 403);
  }
  if (mine.you === 'steward') await addToRoster(env, org, { agent: who.person, delegation: mine.wire as StewardEntry['delegation'], since: now, via: 'founder' });
  const stewards = await getJson<StewardEntry[]>(env, KEYS.roster(org), []);
  const members = (await getJson<Array<{ orgAgent?: string }>>(env, `delegated-idx:${org}`, [])).map((m) => String(m.orgAgent ?? ''));
  if (mine.you === 'member' && !members.some((m) => m.toLowerCase() === who.person)) members.push(who.person);
  const roster = await assembleRoster({ org, you: mine.you, stewards, members, invitations: await invitationsOf(env, org), verify });
  return json({ ok: true, ...roster });
}

export async function handlePost({ request, env }: FnContext, deps: Deps = {}): Promise<Response> {
  const who = await personFromBearer(request, env);
  if (!who) return refusal('sign_in_required', 'Sign in with Home first.', 401);
  if (who.via !== 'session') return refusal('session_required', 'Steward invitations are approved and accepted at Home, in your own Home session.', 403);
  const body = (await request.json().catch(() => null)) as { action?: string; org?: string; invitee?: string; label?: string; delegation?: unknown } | null;
  const org = String(body?.org ?? '').toLowerCase();
  if (!isAgent(org)) return refusal('invalid_request', 'org (the household agent address) is required.', 400);
  const verify = verifierOf(env, deps);
  const now = deps.now?.() ?? Date.now();
  try {
    if (body?.action === 'invite') {
      const mine = await standingOf(env, who.person, org, verify, deps.verifyMember);
      const invitee = String(body.invitee ?? '').toLowerCase();
      const roster = await getJson<StewardEntry[]>(env, KEYS.roster(org), []);
      const onRoster = roster.find((s) => s.agent === invitee);
      const inviteeLink = isAgent(invitee) ? await getJson<{ stewardshipDelegation?: unknown } | null>(env, `related:${invitee}:${org}`, null) : null;
      const alreadySteward = (!!onRoster && (await verify(org, invitee, onRoster.delegation).catch(() => false)))
        || (!!inviteeLink?.stewardshipDelegation && (await verify(org, invitee, inviteeLink.stewardshipDelegation).catch(() => false)));
      const existing = isAgent(invitee) ? await getJson<StewardInvitation | null>(env, KEYS.invite(org, invitee), null) : null;
      const inv = await invite({ org, caller: who.person, invitee, label: body.label, delegation: body.delegation, callerIsSteward: mine.you === 'steward', alreadySteward, existing: existing?.state === 'accepted' && !alreadySteward ? null : existing, now, verify });
      if (mine.you === 'steward') await addToRoster(env, org, { agent: who.person, delegation: mine.wire as StewardEntry['delegation'], since: now, via: 'founder' });
      await putInvitation(env, inv);
      return json({ ok: true, invitation: viewOf(inv) });
    }
    if (body?.action === 'accept') {
      const invitation = await getJson<StewardInvitation | null>(env, KEYS.invite(org, who.person), null);
      const done = await accept({ caller: who.person, invitation, now, verify });
      // THE LINK BECOMES A STEWARD'S. This is the one place a stored `member` is promoted: the household's grant to this
      // person was just verified on chain, which is exactly what stewardship is (the word follows the wire).
      const key = `related:${who.person}:${org}`;
      const existing = await getJson<Record<string, unknown>>(env, key, {});
      const link = {
        ...existing,
        orgAgent: org,
        orgName: (existing.orgName as string) || done.label,
        purpose: (existing.purpose as string) ?? 'household-steward-invitation',
        requestedBy: (existing.requestedBy as string) ?? '',
        siteDelegation: existing.siteDelegation ?? null,
        proofHash: existing.proofHash ?? null,
        kind: (existing.kind as string) ?? 'household',
        parent: (existing.parent as string) ?? who.person,
        relationship: 'steward',
        stewardshipDelegation: done.delegation,
        createdAt: (existing.createdAt as number) ?? now,
      };
      await env.AUTH_CODES.put(key, JSON.stringify(link));
      const idx = await getJson<string[]>(env, `related-idx:${who.person}`, []);
      if (!idx.some((a) => a.toLowerCase() === org)) await env.AUTH_CODES.put(`related-idx:${who.person}`, JSON.stringify([...idx, org]));
      // the person's authoritative relationships doc (what their agent's standing check reads); best-effort as elsewhere
      await (deps.merge ?? mergeRelationshipEntry)(env, who.person, who.token, { org, relationship: 'steward', orgName: String(link.orgName), kind: String(link.kind), parent: String(link.parent), delegations: [done.delegation] });
      await addToRoster(env, org, { agent: who.person, delegation: done.delegation, since: now, via: 'invitation' });
      if (done !== invitation) await putInvitation(env, done);
      return json({ ok: true, relationship: 'steward', invitation: viewOf(done) });
    }
    if (body?.action === 'cancel') {
      const mine = await standingOf(env, who.person, org, verify, deps.verifyMember);
      const invitee = String(body.invitee ?? '').toLowerCase();
      const invitation = isAgent(invitee) ? await getJson<StewardInvitation | null>(env, KEYS.invite(org, invitee), null) : null;
      const out = cancel({ callerIsSteward: mine.you === 'steward', invitation, now });
      if (out !== invitation) await putInvitation(env, out);
      return json({ ok: true, invitation: viewOf(out) });
    }
    return refusal('invalid_request', 'action must be invite, accept or cancel.', 400);
  } catch (e) {
    if (e instanceof StewardInvitationError) return refusal(e.code, e.message, e.status);
    throw e;
  }
}

export const onRequestGet = (c: FnContext) => handleGet(c);
export const onRequestPost = (c: FnContext) => handlePost(c);
