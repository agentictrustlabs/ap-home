// SPEC 400 W4 — GOOGLE CALENDAR AS A CAPABILITY under the delegation model (the second connector; GitHub was the first).
//
// The PERSON's credential — the OAuth refresh token Google issued when she connected her calendar at the Home — is
// envelope-encrypted in `FED_TOKENS` under her SA (`fed-token.ts`, the YouVersion store generalised by provider). It is
// read ONLY here: the harness's tools call `listEvents`/`createEvent` with her SA, the token never leaves the Worker,
// and every act is a harness step — a read under her own standing, a write under a mandate she signed. Refresh is a
// server-to-server exchange with the deployment's Google client (`GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET`, the same
// client the Home signs in with). A connector's credential is never an agent's: a runtime, a steward or an app asks the
// harness, which answers as her.
import type { Address } from 'viem';
import { loadFederatedToken, storeFederatedToken, deleteFederatedToken } from '../fed-token.js';

export interface CalendarEnv { GOOGLE_CLIENT_ID?: string; GOOGLE_CLIENT_SECRET?: string; FED_TOKENS?: KVNamespace }
type TokenEnv = Parameters<typeof loadFederatedToken>[0] & CalendarEnv;

export const CALENDAR_SCOPE_READ = 'https://www.googleapis.com/auth/calendar.readonly';
export const CALENDAR_SCOPE_EVENTS = 'https://www.googleapis.com/auth/calendar.events';
const API = 'https://www.googleapis.com/calendar/v3';

export interface CalendarEvent { id: string; summary: string; start: string; end: string; allDay: boolean; location?: string; description?: string; attendees?: Array<{ email: string; response?: string }>; link?: string; organizer?: string; status?: string }

/** Google's own refresh-token exchange (confidential client: id + secret). A refused refresh is a disconnected calendar. */
export async function refreshGoogleToken(env: CalendarEnv, refresh: string, f: typeof fetch = fetch): Promise<{ access: string; expiresIn: number | null; scope: string | null } | null> {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return null;
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET });
  const res = await f('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: body.toString() });
  if (!res.ok) return null;
  const j = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number | string; scope?: string };
  if (!j.access_token) return null;
  return { access: j.access_token, expiresIn: j.expires_in != null ? Number(j.expires_in) : null, scope: j.scope ?? null };
}

/** The connection's state, for the Home and the tools: connected (which scopes, which account) or not. */
export async function calendarStatus(env: TokenEnv, sa: Address): Promise<{ connected: false } | { connected: true; scope: string | null; account: string | null; canWrite: boolean }> {
  const loaded = await loadFederatedToken(env, sa, 'google-calendar');
  if (!loaded) return { connected: false };
  const scope = loaded.scope;
  return { connected: true, scope, account: loaded.appKey || null, canWrite: !!scope && scope.split(' ').includes(CALENDAR_SCOPE_EVENTS) };
}

export async function disconnectCalendar(env: TokenEnv, sa: Address): Promise<void> {
  await deleteFederatedToken(env, sa, 'google-calendar');
}

/** An access token for the person, refreshed when near expiry (and the refreshed one kept). `null` = not connected. */
async function accessFor(env: TokenEnv, sa: Address, f: typeof fetch): Promise<{ access: string; scope: string | null } | null> {
  const loaded = await loadFederatedToken(env, sa, 'google-calendar');
  if (!loaded) return null;
  if (loaded.exp - Math.floor(Date.now() / 1000) > 60) return { access: loaded.tokens.access, scope: loaded.scope };
  if (!loaded.tokens.refresh) return null;
  const r = await refreshGoogleToken(env, loaded.tokens.refresh, f);
  if (!r) return null;
  await storeFederatedToken(env, sa, { access: r.access, refresh: loaded.tokens.refresh }, r.expiresIn, r.scope ?? loaded.scope, loaded.appKey, 'google-calendar');
  return { access: r.access, scope: r.scope ?? loaded.scope };
}

