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
import { accessFor as accessForProvider, connectorStatus, disconnectConnector, googleApi, hasScope, refreshGoogleToken as refresh, type TokenEnv } from './google-token.js';

export type CalendarEnv = TokenEnv;
export const refreshGoogleToken = refresh;

export const CALENDAR_SCOPE_READ = 'https://www.googleapis.com/auth/calendar.readonly';
export const CALENDAR_SCOPE_EVENTS = 'https://www.googleapis.com/auth/calendar.events';
const API = 'https://www.googleapis.com/calendar/v3';

export interface CalendarEvent { id: string; summary: string; start: string; end: string; allDay: boolean; location?: string; description?: string; attendees?: Array<{ email: string; response?: string }>; link?: string; organizer?: string; status?: string; /** An instance of a repeating event (Google's `recurringEventId`) — spec 402 W5b reads a habit off it. */ recurring?: boolean }

/** The connection's state, for the Home and the tools: connected (which scopes, which account) or not. */
export async function calendarStatus(env: TokenEnv, sa: Address): Promise<{ connected: false } | { connected: true; scope: string | null; account: string | null; canWrite: boolean }> {
  const st = await connectorStatus(env, sa, 'google-calendar');
  return st.connected ? { connected: true, scope: st.scope, account: st.account, canWrite: hasScope(st.scope, CALENDAR_SCOPE_EVENTS) } : { connected: false };
}
export const disconnectCalendar = (env: TokenEnv, sa: Address): Promise<void> => disconnectConnector(env, sa, 'google-calendar');
const accessFor = (env: TokenEnv, sa: Address, f: typeof fetch) => accessForProvider(env, sa, 'google-calendar', f);
const api = (access: string, path: string, init: RequestInit, f: typeof fetch) => googleApi(access, `${API}${path}`, init, f, 'Google Calendar');

const eventOf = (e: Record<string, unknown>): CalendarEvent => {
  const start = (e.start as { dateTime?: string; date?: string } | undefined) ?? {};
  const end = (e.end as { dateTime?: string; date?: string } | undefined) ?? {};
  const attendees = Array.isArray(e.attendees) ? (e.attendees as Array<{ email?: string; responseStatus?: string }>).filter((a) => a.email).map((a) => ({ email: String(a.email), ...(a.responseStatus ? { response: a.responseStatus } : {}) })) : undefined;
  return {
    id: String(e.id ?? ''), summary: String(e.summary ?? '(no title)'), start: start.dateTime ?? start.date ?? '', end: end.dateTime ?? end.date ?? '', allDay: !start.dateTime && !!start.date,
    ...(typeof e.location === 'string' ? { location: e.location } : {}), ...(typeof e.description === 'string' ? { description: e.description.slice(0, 500) } : {}),
    ...(attendees?.length ? { attendees } : {}), ...(typeof e.htmlLink === 'string' ? { link: e.htmlLink } : {}),
    ...((e.organizer as { email?: string } | undefined)?.email ? { organizer: String((e.organizer as { email: string }).email) } : {}), ...(typeof e.status === 'string' ? { status: e.status } : {}),
    ...(typeof e.recurringEventId === 'string' && e.recurringEventId ? { recurring: true } : {}),
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
  if (!hasScope(got.scope, CALENDAR_SCOPE_EVENTS)) throw new Error('this calendar was connected read-only — reconnect it with permission to add events');
  const calendar = input.calendarId ?? 'primary';
  const when = (v: string) => (input.allDay ? { date: v.slice(0, 10) } : { dateTime: v });
  const payload: Record<string, unknown> = { summary: input.summary, start: when(input.start), end: when(input.end), ...(input.location ? { location: input.location } : {}), ...(input.description ? { description: input.description } : {}), ...(input.attendees?.length ? { attendees: input.attendees.map((email) => ({ email })) } : {}) };
  const body = await api(got.access, `/calendars/${encodeURIComponent(calendar)}/events`, { method: 'POST', body: JSON.stringify(payload) }, f);
  return eventOf(body);
}

/** Spec 403 W5 — REMOVE one event: the undo of `createEvent`, under the person's mandate. Needs the events scope. `null` = not connected. */
export async function deleteEvent(env: TokenEnv, sa: Address, input: { id: string; calendarId?: string }, f: typeof fetch = fetch): Promise<{ deleted: true; id: string } | null> {
  const got = await accessFor(env, sa, f);
  if (!got) return null;
  if (!hasScope(got.scope, CALENDAR_SCOPE_EVENTS)) throw new Error('this calendar was connected read-only — reconnect it with permission to change events');
  if (!input.id.trim()) throw new Error('which event? — its id, from the calendar read or the receipt');
  await api(got.access, `/calendars/${encodeURIComponent(input.calendarId ?? 'primary')}/events/${encodeURIComponent(input.id)}`, { method: 'DELETE' }, f);
  return { deleted: true, id: input.id };
}
