// FRIENDS — a friendship is TWO-WAY (spec 401 §10; owner, 2026-10-26). Each person keeps their own half: a friendship
// offer in their own vault naming the other, under a grant they signed (`friend:<sa>`, aporg:FriendshipOffer —
// friend-offers.ts). Neither half is a friendship on its own (the ontology's `friendshipState`):
//
//   mine + theirs, both standing  → FRIENDS (the type — friend · family · coach · other — is mine to give)
//   mine only                     → SENT (a request waiting on them)
//   theirs only                   → REQUEST (waiting on me; accepting is `person.friend.add` back)
//   mine standing, theirs removed → ENDED — they removed me. Shown, so it is never mistaken for a friendship; my half
//                                   is mine to remove (my grant, my signature), which the screen offers in one tap.
//
// THEIR half is read from their record naming me (one record each, bounded) — the same read "did they add me back"
// always made. A read that says nothing (unreachable, never written) falls back to the evidence in my own vault
// (their add notice, the `mutual` mark); only an explicit removal on their side ends a friendship.
//
// A friend is a PERSON. Runtimes, assistants and services are let in with the same grant mechanism, but they are not
// friends and are not listed here — the grants they hold are on Grants.
import type { ToolInvoker, ToolSpec } from '@agenticprimitives/orchestration';
import { kindOfName } from '@agenticprimitives/ontology/participant-vocabulary';
import { friendshipState } from '@agenticprimitives/ontology/participant-vocabulary';
import { offersOf, readOffer, whoOfferedMe, migrateLegacyOffers, FRIEND_TYPES, type FriendDeps, type FriendType } from './friend-offers.js';

/** What the friends view reads: the person's own records and names — a route can build this without the act deps. */
export type FriendsDeps = Pick<FriendDeps, 'survey' | 'readRecords' | 'readSubjectRecord' | 'nameOf'> & Partial<Pick<FriendDeps, 'writeSubjectRecord'>>;

export const FRIEND_LIST_CAPABILITY = 'person.friend.list' as const;

/** How many of the other halves one read checks (one record of theirs each). */
const OTHER_HALF_CHECK_MAX = 100;

export { FRIEND_TYPES, type FriendType };

export const FRIEND_LIST_TOOL: ToolSpec = {
  id: FRIEND_LIST_CAPABILITY,
  answers: ['my friends', 'who are my friends', 'friend requests', 'who added me', 'who has not added me back', 'pending friends', 'who removed me', 'who unfriended me'],
  description:
    'YOUR FRIENDS — two-way: people you added who added you back, each with the type you gave them (friend, family, '
    + 'coach, other). Plus REQUESTS (people who added you — accept with person.friend.add), SENT (people you added '
    + 'who have not added you back) and ENDED (friends who removed you — remove them too with person.friend.remove). '
    + 'Your own records, and each friend\'s record naming you. Args: none.',
  inputSchema: { type: 'object', properties: {} },
  establishes: 'lookup',
};

/** What a person's own profile says of them (their Home's `impact-profile` contact): read for a friend, or someone asking
 *  to be one, under the grant THEIR standing offer gave me — `vault:profile.contact`, the friend's profile. Their name
 *  and photo only; nothing else of the record leaves their vault. A nameless agent is known by this, not its address. */
export interface FriendProfile { profileName?: string; photo?: string }
export interface FriendRow extends FriendProfile { agent: string; name: string | null; since: string; type: FriendType }
export interface FriendRequestRow extends FriendProfile { agent: string; name: string | null; at: string | null }
export interface EndedRow { agent: string; name: string | null; type: FriendType; endedAt: string | null }

const isPersonName = (name: string | null): boolean => { const k = kindOfName(name); return k === null || k === 'person'; };

/** A profile photo small enough to travel in a friends list (the Home keeps photos up to 200 KB). */
const LIST_PHOTO_MAX = 120_000;
const PHOTO_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
/** Their profile's name and photo — only ever called for someone whose standing offer names me (their grant). */
async function profileOf(deps: FriendsDeps, them: string): Promise<FriendProfile> {
  const rec = (await deps.readSubjectRecord?.(them, 'impact-profile').catch(() => null)) as { contact?: { firstName?: unknown; lastName?: unknown; photo?: unknown } } | null;
  const c = rec?.contact;
  if (!c) return {};
  const profileName = [c.firstName, c.lastName].map((x) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean).join(' ').slice(0, 120);
  const photo = typeof c.photo === 'string' && c.photo.length <= LIST_PHOTO_MAX && PHOTO_RE.test(c.photo) ? c.photo : undefined;
  return { ...(profileName ? { profileName } : {}), ...(photo ? { photo } : {}) };
}

