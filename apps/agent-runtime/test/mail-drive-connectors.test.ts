import { describe, it, expect } from 'vitest';
process.env.A2A_SESSION_SECRET ??= 'ab'.repeat(32);
import { storeFederatedToken } from '../src/fed-token.js';
import { GMAIL_SCOPE_READ, GMAIL_SCOPE_COMPOSE } from '../src/connectors/google-gmail.js';
import { DRIVE_SCOPE_READ } from '../src/connectors/google-drive.js';
import { mailDriveInvoker, GMAIL_THREADS_SEARCH, GMAIL_THREAD_READ, GMAIL_DRAFT_CREATE, GMAIL_MESSAGE_SEND, DRIVE_FILES_SEARCH, DRIVE_FILE_READ } from '../src/connectors/mail-drive-tools.js';

const kv = () => { const m = new Map<string, string>(); return { get: async (k: string) => m.get(k) ?? null, put: async (k: string, v: string) => { m.set(k, v); }, delete: async (k: string) => { m.delete(k); } } as unknown as KVNamespace; };
const ALICE = '0x' + 'a'.repeat(40) as `0x${string}`;
const BOB = '0x' + 'b'.repeat(40) as `0x${string}`;
const env = () => ({ FED_TOKENS: kv(), GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'sec' });
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
const google = (calls: Array<{ url: string; init?: RequestInit }> = []) => (async (url: string | URL | Request, init?: RequestInit) => {
  const u = String(url); calls.push({ url: u, ...(init ? { init } : {}) });
  if (u.includes('/gmail/v1/users/me/threads?')) return new Response(JSON.stringify({ threads: [{ id: 't1' }] }));
  if (u.includes('/gmail/v1/users/me/threads/t1?format=metadata')) return new Response(JSON.stringify({ messages: [{ id: 'm1', snippet: 'Retreat plan attached', labelIds: ['UNREAD'], payload: { headers: [{ name: 'Subject', value: 'Retreat' }, { name: 'From', value: 'Pastor <p@x.org>' }, { name: 'Date', value: 'Mon, 14 Sep 2026' }] } }] }));
  if (u.includes('/gmail/v1/users/me/threads/t1?format=full')) return new Response(JSON.stringify({ messages: [{ id: 'm1', payload: { mimeType: 'multipart/alternative', headers: [{ name: 'Subject', value: 'Retreat' }, { name: 'From', value: 'p@x.org' }, { name: 'To', value: 'a@x.org' }, { name: 'Date', value: 'Mon' }], parts: [{ mimeType: 'text/plain', body: { data: b64('Can we meet Thursday?') } }] } }] }));
  if (u.endsWith('/gmail/v1/users/me/drafts')) { const raw = JSON.parse(String(init?.body)).message.raw as string; return new Response(JSON.stringify({ id: 'd1', message: { id: 'dm1', raw } })); }
  if (u.endsWith('/gmail/v1/users/me/drafts/send')) return new Response(JSON.stringify({ id: 'sent1', threadId: 't1' }));
  if (u.endsWith('/gmail/v1/users/me/messages/send')) { const body = JSON.parse(String(init?.body)) as { raw: string; threadId?: string }; return new Response(JSON.stringify({ id: 'sent2', threadId: body.threadId ?? 'tn', raw: body.raw })); }
  if (u.includes('/drive/v3/files?')) return new Response(JSON.stringify({ files: [{ id: 'f1', name: 'Retreat budget', mimeType: 'application/vnd.google-apps.spreadsheet', modifiedTime: '2026-09-10T00:00:00Z', webViewLink: 'https://docs/f1' }] }));
  if (u.includes('/drive/v3/files/f1?fields')) return new Response(JSON.stringify({ id: 'f1', name: 'Retreat budget', mimeType: 'application/vnd.google-apps.spreadsheet', modifiedTime: '2026-09-10T00:00:00Z' }));
  if (u.includes('/drive/v3/files/f1/export')) return new Response('item,cost\nvenue,1200');
  return new Response('not found', { status: 404 });
}) as unknown as typeof fetch;

