// FRIENDS — a view over contacts (spec 401): a friend is a person the asker added as a contact with role `friend`
// (or `family`) AND who added them back. Both halves are the person's own evidence — their contact record, and the
// message the other person's agent sent when adding them (it carries a `contact` reference naming the person; the
// invite invoker sends it). Nobody's roster is read but the asker's. `requests` are people who added the person and
// were not added back; `requested` are people the person added who have not added them back. A state, not an act:
// accepting is `person.contact.invite` back, declining is doing nothing. No grant, no record, no public listing.
import type { ToolInvoker, ToolSpec } from '@agenticprimitives/orchestration';
import { CONTACT_RECORD_PREFIX, contactRecordType, whoAddedMe, type ContactDeps, type ContactRecordV1 } from './contacts.js';

/** What the friends view reads: the person's own records and names — a route can build this without the act deps. */
export type FriendsDeps = Pick<ContactDeps, 'survey' | 'readRecords' | 'readSubjectRecord' | 'nameOf'>;

export const FRIEND_LIST_CAPABILITY = 'person.friend.list' as const;

/** How many waiting contacts a friends read checks for the other half (one record read each). */
const REQUESTED_CHECK_MAX = 50;

/** The roles that make a mutual contact a friend — the rest (coach, runtime, assistant, other) are one-way by nature. */
const FRIEND_ROLES: ReadonlySet<string> = new Set(['friend', 'family']);

export const FRIEND_LIST_TOOL: ToolSpec = {
  id: FRIEND_LIST_CAPABILITY,
  answers: ['my friends', 'who are my friends', 'friend requests', 'who added me', 'who has not added me back', 'pending friends'],
  description:
    'YOUR FRIENDS — the people among your contacts who added you back (role friend or family), plus who is waiting: '
    + 'REQUESTS (people who added you that you have not added back — accept with person.contact.invite, role friend) '
    + 'and REQUESTED (people you added who have not added you back). Your own records and inbox only. Args: none. '
    + 'NOT the full contact list with roles and grants — that is person.contact.list.',
  inputSchema: { type: 'object', properties: {} },
  establishes: 'lookup',
};


export interface FriendRow { agent: string; name: string | null; since: string }
export interface FriendRequestRow { agent: string; name: string | null; at: string | null }


/** The friends view itself — shared with presence (presence.ts), which is what friends see of each other. */
export async function friendsOf(deps: FriendsDeps, person: string): Promise<{ friends: FriendRow[]; requests: FriendRequestRow[]; requested: FriendRow[]; records: number }> {
  if (!deps.survey || !deps.readRecords) return { friends: [], requests: [], requested: [], records: 0 };
  const me = person.toLowerCase();
  const keys = (await deps.survey(me).catch(() => [])).map((r) => r.recordType).filter((rt) => rt.startsWith(CONTACT_RECORD_PREFIX)).slice(0, 200);
  const bodies: Record<string, unknown> = keys.length ? await deps.readRecords(me, keys).catch(() => ({} as Record<string, unknown>)) : {};
  // THE OTHER HALF: who added me — my inbox's `contact` references and the contact notices, both in my own vault.
  const addedMe = await whoAddedMe(deps, me);
  const nameOf = async (a: string) => (deps.nameOf ? await deps.nameOf(a as `0x${string}`).catch(() => null) : null);
  const friends: FriendRow[] = [];
  const requested: FriendRow[] = [];
  const known = new Set<string>();
  for (const rt of keys) {
    const rec = bodies[rt] as ContactRecordV1 | undefined;
    if (rec?.type !== 'ap.contact.v1') continue;
    const contact = rec.contact.toLowerCase();
    known.add(contact);
    if (rec.status !== 'contact' || !FRIEND_ROLES.has(rec.role)) continue;
    const row: FriendRow = { agent: contact, name: await nameOf(contact), since: new Date(rec.createdAt).toISOString() };
    if (rec.mutual === true || addedMe.has(contact)) friends.push(row);
    else requested.push(row);
  }
  // THE OTHER HALF, ALREADY SIGNED: someone I added who added me too — their own contact record naming me — is a
  // friend even when their notice never reached me (added before notices existed, or lost). One record of theirs per
  // waiting contact, the one that answers "did they add me"; bounded.
  if (requested.length) {
    const back = await Promise.all(requested.slice(0, REQUESTED_CHECK_MAX).map(async (r) => {
      const theirs = (await deps.readSubjectRecord?.(r.agent, contactRecordType(me)).catch(() => null)) as ContactRecordV1 | null;
      return theirs?.type === 'ap.contact.v1' && theirs.status === 'contact';
    }));
    for (let i = back.length - 1; i >= 0; i--) if (back[i]) friends.push(...requested.splice(i, 1));
  }
  const requests: FriendRequestRow[] = [];
  for (const [agent, at] of addedMe) if (!known.has(agent)) requests.push({ agent, name: await nameOf(agent), at });
  requests.sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? '')));
  return { friends, requests, requested, records: keys.length };
}

/** `person.friend.list` — a read of the person's own contacts and inbox; no mandate. */
export function friendListInvoker(deps: FriendsDeps, person: string | undefined): ToolInvoker {
  return async () => {
    if (!person) return { refused: 'friends are a person\'s own — there is no person on this run' };
    if (!deps.survey || !deps.readRecords) return { refused: 'this agent cannot read its contacts here' };
    const { friends, requests, requested, records } = await friendsOf(deps, person);
    return {
      count: friends.length,
      friends,
      requests,
      requested,
      interpretation: `read the person's own contacts (${records} record(s)) and inbox for who added them back`,
      note: friends.length
        ? `${friends.length} friend(s)${requests.length ? `; ${requests.length} waiting on you — add them back to be friends` : ''}${requested.length ? `; ${requested.length} not yet added you back` : ''}.`
        : requests.length
          ? `${requests.length} person(s) added you — add them back ("add bob.me as a friend") and you are mutual friends.`
          : 'No friends yet — add a person as a friend; you are mutual friends once they add you back.',
    };
  };
}
