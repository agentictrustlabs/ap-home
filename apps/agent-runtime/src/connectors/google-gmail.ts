// GMAIL AS A CAPABILITY — spec 402 W2, the person's own connector on the Calendar's shape (google-token.ts).
// Reads as her standing: search threads (Gmail's own query language — from:, subject:, newer_than:, is:unread — or
// plain words), read one thread (the messages' text, capped). One act under her mandate: create a DRAFT — never send
// in W2; sending mail as a person is a later, separately-mandated capability. The token never leaves the Worker.
import type { Address } from 'viem';
import { accessFor as accessForProvider, googleApi, hasScope, type TokenEnv } from './google-token.js';

export const GMAIL_SCOPE_READ = 'https://www.googleapis.com/auth/gmail.readonly';
export const GMAIL_SCOPE_COMPOSE = 'https://www.googleapis.com/auth/gmail.compose';
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const accessFor = (env: TokenEnv, sa: Address, f: typeof fetch) => accessForProvider(env, sa, 'google-gmail', f);
const api = (access: string, path: string, init: RequestInit, f: typeof fetch) => googleApi(access, `${API}${path}`, init, f, 'Gmail');

export interface MailThreadSummary { id: string; subject: string; from: string; to?: string; date: string; snippet: string; messages: number; unread: boolean; link: string }
export interface MailMessage { id: string; from: string; to: string; date: string; subject: string; text: string }

const header = (headers: Array<{ name?: string; value?: string }> | undefined, name: string): string => headers?.find((h) => (h.name ?? '').toLowerCase() === name.toLowerCase())?.value ?? '';
const b64url = (s: string): string => { try { return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); } catch { return ''; } };
const utf8ToB64url = (s: string): string => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** The first text/plain body in a message part tree (text/html stripped of tags when that is all there is). */
function textOf(part: Record<string, unknown> | undefined, depth = 0): string {
  if (!part || depth > 8) return '';
  const mime = String(part.mimeType ?? '');
  const data = (part.body as { data?: string } | undefined)?.data;
  if (mime === 'text/plain' && data) return b64url(data);
  const parts = Array.isArray(part.parts) ? (part.parts as Record<string, unknown>[]) : [];
  for (const p of parts) { const t = textOf(p, depth + 1); if (t) return t; }
  if (mime === 'text/html' && data) return b64url(data).replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return '';
}

/** Threads matching a query, newest first, each summarised from its last message's headers. `null` = not connected. */
export async function searchThreads(env: TokenEnv, sa: Address, opts: { query?: string; max?: number } = {}, f: typeof fetch = fetch): Promise<{ threads: MailThreadSummary[]; query: string } | null> {
  const got = await accessFor(env, sa, f);
  if (!got) return null;
  const max = Math.min(Math.max(opts.max ?? 10, 1), 25);
  const query = (opts.query ?? '').trim() || 'newer_than:7d';
  const list = await api(got.access, `/threads?${new URLSearchParams({ q: query, maxResults: String(max) }).toString()}`, { method: 'GET' }, f);
  const ids = Array.isArray(list.threads) ? (list.threads as Array<{ id: string }>).map((t) => t.id) : [];
  const threads: MailThreadSummary[] = [];
  for (const id of ids) {
    const t = await api(got.access, `/threads/${encodeURIComponent(id)}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Date`, { method: 'GET' }, f);
    const msgs = Array.isArray(t.messages) ? (t.messages as Array<Record<string, unknown>>) : [];
    const last = msgs[msgs.length - 1] ?? {};
    const headers = ((last.payload as { headers?: Array<{ name?: string; value?: string }> } | undefined)?.headers) ?? [];
    threads.push({ id, subject: header(headers, 'Subject') || '(no subject)', from: header(headers, 'From'), ...(header(headers, 'To') ? { to: header(headers, 'To') } : {}), date: header(headers, 'Date'), snippet: String(last.snippet ?? '').slice(0, 200), messages: msgs.length, unread: msgs.some((m) => Array.isArray(m.labelIds) && (m.labelIds as string[]).includes('UNREAD')), link: `https://mail.google.com/mail/u/0/#all/${id}` });
  }
  return { threads, query };
}

/** One thread's messages, text only, capped per message. `null` = not connected. */
export async function readThread(env: TokenEnv, sa: Address, id: string, f: typeof fetch = fetch, capChars = 4000): Promise<{ id: string; subject: string; messages: MailMessage[]; link: string } | null> {
  const got = await accessFor(env, sa, f);
  if (!got) return null;
  const t = await api(got.access, `/threads/${encodeURIComponent(id)}?format=full`, { method: 'GET' }, f);
  const msgs = Array.isArray(t.messages) ? (t.messages as Array<Record<string, unknown>>) : [];
  const messages: MailMessage[] = msgs.map((m) => {
    const payload = m.payload as Record<string, unknown> | undefined;
    const headers = (payload?.headers as Array<{ name?: string; value?: string }> | undefined) ?? [];
    const text = (textOf(payload) || String(m.snippet ?? '')).slice(0, capChars);
    return { id: String(m.id ?? ''), from: header(headers, 'From'), to: header(headers, 'To'), date: header(headers, 'Date'), subject: header(headers, 'Subject'), text };
  });
  return { id, subject: messages[0]?.subject ?? '(no subject)', messages, link: `https://mail.google.com/mail/u/0/#all/${id}` };
}

/** Create a DRAFT — the write, under the person's mandate. Needs the compose scope. Never sends. */
export async function createDraft(env: TokenEnv, sa: Address, input: { to: string; subject: string; body: string; threadId?: string; cc?: string }, f: typeof fetch = fetch): Promise<{ draftId: string; messageId: string; link: string } | null> {
  const got = await accessFor(env, sa, f);
  if (!got) return null;
  if (!hasScope(got.scope, GMAIL_SCOPE_COMPOSE)) throw new Error('mail was connected read-only — reconnect it with permission to write drafts');
  const lines = [`To: ${input.to}`, ...(input.cc ? [`Cc: ${input.cc}`] : []), `Subject: ${input.subject}`, 'Content-Type: text/plain; charset="UTF-8"', 'MIME-Version: 1.0', '', input.body];
  const payload = { message: { raw: utf8ToB64url(lines.join('\r\n')), ...(input.threadId ? { threadId: input.threadId } : {}) } };
  const d = await api(got.access, '/drafts', { method: 'POST', body: JSON.stringify(payload) }, f);
  const message = d.message as { id?: string } | undefined;
  return { draftId: String(d.id ?? ''), messageId: String(message?.id ?? ''), link: 'https://mail.google.com/mail/u/0/#drafts' };
}
