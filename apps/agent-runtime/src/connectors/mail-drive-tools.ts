// GMAIL AND DRIVE AS CAPABILITIES — spec 402 W2. Reads are the person's own standing (her connector, her agent answering
// as her); the one act — a mail DRAFT — needs her mandate (`authorityArg: holder`). Never send, never delete, never
// write a file in this wave. Whoever asks — her Home, Claude through the Home MCP, a paired runtime — gets the
// harness's answer as her, never the token.
import type { ToolSpec, ToolInvoker } from '@agenticprimitives/orchestration';
import { searchThreads, readThread, createDraft } from './google-gmail.js';
import { searchFiles, readFile } from './google-drive.js';
import { connectorStatus, type TokenEnv } from './google-token.js';

export const GMAIL_THREADS_SEARCH = 'gmail.threads.search' as const;
export const GMAIL_THREAD_READ = 'gmail.thread.read' as const;
export const GMAIL_DRAFT_CREATE = 'gmail.draft.create' as const;
export const DRIVE_FILES_SEARCH = 'drive.files.search' as const;
export const DRIVE_FILE_READ = 'drive.file.read' as const;
export const MAIL_DRIVE_ACTS = new Set<string>([GMAIL_DRAFT_CREATE]);

const holderArg = { holder: { type: 'string', description: 'Whose account — the person it belongs to (defaults to the asker)' } };

