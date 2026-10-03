// Spec 400 W2 (B5) — search over the person's own work, through the capability the conversation answers "search my
// work for …" with (`person.work.search`). The Ask does what the box does; the box is the Ask with a supplied plan.
import type { Address } from '@agenticprimitives/types';
import type { AskReply } from './ask';
import { ensureCsrfToken, csrfHeaders } from '../csrf';

export interface SearchResultRow {
  id: string; kind: 'message' | 'topic' | 'run'; at: string; snippet: string; score: number;
  where: { subject: string; name?: string | null; why: 'self' | 'stewardship' };
  ref: { conversationId?: string; messageId?: string; org?: string; channelId?: string; runRef?: string; from?: string; fromName?: string; title?: string };
}
export interface SearchOutcome { query: string; count: number; results: SearchResultRow[]; searched: Array<{ subject: string; name: string | null; why: string; indexed: number }>; note?: string }

const j = async (r: Response) => (await r.json().catch(() => ({}))) as { reply?: AskReply; error?: string; detail?: string };

export async function searchWorkThroughHarness(input: { person: Address; session: { token: string }; query: string; kinds?: string[] }): Promise<{ ok: true; outcome: SearchOutcome } | { ok: false; error: string }> {
  await ensureCsrfToken();
  const args = { query: input.query, ...(input.kinds?.length ? { kinds: input.kinds } : {}) };
  const out = await j(await fetch('/a2a/harness/ask', {
    method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', ...csrfHeaders() },
    body: JSON.stringify({ session: input.session.token, addressee: input.person.toLowerCase(), message: `search my work for ${input.query}`, rowsOnly: true, plan: { steps: [{ toolId: 'person.work.search', args }] } }),
  }));
  const reply = out.reply;
  if (reply?.kind === 'answer') {
    const rows = (reply as { results?: Array<{ toolId: string; result: unknown }> }).results ?? [];
    const found = rows.find((x) => x.toolId === 'person.work.search')?.result as SearchOutcome | undefined;
    if (found) return { ok: true, outcome: found };
  }
  return { ok: false, error: out.detail ?? out.error ?? (reply?.kind === 'refused' ? reply.error : 'the search could not run') };
}
