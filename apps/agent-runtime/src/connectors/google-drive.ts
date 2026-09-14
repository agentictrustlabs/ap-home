// GOOGLE DRIVE AS A CAPABILITY — spec 402 W2, read-only in this wave. Search files by words (name or full text), read
// one file's text (a Google Doc / Sheet / Slides exported as text or CSV; a text-like file as it is; anything else is
// named and not read). The person's own connector on the Calendar's shape; the token never leaves the Worker.
import type { Address } from 'viem';
import { accessFor as accessForProvider, googleApi, type TokenEnv } from './google-token.js';

export const DRIVE_SCOPE_READ = 'https://www.googleapis.com/auth/drive.readonly';
const API = 'https://www.googleapis.com/drive/v3';
const accessFor = (env: TokenEnv, sa: Address, f: typeof fetch) => accessForProvider(env, sa, 'google-drive', f);

export interface DriveFile { id: string; name: string; mimeType: string; kind: string; modifiedAt: string; owner?: string; link?: string; size?: number }

const KIND: Record<string, string> = {
  'application/vnd.google-apps.document': 'Google Doc', 'application/vnd.google-apps.spreadsheet': 'Google Sheet', 'application/vnd.google-apps.presentation': 'Google Slides',
  'application/vnd.google-apps.folder': 'folder', 'application/pdf': 'PDF', 'text/plain': 'text', 'text/markdown': 'markdown', 'text/csv': 'CSV',
};
const EXPORT: Record<string, string> = { 'application/vnd.google-apps.document': 'text/plain', 'application/vnd.google-apps.spreadsheet': 'text/csv', 'application/vnd.google-apps.presentation': 'text/plain' };
const fileOf = (r: Record<string, unknown>): DriveFile => ({ id: String(r.id ?? ''), name: String(r.name ?? ''), mimeType: String(r.mimeType ?? ''), kind: KIND[String(r.mimeType ?? '')] ?? String(r.mimeType ?? '').split('/').pop() ?? 'file', modifiedAt: String(r.modifiedTime ?? ''), ...(Array.isArray(r.owners) && (r.owners as Array<{ emailAddress?: string }>)[0]?.emailAddress ? { owner: String((r.owners as Array<{ emailAddress: string }>)[0]!.emailAddress) } : {}), ...(typeof r.webViewLink === 'string' ? { link: r.webViewLink } : {}), ...(r.size ? { size: Number(r.size) } : {}) });

const esc = (s: string): string => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

/** Files whose name or text contains the words, newest first. `null` = not connected. */
export async function searchFiles(env: TokenEnv, sa: Address, opts: { query?: string; max?: number; folderId?: string } = {}, f: typeof fetch = fetch): Promise<{ files: DriveFile[]; query: string } | null> {
  const got = await accessFor(env, sa, f);
  if (!got) return null;
  const words = (opts.query ?? '').trim();
  const q = [`trashed = false`, ...(words ? [`(name contains '${esc(words)}' or fullText contains '${esc(words)}')`] : []), ...(opts.folderId ? [`'${esc(opts.folderId)}' in parents`] : [])].join(' and ');
  const params = new URLSearchParams({ q, pageSize: String(Math.min(Math.max(opts.max ?? 10, 1), 50)), orderBy: 'modifiedTime desc', fields: 'files(id,name,mimeType,modifiedTime,owners(emailAddress),webViewLink,size)' });
  const body = await googleApi(got.access, `${API}/files?${params.toString()}`, { method: 'GET' }, f, 'Google Drive');
  const files = Array.isArray(body.files) ? (body.files as Record<string, unknown>[]).map(fileOf) : [];
  return { files, query: words || '(recent)' };
}

/** One file's text, capped. A Google Doc/Sheet/Slides is exported; a text-like file is read; anything else is named, not read. */
export async function readFile(env: TokenEnv, sa: Address, id: string, f: typeof fetch = fetch, capChars = 12000): Promise<{ file: DriveFile; text: string | null; truncated: boolean; note?: string } | null> {
  const got = await accessFor(env, sa, f);
  if (!got) return null;
  const meta = fileOf(await googleApi(got.access, `${API}/files/${encodeURIComponent(id)}?fields=id,name,mimeType,modifiedTime,owners(emailAddress),webViewLink,size`, { method: 'GET' }, f, 'Google Drive'));
  const exportAs = EXPORT[meta.mimeType];
  const textLike = meta.mimeType.startsWith('text/') || meta.mimeType === 'application/json';
  if (!exportAs && !textLike) return { file: meta, text: null, truncated: false, note: `a ${meta.kind} is not read as text here — open it in Drive` };
  const url = exportAs ? `${API}/files/${encodeURIComponent(id)}/export?mimeType=${encodeURIComponent(exportAs)}` : `${API}/files/${encodeURIComponent(id)}?alt=media`;
  const res = await f(url, { headers: { authorization: `Bearer ${got.access}` } });
  if (!res.ok) throw new Error(`Google Drive ${res.status}: ${(await res.text()).slice(0, 120)}`);
  const full = await res.text();
  return { file: meta, text: full.slice(0, capChars), truncated: full.length > capChars };
}