describe('Gmail and Drive as capabilities (spec 402 W2)', () => {
  it('mail: search summarises threads, read gives text; a draft needs the compose scope and the holder\'s mandate; never sends', async () => {
    const e = env();
    await storeFederatedToken(e, ALICE, { access: 'a', refresh: 'r' }, 3600, GMAIL_SCOPE_READ, 'alice@x.org', 'google-gmail');
    const calls: Array<{ url: string }> = [];
    const inv = mailDriveInvoker({ env: e, fetch: google(calls) }, null, ALICE);
    const s = await inv(GMAIL_THREADS_SEARCH, { query: 'from:p@x.org' }, {} as never) as { count: number; threads: Array<{ subject: string; unread: boolean }>; answer: string };
    expect(s.count).toBe(1); expect(s.threads[0]!.subject).toBe('Retreat'); expect(s.threads[0]!.unread).toBe(true); expect(s.answer).toContain('(unread)');
    expect(calls[0]!.url).toContain('q=from%3Ap%40x.org');
    const r = await inv(GMAIL_THREAD_READ, { id: 't1' }, {} as never) as { messages: Array<{ text: string }> };
    expect(r.messages[0]!.text).toBe('Can we meet Thursday?');
    await expect(inv(GMAIL_DRAFT_CREATE, { to: 'p@x.org', subject: 'Re: Retreat', body: 'Thursday works.' }, {} as never)).rejects.toThrow(/read-only/);
    await storeFederatedToken(e, ALICE, { access: 'a', refresh: 'r' }, 3600, `${GMAIL_SCOPE_READ} ${GMAIL_SCOPE_COMPOSE}`, 'alice@x.org', 'google-gmail');
    await expect(mailDriveInvoker({ env: e, fetch: google() }, { wire: { delegator: BOB } }, ALICE)(GMAIL_DRAFT_CREATE, { holder: ALICE, to: 'p@x.org', subject: 's', body: 'b' }, {} as never)).rejects.toThrow(/authorized by its holder/);
    const d = await mailDriveInvoker({ env: e, fetch: google(calls) }, { wire: { delegator: ALICE } }, ALICE)(GMAIL_DRAFT_CREATE, { to: 'p@x.org', subject: 'Re: Retreat', body: 'Thursday works.', threadId: 't1' }, {} as never) as { drafted: boolean; draftId: string; note: string };
    expect(d.drafted).toBe(true); expect(d.draftId).toBe('d1'); expect(d.note).toMatch(/nothing was sent/);
    expect(calls.some((c) => c.url.includes('/send'))).toBe(false);
    // what may follow: the draft as it is, under her signature — proposed, not done
    expect((d as { next?: { capability: string; args: { draftId: string } } }).next).toMatchObject({ capability: GMAIL_MESSAGE_SEND, args: { draftId: 'd1' } });
    const none = await mailDriveInvoker({ env: e, fetch: google() }, null, BOB)(GMAIL_THREADS_SEARCH, {}, {} as never) as { refused?: string };
    expect(none.refused).toMatch(/Gmail is not connected/);
  });
  it('send (spec 402 W5): a draft by id goes as it is, a message goes whole in its thread; read-only refuses; the holder\'s mandate, no one else\'s', async () => {
    const e = env();
    await storeFederatedToken(e, ALICE, { access: 'a', refresh: 'r' }, 3600, GMAIL_SCOPE_READ, 'alice@x.org', 'google-gmail');
    await expect(mailDriveInvoker({ env: e, fetch: google() }, { wire: { delegator: ALICE } }, ALICE)(GMAIL_MESSAGE_SEND, { draftId: 'd1' }, {} as never)).rejects.toThrow(/read-only/);
    await storeFederatedToken(e, ALICE, { access: 'a', refresh: 'r' }, 3600, `${GMAIL_SCOPE_READ} ${GMAIL_SCOPE_COMPOSE}`, 'alice@x.org', 'google-gmail');
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const inv = mailDriveInvoker({ env: e, fetch: google(calls) }, { wire: { delegator: ALICE } }, ALICE);
    const a = await inv(GMAIL_MESSAGE_SEND, { draftId: 'd1' }, {} as never) as { sent: boolean; sentAs: string; messageId: string; note: string };
    expect(a.sent).toBe(true); expect(a.sentAs).toBe('draft'); expect(a.messageId).toBe('sent1'); expect(a.note).toMatch(/as you/);
    expect(JSON.parse(String(calls.at(-1)!.init?.body))).toEqual({ id: 'd1' });
    const b = await inv(GMAIL_MESSAGE_SEND, { to: 'p@x.org', subject: 'Re: Retreat', body: 'Thursday works.', threadId: 't1' }, {} as never) as { sent: boolean; sentAs: string; threadId: string; to: string };
    expect(b.sentAs).toBe('message'); expect(b.threadId).toBe('t1'); expect(b.to).toBe('p@x.org');
    const raw = Buffer.from(String(JSON.parse(String(calls.at(-1)!.init?.body)).raw).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    expect(raw).toContain('To: p@x.org'); expect(raw).toContain('Subject: Re: Retreat'); expect(raw.endsWith('Thursday works.')).toBe(true);
    await expect(inv(GMAIL_MESSAGE_SEND, { to: 'p@x.org' }, {} as never)).rejects.toThrow(/to, subject and body/);
    await expect(mailDriveInvoker({ env: e, fetch: google() }, { wire: { delegator: BOB } }, ALICE)(GMAIL_MESSAGE_SEND, { holder: ALICE, draftId: 'd1' }, {} as never)).rejects.toThrow(/authorized by its holder/);
    const none = await mailDriveInvoker({ env: e, fetch: google() }, { wire: { delegator: BOB } }, BOB)(GMAIL_MESSAGE_SEND, { draftId: 'd1' }, {} as never) as { refused?: string };
    expect(none.refused).toMatch(/Gmail is not connected/);
  });
  it('drive: search lists files by kind; read exports a Sheet as CSV', async () => {
    const e = env();
    await storeFederatedToken(e, ALICE, { access: 'a', refresh: 'r' }, 3600, DRIVE_SCOPE_READ, 'alice@x.org', 'google-drive');
    const inv = mailDriveInvoker({ env: e, fetch: google() }, null, ALICE);
    const s = await inv(DRIVE_FILES_SEARCH, { query: 'retreat' }, {} as never) as { count: number; files: Array<{ kind: string }>; answer: string };
    expect(s.count).toBe(1); expect(s.files[0]!.kind).toBe('Google Sheet'); expect(s.answer).toContain('Retreat budget');
    const r = await inv(DRIVE_FILE_READ, { id: 'f1' }, {} as never) as { text: string; truncated: boolean };
    expect(r.text).toContain('venue,1200'); expect(r.truncated).toBe(false);
  });
});