/** The friends view itself — shared with presence (presence.ts), which is what friends see of each other. */
export async function friendsOf(deps: FriendsDeps, person: string): Promise<{ friends: FriendRow[]; requests: FriendRequestRow[]; requested: FriendRow[]; ended: EndedRow[]; records: number; moved?: number; moveError?: string }> {
  if (!deps.survey || !deps.readRecords) return { friends: [], requests: [], requested: [], ended: [], records: 0 };
  const me = person.toLowerCase();
  // STEP 3 OF spec 401 §10, lazily: a legacy `contact:` record moves to `friend:` the first time its holder reads. A
  // refusal (a grant that predates `vault:friend:*`) is carried on the result, and the view still reads both shapes.
  const move = deps.writeSubjectRecord ? await migrateLegacyOffers({ survey: deps.survey, readRecords: deps.readRecords, writeSubjectRecord: deps.writeSubjectRecord }, me) : { moved: 0 };
  const mine = await offersOf(deps, me);
  // MY OWN EVIDENCE of their half: friend requests in my inbox and the messages that carried them.
  const offeredMe = await whoOfferedMe(deps, me);
  const nameOf = async (a: string) => (deps.nameOf ? await deps.nameOf(a as `0x${string}`).catch(() => null) : null);
  const friends: FriendRow[] = [];
  const requested: FriendRow[] = [];
  const ended: EndedRow[] = [];
  let checked = 0;
  /** Whether their offer naming me stands, as read for the friends above (true only on their own record). */
  const standingRead = new Map<string, boolean>();
  const theirStanding = async (them: string) => standingRead.get(them) ?? false;
  const theirHalf = async (them: string) => {
    if (checked++ >= OTHER_HALF_CHECK_MAX) return null;
    const o = await readOffer(deps, them, me);
    standingRead.set(them, o?.status === 'standing');
    return o ? { status: o.status, at: o.status === 'withdrawn' ? (o.withdrawnAt ?? null) : o.offeredAt } : null;
  };
  for (const [agent, { offer }] of mine) {
    if (offer.status !== 'standing' || !(FRIEND_TYPES as readonly string[]).includes(offer.friendType)) continue;
    const name = await nameOf(agent);
    if (!isPersonName(name)) continue;
    const half = await theirHalf(agent);
    // A removal from BEFORE my offer is history, not an answer: they removed an earlier friendship and have not yet
    // answered this request (my newer offer is waiting on them — SENT, never ENDED). Their record WAS read, so the
    // evidence below (an old request in my inbox) never stands in for it.
    const stale = half?.status === 'withdrawn' && half.at !== null && half.at < offer.offeredAt;
    // A read that says nothing (unreachable, never written) falls back to MY evidence that they offered.
    const theirs = stale ? null : (half?.status ?? (offeredMe.has(agent) || offer.mutual ? 'standing' : null));
    const state = friendshipState('standing', theirs);
    const since = new Date(offer.offeredAt).toISOString();
    if (state === 'ended') ended.push({ agent, name, type: offer.friendType, endedAt: half?.at ? new Date(half.at).toISOString() : null });
    else if (state === 'friends') friends.push({ agent, name, since, type: offer.friendType });
    else requested.push({ agent, name, since, type: offer.friendType });
  }
  // REQUESTS: people who offered me friendship, whom I have not offered mine — or whose offer is newer than my
  // withdrawal (they asked again). Their half is checked: a request they withdrew is no longer one.
  const requests: FriendRequestRow[] = [];
  for (const [agent, at] of offeredMe) {
    const my = mine.get(agent)?.offer;
    if (my?.status === 'standing') continue;
    if (my && !(at && my.withdrawnAt && Date.parse(at) > my.withdrawnAt)) continue;
    const half = await theirHalf(agent);
    if (half?.status === 'withdrawn') continue;
    requests.push({ agent, name: await nameOf(agent), at });
  }
  requests.sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? '')));
  // Their own name and photo, for friends and for requests — each only when their offer naming me was READ standing
  // (their grant, not my inbox's evidence of it); ended rows (they withdrew) are not read.
  const granted = new Set<string>();
  for (const f of friends) if ((await theirStanding(f.agent)) === true) granted.add(f.agent);
  for (const r of requests) if ((await theirStanding(r.agent)) === true) granted.add(r.agent);
  const profiles = new Map(await Promise.all([...granted].map(async (a) => [a, await profileOf(deps, a)] as const)));
  for (const row of [...friends, ...requests]) Object.assign(row, profiles.get(row.agent) ?? {});
  return { friends, requests, requested, ended, records: mine.size, ...(move.moved ? { moved: move.moved } : {}), ...(move.error ? { moveError: move.error } : {}) };
}

/** `person.friend.list` — a read of the person's own records and inbox, and each friend's record naming them; no mandate. */
export function friendListInvoker(deps: FriendsDeps, person: string | undefined): ToolInvoker {
  return async () => {
    if (!person) return { refused: 'friends are a person\'s own — there is no person on this run' };
    if (!deps.survey || !deps.readRecords) return { refused: 'this agent cannot read its friends here' };
    const { friends, requests, requested, ended, records, moved, moveError } = await friendsOf(deps, person);
    const parts = [
      requests.length ? `${requests.length} waiting on you — add them back to be friends` : '',
      requested.length ? `${requested.length} not yet added you back` : '',
      ended.length ? `${ended.length} removed you — you can remove them too` : '',
    ].filter(Boolean);
    return {
      count: friends.length,
      friends,
      requests,
      requested,
      ended,
      ...(moved ? { moved } : {}),
      ...(moveError ? { storageNeedsEnabling: true, moveError } : {}),
      interpretation: `read the person's own friend records (${records}) and inbox, and each friend's record naming them`,
      note: friends.length
        ? `${friends.length} friend(s)${parts.length ? `; ${parts.join('; ')}` : ''}.`
        : requests.length
          ? `${requests.length} person(s) added you — add them back ("add bob.me as a friend") and you are friends.`
          : `No friends yet — add a person as a friend; you are friends once they add you back.${ended.length ? ` ${ended.length} removed you.` : ''}`,
    };
  };
}
