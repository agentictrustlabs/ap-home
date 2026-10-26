// FRIENDS — a friendship is TWO-WAY (spec 401; owner, 2026-10-26). Each person keeps their own half: a record in
// their own vault naming the other, under a grant they signed (`contact:<sa>`, the wire name kept so no record or
// grant is orphaned). Neither half is a friendship on its own:
//
//   mine + theirs, both standing  → FRIENDS (the type — friend · family · coach · other — is mine to give)
//   mine only                     → SENT (a request waiting on them)
//   theirs only                   → REQUEST (waiting on me; accepting is `person.contact.invite` back)
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
import { CONTACT_RECORD_PREFIX, contactRecordType, whoAddedMe, type ContactDeps, type ContactRecordV1 } from './contacts.js';

/** What the friends view reads: the person's own records and names — a route can build this without the act deps. */
export type FriendsDeps = Pick<ContactDeps, 'survey' | 'readRecords' | 'readSubjectRecord' | 'nameOf'>;

export const FRIEND_LIST_CAPABILITY = 'person.friend.list' as const;

/** How many of the other halves one read checks (one record of theirs each). */
const OTHER_HALF_CHECK_MAX = 100;

/** The kinds of friend — what they are to you. Declarative; none authorizes anything. */
export const FRIEND_TYPES = ['friend', 'family', 'coach', 'other'] as const;
export type FriendType = typeof FRIEND_TYPES[number];
const FRIEND_ROLES: ReadonlySet<string> = new Set(FRIEND_TYPES);

export const FRIEND_LIST_TOOL: ToolSpec = {
  id: FRIEND_LIST_CAPABILITY,
  answers: ['my friends', 'who are my friends', 'friend requests', 'who added me', 'who has not added me back', 'pending friends', 'who removed me', 'who unfriended me'],
  description:
    'YOUR FRIENDS — two-way: people you added who added you back, each with the type you gave them (friend, family, '
    + 'coach, other). Plus REQUESTS (people who added you — accept with person.contact.invite), SENT (people you added '
    + 'who have not added you back) and ENDED (friends who removed you — remove them too with person.contact.remove). '
    + 'Your own records, and each friend\'s record naming you. Args: none.',
  inputSchema: { type: 'object', properties: {} },
  establishes: 'lookup',
};

export interface FriendRow { agent: string; name: string | null; since: string; type: FriendType }
export interface FriendRequestRow { agent: string; name: string | null; at: string | null }
export interface EndedRow { agent: string; name: string | null; type: FriendType; endedAt: string | null }

type OtherHalf = 'standing' | 'removed' | 'silent';

async function otherHalf(deps: FriendsDeps, them: string, me: string): Promise<{ half: OtherHalf; at: number | null }> {
  const theirs = (await deps.readSubjectRecord?.(them, contactRecordType(me)).catch(() => null)) as ContactRecordV1 | null;
  if (theirs?.type !== 'ap.contact.v1') return { half: 'silent', at: null };
  if (theirs.status === 'removed') return { half: 'removed', at: theirs.removedAt ?? null };
  return { half: 'standing', at: theirs.createdAt ?? null };
}

const isPersonName = (name: string | null): boolean => { const k = kindOfName(name); return k === null || k === 'person'; };

/** The friends view itself — shared with presence (presence.ts), which is what friends see of each other. */
export async function friendsOf(deps: FriendsDeps, person: string): Promise<{ friends: FriendRow[]; requests: FriendRequestRow[]; requested: FriendRow[]; ended: EndedRow[]; records: number }> {
  if (!deps.survey || !deps.readRecords) return { friends: [], requests: [], requested: [], ended: [], records: 0 };
  const me = person.toLowerCase();
  const keys = (await deps.survey(me).catch(() => [])).map((r) => r.recordType).filter((rt) => rt.startsWith(CONTACT_RECORD_PREFIX)).slice(0, 200);
  const bodies: Record<string, unknown> = keys.length ? await deps.readRecords(me, keys).catch(() => ({} as Record<string, unknown>)) : {};
  // MY OWN EVIDENCE of their half: their add notices and the messages that carried them, in my inbox.
  const addedMe = await whoAddedMe(deps, me);
  const nameOf = async (a: string) => (deps.nameOf ? await deps.nameOf(a as `0x${string}`).catch(() => null) : null);
  const friends: FriendRow[] = [];
  const requested: FriendRow[] = [];
  const ended: EndedRow[] = [];
  /** My half for everyone I ever added: standing, or when I removed them (null when the record does not say — then a
   *  later ask cannot be told from an old one, and is not shown). */
  const mine = new Map<string, { standing: boolean; removedAt: number | null }>();
  let checked = 0;
  for (const rt of keys) {
    const rec = bodies[rt] as ContactRecordV1 | undefined;
    if (rec?.type !== 'ap.contact.v1') continue;
    const agent = rec.contact.toLowerCase();
    mine.set(agent, { standing: rec.status === 'contact', removedAt: rec.status === 'removed' ? (rec.removedAt ?? null) : null });
    if (rec.status !== 'contact' || !FRIEND_ROLES.has(rec.role)) continue;
    const name = await nameOf(agent);
    if (!isPersonName(name)) continue;
    const type = rec.role as FriendType;
    const since = new Date(rec.createdAt).toISOString();
    const { half, at } = checked++ < OTHER_HALF_CHECK_MAX ? await otherHalf(deps, agent, me) : { half: 'silent' as const, at: null };
    if (half === 'removed') ended.push({ agent, name, type, endedAt: at ? new Date(at).toISOString() : null });
    else if (half === 'standing' || rec.mutual === true || addedMe.has(agent)) friends.push({ agent, name, since, type });
    else requested.push({ agent, name, since, type });
  }
  // REQUESTS: people who added me, whom I have not added — or whom I removed BEFORE they asked again. Their half is
  // checked: a request they withdrew (removed me since) is no longer one.
  const requests: FriendRequestRow[] = [];
  for (const [agent, at] of addedMe) {
    const my = mine.get(agent);
    if (my?.standing) continue;
    if (my && !(at && my.removedAt !== null && Date.parse(at) > my.removedAt)) continue;
    const { half } = checked++ < OTHER_HALF_CHECK_MAX ? await otherHalf(deps, agent, me) : { half: 'silent' as const };
    if (half === 'removed') continue;
    requests.push({ agent, name: await nameOf(agent), at });
  }
  requests.sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? '')));
  return { friends, requests, requested, ended, records: keys.length };
}

/** `person.friend.list` — a read of the person's own records and inbox, and each friend's record naming them; no mandate. */
export function friendListInvoker(deps: FriendsDeps, person: string | undefined): ToolInvoker {
  return async () => {
    if (!person) return { refused: 'friends are a person\'s own — there is no person on this run' };
    if (!deps.survey || !deps.readRecords) return { refused: 'this agent cannot read its friends here' };
    const { friends, requests, requested, ended, records } = await friendsOf(deps, person);
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
      interpretation: `read the person's own friend records (${records}) and inbox, and each friend's record naming them`,
      note: friends.length
        ? `${friends.length} friend(s)${parts.length ? `; ${parts.join('; ')}` : ''}.`
        : requests.length
          ? `${requests.length} person(s) added you — add them back ("add bob.me as a friend") and you are friends.`
          : `No friends yet — add a person as a friend; you are friends once they add you back.${ended.length ? ` ${ended.length} removed you.` : ''}`,
    };
  };
}