export const MAIL_DRIVE_TOOLS: ToolSpec[] = [
  {
    id: GMAIL_THREADS_SEARCH,
    answers: ['any mail from', 'unanswered email', 'what did X email me', 'search my email', 'recent mail about', 'unread mail', 'did I get an email'],
    description: 'SEARCHES the person\'s Gmail: `query` in Gmail\'s own words (from:pastor@example.org, subject:retreat, newer_than:7d, is:unread, or plain words); `max` caps the threads (default 10). Each thread: subject, from, date, a snippet, unread. Says when mail is not connected. Never sends.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, max: { type: 'integer' }, ...holderArg } },
    establishes: 'lookup',
  },
  {
    id: GMAIL_THREAD_READ,
    answers: ['read that email', 'what does the email say', 'open the thread', 'the full message'],
    description: 'READS one Gmail thread by id (from gmail.threads.search): each message\'s from, to, date and text (capped). Never sends or changes anything.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, ...holderArg }, required: ['id'] },
    establishes: 'lookup',
  },
  {
    id: GMAIL_DRAFT_CREATE,
    verbs: ['draft a reply', 'draft an email', 'write an email to', 'prepare a reply', 'draft a message to'],
    description: 'WRITES A DRAFT in the person\'s Gmail under her mandate — to, subject, body; `threadId` to draft a reply in a thread. It is a draft: nothing is sent; she sends from Gmail herself.',
    inputSchema: { type: 'object', properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' }, threadId: { type: 'string' }, cc: { type: 'string' }, ...holderArg }, required: ['to', 'subject', 'body'] },
    capability: { id: GMAIL_DRAFT_CREATE, action: 'draft', resourceArg: 'holder', authorityArg: 'holder' },
    risk: 'medium',
    establishes: 'submission',
  },
  {
    id: DRIVE_FILES_SEARCH,
    answers: ['find the document', 'search my drive', 'the spreadsheet about', 'which files mention', 'my recent files'],
    description: 'SEARCHES the person\'s Google Drive by words (in the name or the text); `max` caps the files. Each file: name, kind (Google Doc, Sheet, PDF…), when modified, a link. Says when Drive is not connected.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, max: { type: 'integer' }, ...holderArg } },
    establishes: 'lookup',
  },
  {
    id: DRIVE_FILE_READ,
    answers: ['read the document', 'what does the doc say', 'summarize the file', 'open the spreadsheet'],
    description: 'READS one Drive file by id (from drive.files.search) as text — a Google Doc, Sheet (as CSV) or Slides exported, a text file as it is; a PDF or image is named, not read. Capped.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, ...holderArg }, required: ['id'] },
    establishes: 'lookup',
  },
];

export interface MailDriveDeps { env: TokenEnv; resolveName?: (name: string) => Promise<string | null>; fetch?: typeof fetch }

async function holderOf(deps: MailDriveDeps, args: Record<string, unknown>, presented: { wire?: { delegator?: string } } | null, person: string | undefined): Promise<`0x${string}`> {
  const fromMandate = presented?.wire?.delegator;
  const raw = String(args.holder ?? fromMandate ?? person ?? '').trim();
  let address = /^0x[0-9a-fA-F]{40}$/.test(raw) ? raw.toLowerCase() : '';
  if (!address && raw && deps.resolveName) address = ((await deps.resolveName(raw).catch(() => null)) ?? '').toLowerCase();
  if (!address) throw new Error('whose account? — name the person (holder)');
  if (fromMandate && fromMandate.toLowerCase() !== address) throw new Error(`the mandate is ${fromMandate}'s, but the account asked for is ${address}'s — an act on a connector is authorized by its holder`);
  return address as `0x${string}`;
}

export function mailDriveInvoker(deps: MailDriveDeps, presented: { wire?: { delegator?: string } } | null, person: string | undefined): ToolInvoker {
  return async (toolId, args) => {
    const holder = await holderOf(deps, args, presented, person);
    const f = deps.fetch ?? fetch;
    const notConnected = (what: string) => ({ refused: `${what} is not connected — connect it at the Home (Connected → ${what === 'Gmail' ? 'Gmail' : 'Google Drive'})`, holder, connected: false });
    switch (toolId) {
      case GMAIL_THREADS_SEARCH: {
        const out = await searchThreads(deps.env, holder, { ...(typeof args.query === 'string' ? { query: args.query } : {}), ...(typeof args.max === 'number' ? { max: args.max } : {}) }, f);
        if (!out) return notConnected('Gmail');
        return { holder, connected: true, ...out, count: out.threads.length, answer: out.threads.length ? out.threads.map((t) => `${t.date.slice(0, 16)} — ${t.from.replace(/<.*>/, '').trim()}: ${t.subject}${t.unread ? ' (unread)' : ''}`).join('\n') : `No mail matches "${out.query}".` };
      }
      case GMAIL_THREAD_READ: { const out = await readThread(deps.env, holder, String(args.id ?? ''), f); return out ? { holder, connected: true, ...out } : notConnected('Gmail'); }
      case GMAIL_DRAFT_CREATE: {
        const out = await createDraft(deps.env, holder, { to: String(args.to), subject: String(args.subject), body: String(args.body), ...(typeof args.threadId === 'string' ? { threadId: args.threadId } : {}), ...(typeof args.cc === 'string' ? { cc: args.cc } : {}) }, f);
        if (!out) return notConnected('Gmail');
        return { drafted: true, holder, ...out, note: 'a draft in your Gmail — nothing was sent; send it from Gmail yourself' };
      }
      case DRIVE_FILES_SEARCH: {
        const out = await searchFiles(deps.env, holder, { ...(typeof args.query === 'string' ? { query: args.query } : {}), ...(typeof args.max === 'number' ? { max: args.max } : {}) }, f);
        if (!out) return notConnected('Google Drive');
        return { holder, connected: true, ...out, count: out.files.length, answer: out.files.length ? out.files.map((x) => `${x.name} — ${x.kind}, modified ${x.modifiedAt.slice(0, 10)}`).join('\n') : `No files match "${out.query}".` };
      }
      case DRIVE_FILE_READ: { const out = await readFile(deps.env, holder, String(args.id ?? ''), f); return out ? { holder, connected: true, ...out } : notConnected('Google Drive'); }
      default: throw new Error(`${toolId} is not a mail or drive capability`);
    }
  };
}

/** For the Home's Connected page: which of the three Google connectors are connected. */
export async function googleConnectorsStatus(env: TokenEnv, sa: `0x${string}`): Promise<Record<'google-calendar' | 'google-gmail' | 'google-drive', Awaited<ReturnType<typeof connectorStatus>>>> {
  const [c, g, d] = await Promise.all([connectorStatus(env, sa, 'google-calendar'), connectorStatus(env, sa, 'google-gmail'), connectorStatus(env, sa, 'google-drive')]);
  return { 'google-calendar': c, 'google-gmail': g, 'google-drive': d };
}