async function api(access: string, path: string, init: RequestInit, f: typeof fetch): Promise<Record<string, unknown>> {
  const res = await f(`${API}${path}`, { ...init, headers: { authorization: `Bearer ${access}`, accept: 'application/json', ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.headers ?? {}) } });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try { body = JSON.parse(text) as Record<string, unknown>; } catch { body = { raw: text.slice(0, 200) }; }
  if (!res.ok) {
    const err = (body.error as { message?: string; status?: string } | undefined);
    throw new Error(`Google Calendar ${res.status}: ${err?.message ?? err?.status ?? text.slice(0, 120)}`);
  }
  return body;
}

const eventOf = (e: Record<string, unknown>): CalendarEvent => {
  const start = (e.start as { dateTime?: string; date?: string } | undefined) ?? {};
  const end = (e.end as { dateTime?: string; date?: string } | undefined) ?? {};
  const attendees = Array.isArray(e.attendees) ? (e.attendees as Array<{ email?: string; responseStatus?: string }>).filter((a) => a.email).map((a) => ({ email: String(a.email), ...(a.responseStatus ? { response: a.responseStatus } : {}) })) : undefined;
  return {
    id: String(e.id ?? ''), summary: String(e.summary ?? '(no title)'), start: start.dateTime ?? start.date ?? '', end: end.dateTime ?? end.date ?? '', allDay: !start.dateTime && !!start.date,
    ...(typeof e.location === 'string' ? { location: e.location } : {}), ...(typeof e.description === 'string' ? { description: e.description.slice(0, 500) } : {}),
    ...(attendees?.length ? { attendees } : {}), ...(typeof e.htmlLink === 'string' ? { link: e.htmlLink } : {}),
    ...((e.organizer as { email?: string } | undefined)?.email ? { organizer: String((e.organizer as { email: string }).email) } : {}), ...(typeof e.status === 'string' ? { status: e.status } : {}),
  };
};

/** The person's events in a window (default: the next 24 hours), ordered by start. `null` = not connected. */
export async function listEvents(env: TokenEnv, sa: Address, opts: { timeMin?: string; timeMax?: string; max?: number; query?: string; calendarId?: string } = {}, f: typeof fetch = fetch): Promise<{ events: CalendarEvent[]; window: { from: string; to: string }; calendar: string } | null> {
  const got = await accessFor(env, sa, f);
  if (!got) return null;
  const from = opts.timeMin ?? new Date().toISOString();
  const to = opts.timeMax ?? new Date(Date.parse(from) + 24 * 3600_000).toISOString();
  const calendar = opts.calendarId ?? 'primary';
  const q = new URLSearchParams({ timeMin: from, timeMax: to, singleEvents: 'true', orderBy: 'startTime', maxResults: String(Math.min(Math.max(opts.max ?? 25, 1), 100)), ...(opts.query ? { q: opts.query } : {}) });
  const body = await api(got.access, `/calendars/${encodeURIComponent(calendar)}/events?${q.toString()}`, { method: 'GET' }, f);
  const items = Array.isArray(body.items) ? (body.items as Record<string, unknown>[]) : [];
  return { events: items.map(eventOf), window: { from, to }, calendar };
}

/** Create one event — the WRITE, always a harness step under the person's mandate. Needs the events scope. */
export async function createEvent(env: TokenEnv, sa: Address, input: { summary: string; start: string; end: string; allDay?: boolean; location?: string; description?: string; attendees?: string[]; calendarId?: string }, f: typeof fetch = fetch): Promise<CalendarEvent | null> {
  const got = await accessFor(env, sa, f);
  if (!got) return null;
  if (!got.scope || !got.scope.split(' ').includes(CALENDAR_SCOPE_EVENTS)) throw new Error('this calendar was connected read-only — reconnect it with permission to add events');
  const calendar = input.calendarId ?? 'primary';
  const when = (v: string) => (input.allDay ? { date: v.slice(0, 10) } : { dateTime: v });
  const payload: Record<string, unknown> = { summary: input.summary, start: when(input.start), end: when(input.end), ...(input.location ? { location: input.location } : {}), ...(input.description ? { description: input.description } : {}), ...(input.attendees?.length ? { attendees: input.attendees.map((email) => ({ email })) } : {}) };
  const body = await api(got.access, `/calendars/${encodeURIComponent(calendar)}/events`, { method: 'POST', body: JSON.stringify(payload) }, f);
  return eventOf(body);
}
