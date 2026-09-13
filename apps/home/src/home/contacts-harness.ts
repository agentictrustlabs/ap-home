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
    body: JSON.stringify({ session: input.session.token, addressee: input.person.toLowerCase(), message: 'who are my contacts', plan: { steps: [{ toolId: 'person.contact.list', args: {} }] } }),
  }));
  const reply = out.reply;
  if (reply?.kind === 'answer') {
    const rows = (reply as { results?: Array<{ toolId: string; result: unknown }> }).results ?? [];
    const found = rows.find((x) => x.toolId === 'person.contact.list')?.result as { contacts?: ContactRow[]; removed?: number } | undefined;
    return { ok: true, contacts: found?.contacts ?? [], removed: found?.removed ?? 0 };
  }
  return { ok: false, error: out.detail ?? out.error ?? (reply?.kind === 'refused' ? reply.error : 'your contacts could not be read') };
}
