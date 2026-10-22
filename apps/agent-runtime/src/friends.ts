// FRIENDS — a view over contacts (spec 401): a friend is a person the asker added as a contact with role `friend`
// (or `family`) AND who added them back. Both halves are the person's own evidence — their contact record, and the
// message the other person's agent sent when adding them (it carries a `contact` reference naming the person; the
// invite invoker sends it). Nobody's roster is read but the asker's. `requests` are people who added the person and
// were not added back; `requested` are people the person added who have not added them back. A state, not an act:
// accepting is `person.contact.invite` back, declining is doing nothing. No grant, no record, no public listing.
import type { ToolInvoker, ToolSpec } from '@agenticprimitives/orchestration';
import { CONTACT_RECORD_PREFIX, type ContactDeps, type ContactRecordV1 } from './contacts.js';

export const FRIEND_LIST_CAPABILITY = 'person.friend.list' as const;

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

interface Envelope { from?: string; createdAt?: string; contextRefs?: Array<{ kind: string; id: string }> }

export interface FriendRow { agent: string; name: string | null; since: string }
export interface FriendRequestRow { agent: string; name: string | null; at: string | null }

const addressOf = (from: unknown): string => (String(from ?? '').match(/0x[0-9a-fA-F]{40}$/)?.[0] ?? '').toLowerCase();

/** `person.friend.list` — a read of the person's own contacts and inbox; no mandate. */
export function friendListInvoker(deps: ContactDeps, person: string | undefined): ToolInvoker {
  return async () => {
    if (!person) return { refused: 'friends are a person\'s own — there is no person on this run' };
    if (!deps.survey || !deps.readRecords) return { refused: 'this agent cannot read its contacts here' };
    const me = person.toLowerCase();
    const keys = (await deps.survey(me).catch(() => [])).map((r) => r.recordType).filter((rt) => rt.startsWith(CONTACT_RECORD_PREFIX)).slice(0, 200);
    const bodies: Record<string, unknown> = keys.length ? await deps.readRecords(me, keys).catch(() => ({} as Record<string, unknown>)) : {};
    // THE OTHER HALF: who added me, from my own inbox — the newest `contact` reference naming me, per sender.
    const inbox = (await deps.readSubjectRecord?.(me, 'inbox.data').catch(() => null)) as { envelopes?: Envelope[] } | null;
    const addedMe = new Map<string, string | null>();
    for (const e of inbox?.envelopes ?? []) {
      if (!(e.contextRefs ?? []).some((r) => r.kind === 'contact' && r.id.toLowerCase() === me)) continue;
      const who = addressOf(e.from);
      if (!who || who === me) continue;
      const at = typeof e.createdAt === 'string' ? e.createdAt : null;
      const prev = addedMe.get(who);
      if (prev === undefined || (at && (!prev || prev < at))) addedMe.set(who, at);
    }
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
    const requests: FriendRequestRow[] = [];
    for (const [agent, at] of addedMe) if (!known.has(agent)) requests.push({ agent, name: await nameOf(agent), at });
    requests.sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? '')));
    return {
      count: friends.length,
      friends,
      requests,
      requested,
      interpretation: `read the person's own contacts (${keys.length} record(s)) and inbox for who added them back`,
      note: friends.length
        ? `${friends.length} friend(s)${requests.length ? `; ${requests.length} waiting on you — add them back to be friends` : ''}${requested.length ? `; ${requested.length} not yet added you back` : ''}.`
        : requests.length
          ? `${requests.length} person(s) added you — add them back ("add bob.me as a contact") and you are friends.`
          : 'No friends yet — add a person as a contact (role friend); you are friends once they add you back.',
    };
  };
}
