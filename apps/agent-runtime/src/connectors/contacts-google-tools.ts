// GOOGLE CONTACTS AS A READ — the person's address book, for inviting a friend by email. The list is an
// observation (who is in her Google book right now). It is never stored as a friend: friends are two signed
// contact grants. Connect at the Home; if it is not connected, say so.
import type { ToolSpec, ToolInvoker } from '@agenticprimitives/orchestration';
import { listConnections } from './google-contacts.js';
import type { TokenEnv } from './google-token.js';

export const CONTACTS_CONNECTIONS_LIST = 'contacts.connections.list' as const;
export const CONTACTS_GOOGLE_TOOLS: ToolSpec[] = [
  {
    id: CONTACTS_CONNECTIONS_LIST,
    answers: ['who is in my google contacts', 'people in my address book', 'invite from gmail contacts', 'list my google contacts'],
    description: 'LISTS the person\'s Google Contacts that have an email (the book she connected at her Home). `query` filters by name or address; `max` caps the rows (default 100). Each row is a name and an email — a source for inviting a friend, never a friend itself. Says when Contacts is not connected. Never writes, never stores the list.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, max: { type: 'integer' }, holder: { type: 'string', description: 'Whose book — the person; defaults to the asker' } } },
    establishes: 'lookup',
  },
];

export interface ContactsGoogleDeps { env: TokenEnv; resolveName?: (name: string) => Promise<string | null>; fetch?: typeof fetch }

async function holderOf(deps: ContactsGoogleDeps, args: Record<string, unknown>, person: string | undefined): Promise<`0x${string}`> {
  const raw = String(args.holder ?? person ?? '').trim();
  let address = /^0x[0-9a-fA-F]{40}$/.test(raw) ? raw.toLowerCase() : '';
  if (!address && raw && deps.resolveName) address = ((await deps.resolveName(raw).catch(() => null)) ?? '').toLowerCase();
  if (!address) throw new Error('whose contacts? — name the person (holder)');
  return address as `0x${string}`;
}

export function contactsGoogleInvoker(deps: ContactsGoogleDeps, person: string | undefined): ToolInvoker {
  return async (toolId, args) => {
    if (toolId !== CONTACTS_CONNECTIONS_LIST) throw new Error(`${toolId} is not a Google contacts capability`);
    const holder = await holderOf(deps, args, person);
    const out = await listConnections(deps.env, holder, { ...(typeof args.query === 'string' ? { query: args.query } : {}), ...(typeof args.max === 'number' ? { max: args.max } : {}) }, deps.fetch ?? fetch);
    if (!out) return { refused: 'Google Contacts is not connected — connect it at the Home (Connected → Your accounts, or Contacts → Friends)', holder, connected: false };
    return { holder, connected: true, ...out, count: out.people.length, answer: out.people.length ? out.people.map((p) => `${p.name ?? p.email} <${p.email}>`).join('\n') : out.query ? `No Google contact matches "${out.query}".` : 'No Google contacts with an email.', note: 'these are emails in your Google book — inviting one sends mail; you are friends only when they add you back' };
  };
}
