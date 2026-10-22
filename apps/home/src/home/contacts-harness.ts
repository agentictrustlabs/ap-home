// CONTACTS — the panel's governed core (spec 401 C2 / spec 361 I4). The list is read through the same informational
// capability the conversation uses (`person.contact.list`, a supplied plan at `/harness/ask`); adding and removing a
// contact go through the Ask as COMMANDS (`askCommand`), because each is the person's own act with a mandate they sign
// and, for adding, the grant they sign — the flyout runs the ceremony, the receipt lands where every receipt lands.
import type { Address } from '@agenticprimitives/types';
import type { AskReply } from './ask';
import { ensureCsrfToken, csrfHeaders } from '../csrf';

export const CONTACT_ROLES = ['friend', 'family', 'coach', 'assistant', 'runtime', 'other'] as const;
export type ContactRole = typeof CONTACT_ROLES[number];

export interface ContactRow { contact: string; name: string | null; role: string; status: string; grantDigest?: string; mutual?: boolean; since?: string }

const j = async (r: Response) => (await r.json().catch(() => ({}))) as { reply?: AskReply; error?: string; detail?: string };

/** The person's contacts, read through the capability the conversation answers "who are my contacts" with. */
export async function readContactsThroughHarness(input: { person: Address; session: { token: string } }): Promise<{ ok: true; contacts: ContactRow[]; removed: number } | { ok: false; error: string }> {
  await ensureCsrfToken();
  const out = await j(await fetch('/a2a/harness/ask', {
    method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', ...csrfHeaders() },
    body: JSON.stringify({ session: input.session.token, addressee: input.person.toLowerCase(), message: 'who are my contacts', rowsOnly: true, plan: { steps: [{ toolId: 'person.contact.list', args: {} }] } }),
  }));
  const reply = out.reply;
  if (reply?.kind === 'answer') {
    const rows = (reply as { results?: Array<{ toolId: string; result: unknown }> }).results ?? [];
    const found = rows.find((x) => x.toolId === 'person.contact.list')?.result as { contacts?: ContactRow[]; removed?: number } | undefined;
    return { ok: true, contacts: found?.contacts ?? [], removed: found?.removed ?? 0 };
  }
  return { ok: false, error: out.detail ?? out.error ?? (reply?.kind === 'refused' ? reply.error : 'your contacts could not be read') };
}

export interface FriendRow { agent: string; name: string | null; since: string }
export interface FriendRequestRow { agent: string; name: string | null; at: string | null }
export interface FriendsView { friends: FriendRow[]; requests: FriendRequestRow[]; requested: FriendRow[] }

/** The person's friends and who is waiting on whom (`person.friend.list` — a view over their contacts and inbox). */
export async function readFriendsThroughHarness(input: { person: Address; session: { token: string } }): Promise<{ ok: true } & FriendsView | { ok: false; error: string }> {
  await ensureCsrfToken();
  const out = await j(await fetch('/a2a/harness/ask', {
    method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', ...csrfHeaders() },
    body: JSON.stringify({ session: input.session.token, addressee: input.person.toLowerCase(), message: 'who are my friends', rowsOnly: true, plan: { steps: [{ toolId: 'person.friend.list', args: {} }] } }),
  }));
  const reply = out.reply;
  if (reply?.kind === 'answer') {
    const rows = (reply as { results?: Array<{ toolId: string; result: unknown }> }).results ?? [];
    const found = rows.find((x) => x.toolId === 'person.friend.list')?.result as Partial<FriendsView> & { refused?: string } | undefined;
    if (found?.refused) return { ok: false, error: found.refused };
    return { ok: true, friends: found?.friends ?? [], requests: found?.requests ?? [], requested: found?.requested ?? [] };
  }
  return { ok: false, error: out.detail ?? out.error ?? (reply?.kind === 'refused' ? reply.error : 'your friends could not be read') };
}

export interface GoogleContactRow { name: string | null; email: string }

/** The person's Google address book (`contacts.connections.list`) — names and emails, never stored as friends. */
export async function readGoogleContactsThroughHarness(input: { person: Address; session: { token: string }; query?: string }): Promise<{ ok: true; people: GoogleContactRow[]; connected: boolean } | { ok: false; error: string; connected?: boolean }> {
  await ensureCsrfToken();
  const out = await j(await fetch('/a2a/harness/ask', {
    method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', ...csrfHeaders() },
    body: JSON.stringify({ session: input.session.token, addressee: input.person.toLowerCase(), message: 'who is in my google contacts', rowsOnly: true, plan: { steps: [{ toolId: 'contacts.connections.list', args: { ...(input.query ? { query: input.query } : {}), max: 200 } }] } }),
  }));
  const reply = out.reply;
  if (reply?.kind === 'answer') {
    const rows = (reply as { results?: Array<{ toolId: string; result: unknown }> }).results ?? [];
    const found = rows.find((x) => x.toolId === 'contacts.connections.list')?.result as { people?: GoogleContactRow[]; refused?: string; connected?: boolean } | undefined;
    if (found?.refused) return { ok: false, error: found.refused, connected: false };
    return { ok: true, people: found?.people ?? [], connected: found?.connected !== false };
  }
  return { ok: false, error: out.detail ?? out.error ?? (reply?.kind === 'refused' ? reply.error : 'your Google contacts could not be read') };
}
