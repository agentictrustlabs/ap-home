// WHAT HAS BEEN SAID TO THIS AGENT — spec 400 W1 (`messaging.inbox.list`, the ~/skills contract `person-inbox-read`).
//
// The read an outside runtime polls to receive its work: "what's new for me since <cursor>", asked AS ITSELF over the
// standard surface under its session wire, answered from its OWN inbox record (`inbox.data`) with each body read from
// its own vault. The same read answers a person's "what's new for me". Never another agent's inbox: the subject is
// the asker, always — the invoker takes it from the run, not from an argument.
//
// A cursor, so a poll never repeats itself: `since` is a message id or an ISO moment; the answer carries the newest
// id as `cursor`. Bodies are clipped (a poll is a listing, not an archive read).
import type { ToolSpec, ToolInvoker } from '@agenticprimitives/orchestration';

export const INBOX_LIST_CAPABILITY = 'messaging.inbox.list' as const;

export const INBOX_LIST_TOOL: ToolSpec = {
  id: INBOX_LIST_CAPABILITY,
  answers: ['my messages', "what's new for me", 'what did they say', 'anything new', 'my inbox', 'messages since'],
  description:
    'WHAT HAS BEEN SAID TO THIS AGENT — the direct messages in its own inbox, newest last, each with who sent it, which '
    + 'conversation it belongs to, when, and its text. Use it for "what\'s new for me", "my messages", "anything since '
    + '<cursor>". Its own inbox only. Args: since (optional — a message id or an ISO-8601 moment; only later messages are '
    + 'listed), limit (optional, default 20, max 100).',
  inputSchema: {
    type: 'object',
    properties: {
      since: { type: 'string', description: 'A message id or an ISO-8601 moment; only messages after it' },
      limit: { type: 'integer', description: 'At most this many (default 20, max 100)' },
    },
  },
  establishes: 'lookup',
};

interface Envelope { id?: string; conversationId?: string; from?: string; to?: string[]; createdAt?: string; body?: { resource?: string }; bodyContentType?: string; actor?: string }
interface InboxDoc { envelopes?: Envelope[] }

export interface InboxListDeps {
  readSubjectRecord?: (subject: string, recordType: string) => Promise<unknown>;
  nameOf?: (address: string) => Promise<string | null>;
}

const BODY_CLIP = 2000;
const addrOf = (caip: string | undefined): string => (String(caip ?? '').match(/0x[0-9a-fA-F]{40}$/)?.[0] ?? '').toLowerCase();

export interface InboxListMessage { id: string; conversationId: string; from: string; fromName: string | null; mine: boolean; createdAt: string; text: string; actor?: string }

export function inboxListInvoker(deps: InboxListDeps, self: string | undefined): ToolInvoker {
  return async (_toolId, args) => {
    if (!self) return { refused: 'an inbox is read by its own agent, and there is no agent on this run' };
    if (!deps.readSubjectRecord) return { refused: 'this agent cannot read its inbox here' };
    const me = self.toLowerCase();
    const inbox = (await deps.readSubjectRecord(me, 'inbox.data').catch(() => null)) as InboxDoc | null;
    const all = (inbox?.envelopes ?? []).filter((e) => e.id && e.createdAt).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    const since = typeof args?.since === 'string' ? args.since.trim() : '';
    const limit = Math.max(1, Math.min(100, Number(args?.limit ?? 20) || 20));
    let after = all;
    if (since) {
      const byId = all.findIndex((e) => e.id === since);
      if (byId >= 0) after = all.slice(byId + 1);
      else if (!Number.isNaN(Date.parse(since))) after = all.filter((e) => Date.parse(String(e.createdAt)) > Date.parse(since));
      else return { refused: `since must be a message id this inbox holds or an ISO-8601 moment; "${since}" is neither` };
    }
    const page = after.slice(-limit);
    const names = new Map<string, string | null>();
    const nameFor = async (addr: string): Promise<string | null> => {
      if (!addr || !deps.nameOf) return null;
      if (!names.has(addr)) names.set(addr, await deps.nameOf(addr).catch(() => null));
      return names.get(addr) ?? null;
    };
    const messages: InboxListMessage[] = [];
    for (const e of page) {
      const from = addrOf(e.from);
      let text = '';
      const resource = String(e.body?.resource ?? '').replace(/^vault:/, '');
      if (resource) {
        const rec = (await deps.readSubjectRecord(me, resource).catch(() => null)) as { b64?: string; text?: string } | null;
        if (rec?.b64) { try { text = Buffer.from(rec.b64, 'base64').toString('utf8'); } catch { text = ''; } }
        else if (typeof rec?.text === 'string') text = rec.text;
      }
      messages.push({
        id: String(e.id), conversationId: String(e.conversationId ?? ''), from, fromName: await nameFor(from), mine: from === me,
        createdAt: String(e.createdAt), text: text.slice(0, BODY_CLIP), ...(e.actor ? { actor: String(e.actor) } : {}),
      });
    }
    const cursor = page.length ? String(page[page.length - 1]!.id) : since || null;
    // Spec 421 W2 — OTHER PEOPLE'S WORDS ARE DATA. A message someone else wrote is untrusted content, exactly as a web page
    // or a published work is: it may be quoted and acted on where she asks, never obeyed. Marking it here lets the loop
    // know the run has read somebody else's words (spec 409 §4) — found 2026-09-28: web, search and shelf reads carried
    // the mark and the inbox did not.
    const fromOthers = messages.some((m) => !m.mine);
    return {
      ...(fromOthers ? { untrusted: true } : {}),
      count: messages.length,
      total: all.length,
      remaining: Math.max(0, after.length - page.length),
      cursor,
      messages,
      interpretation: `read this agent's own inbox (${all.length} message(s)); ${since ? `${after.length} after ${since}` : 'the most recent'}, ${messages.length} listed`,
      note: messages.length ? 'From this agent\'s own inbox. `cursor` is the newest id listed — pass it as `since` next time to see only what is new.' : since ? 'Nothing new since that cursor.' : 'The inbox is empty.',
    };
  };
}
