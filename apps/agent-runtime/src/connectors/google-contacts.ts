// GOOGLE CONTACTS — the person's address book, read only (People API connections). Used to invite friends by
// email: the list is an observation, never stored as friends. Friends stay two signed contact grants.
import type { Address } from 'viem';
import { accessFor as accessForProvider, googleApi, type TokenEnv } from './google-token.js';

export const CONTACTS_SCOPE_READ = 'https://www.googleapis.com/auth/contacts.readonly';
const API = 'https://people.googleapis.com/v1/people/me/connections';
const accessFor = (env: TokenEnv, sa: Address, f: typeof fetch) => accessForProvider(env, sa, 'google-contacts', f);

export interface GoogleContactRow { name: string | null; email: string }

const emailOf = (person: { emailAddresses?: Array<{ value?: string; metadata?: { primary?: boolean } }> }): string | null => {
  const xs = person.emailAddresses ?? [];
  const primary = xs.find((e) => e.metadata?.primary && e.value)?.value ?? xs.find((e) => e.value)?.value;
  const raw = (primary ?? '').trim().toLowerCase();
  return raw.includes('@') ? raw : null;
};

/** Saved connections that have an email, name-sorted. `null` = not connected. Never writes. */
export async function listConnections(env: TokenEnv, sa: Address, opts: { query?: string; max?: number } = {}, f: typeof fetch = fetch): Promise<{ people: GoogleContactRow[]; query: string } | null> {
  const got = await accessFor(env, sa, f);
  if (!got) return null;
  const max = Math.min(Math.max(opts.max ?? 100, 1), 300);
  const query = (opts.query ?? '').trim().toLowerCase();
  const people: GoogleContactRow[] = [];
  let pageToken = '';
  for (let page = 0; page < 3 && people.length < max; page += 1) {
    const q = new URLSearchParams({ personFields: 'names,emailAddresses', pageSize: '200', sortOrder: 'FIRST_NAME_ASCENDING' });
    if (pageToken) q.set('pageToken', pageToken);
    const body = await googleApi(got.access, `${API}?${q.toString()}`, { method: 'GET' }, f, 'Contacts');
    const rows = Array.isArray(body.connections) ? (body.connections as Array<{ names?: Array<{ displayName?: string }>; emailAddresses?: Array<{ value?: string; metadata?: { primary?: boolean } }> }>) : [];
    for (const p of rows) {
      const email = emailOf(p);
      if (!email) continue;
      const name = (p.names?.[0]?.displayName ?? '').trim() || null;
      if (query && !(email.includes(query) || (name ?? '').toLowerCase().includes(query))) continue;
      people.push({ name, email });
      if (people.length >= max) break;
    }
    pageToken = typeof body.nextPageToken === 'string' ? body.nextPageToken : '';
    if (!pageToken) break;
  }
  people.sort((a, b) => (a.name ?? a.email).localeCompare(b.name ?? b.email));
  return { people, query };
}
