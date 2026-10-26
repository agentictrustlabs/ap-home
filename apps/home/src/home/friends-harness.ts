// FRIENDS — the panel's governed core (spec 401 / spec 361 I4). A friendship is two-way: each person keeps their own
// half, under a grant they signed. The view is read through the same capability the conversation uses
// (`person.friend.list`, a supplied plan at `/harness/ask`); adding and removing go through the Ask as COMMANDS
// (`askCommand`) — each is the person's own act with a mandate they sign and, for adding, the grant they sign.
import type { Address } from '@agenticprimitives/types';
import type { AskReply } from './ask';
import { ensureCsrfToken, csrfHeaders } from '../csrf';

/** What a friend is to you. Declarative; none authorizes anything. */
export const FRIEND_TYPES = ['friend', 'family', 'coach', 'other'] as const;
export type FriendType = typeof FRIEND_TYPES[number];
export const FRIEND_TYPE_WORDS: Record<FriendType, string> = { friend: 'Friend', family: 'Family', coach: 'Coach', other: 'Other' };

export interface FriendRow { agent: string; name: string | null; since: string; type: FriendType }
export interface FriendRequestRow { agent: string; name: string | null; at: string | null }
/** A friend who removed you: their half is gone, yours still stands until you remove it. */
export interface EndedRow { agent: string; name: string | null; type: FriendType; endedAt: string | null }
export interface FriendsView {
  friends: FriendRow[]; requests: FriendRequestRow[]; requested: FriendRow[]; ended: EndedRow[];
  /** The person's storage grant predates friendship records, so their older friend records could not move yet: one
   *  re-enable (silent on a KMS home) finishes it. Reads are unaffected. */
  storageNeedsEnabling?: boolean;
}

const j = async (r: Response) => (await r.json().catch(() => ({}))) as { reply?: AskReply; error?: string; detail?: string };

/** Your friends, who is waiting on whom, and who removed you (`person.friend.list`). */
export async function readFriendsThroughHarness(input: { person: Address; session: { token: string } }): Promise<{ ok: true } & FriendsView | { ok: false; error: string }> {
  await ensureCsrfToken();
  const out = await j(await fetch('/a2a/harness/ask', {
    method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', ...csrfHeaders() },
    body: JSON.stringify({ session: input.session.token, addressee: input.person.toLowerCase(), message: 'who are my friends', rowsOnly: true, plan: { steps: [{ toolId: 'person.friend.list', args: {} }] } }),
  }));
  const reply = out.reply;
  if (reply?.kind === 'answer') {
    const rows = (reply as { results?: Array<{ toolId: string; result: unknown }> }).results ?? [];
    const found = rows.find((x) => x.toolId === 'person.friend.list')?.result as Partial<FriendsView> & { refused?: string; storageNeedsEnabling?: boolean } | undefined;
    if (found?.refused) return { ok: false, error: found.refused };
    const typed = <T extends { type?: unknown }>(r: T): T & { type: FriendType } => ({ ...r, type: (FRIEND_TYPES as readonly string[]).includes(String(r.type)) ? r.type as FriendType : 'friend' });
    return { ok: true, friends: (found?.friends ?? []).map(typed), requests: found?.requests ?? [], requested: (found?.requested ?? []).map(typed), ended: (found?.ended ?? []).map(typed), ...(found?.storageNeedsEnabling ? { storageNeedsEnabling: true } : {}) };
  }
  return { ok: false, error: out.detail ?? out.error ?? (reply?.kind === 'refused' ? reply.error : 'your friends could not be read') };
}
