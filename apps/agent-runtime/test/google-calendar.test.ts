import { describe, it, expect } from 'vitest';
process.env.A2A_SESSION_SECRET ??= 'ab'.repeat(32);
import { storeFederatedToken, loadFederatedToken } from '../src/fed-token.js';
import { listEvents, createEvent, calendarStatus, CALENDAR_SCOPE_READ, CALENDAR_SCOPE_EVENTS } from '../src/connectors/google-calendar.js';
import { calendarInvoker, CALENDAR_EVENTS_LIST, CALENDAR_EVENT_CREATE, CALENDAR_STATUS } from '../src/connectors/calendar-tools.js';

const kv = () => { const m = new Map<string, string>(); return { get: async (k: string) => m.get(k) ?? null, put: async (k: string, v: string) => { m.set(k, v); }, delete: async (k: string) => { m.delete(k); } } as unknown as KVNamespace; };
const ALICE = '0x' + 'a'.repeat(40) as `0x${string}`;
const BOB = '0x' + 'b'.repeat(40) as `0x${string}`;
const env = () => ({ FED_TOKENS: kv(), GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'sec' });
const gcal = (items: unknown[], calls: Array<{ url: string; init?: RequestInit }> = []) => (async (url: string | URL | Request, init?: RequestInit) => {
  const u = String(url); calls.push({ url: u, ...(init ? { init } : {}) });
  if (u.startsWith('https://oauth2.googleapis.com/token')) return new Response(JSON.stringify({ access_token: 'fresh', expires_in: 3600, scope: `${CALENDAR_SCOPE_READ} ${CALENDAR_SCOPE_EVENTS}` }));
  if (init?.method === 'POST') return new Response(JSON.stringify({ id: 'e9', summary: JSON.parse(String(init.body)).summary, start: { dateTime: '2026-09-15T10:00:00Z' }, end: { dateTime: '2026-09-15T11:00:00Z' }, htmlLink: 'https://cal/e9' }));
  return new Response(JSON.stringify({ items }));
}) as unknown as typeof fetch;

describe('Google Calendar as a capability (spec 400 W4)', () => {
  it('the token is kept per (provider, person); YouVersion keeps its own', async () => {
    const e = env();
    await storeFederatedToken(e, ALICE, { access: 'a', refresh: 'r' }, 3600, CALENDAR_SCOPE_READ, 'alice@example.org', 'google-calendar');
    expect(await loadFederatedToken(e, ALICE)).toBeNull();
    expect((await loadFederatedToken(e, ALICE, 'google-calendar'))?.tokens.access).toBe('a');
    expect(await calendarStatus(e, ALICE)).toEqual({ connected: true, scope: CALENDAR_SCOPE_READ, account: 'alice@example.org', canWrite: false });
    expect(await calendarStatus(e, BOB)).toEqual({ connected: false });
  });
  it('lists events in a window as the person; not connected is said, never guessed', async () => {
    const e = env();
    await storeFederatedToken(e, ALICE, { access: 'a', refresh: 'r' }, 3600, CALENDAR_SCOPE_READ, 'alice@example.org', 'google-calendar');
    const calls: Array<{ url: string }> = [];
    const out = await listEvents(e, ALICE, { timeMin: '2026-09-15T00:00:00Z', timeMax: '2026-09-16T00:00:00Z' }, gcal([{ id: '1', summary: 'Standup', start: { dateTime: '2026-09-15T09:00:00Z' }, end: { dateTime: '2026-09-15T09:15:00Z' } }, { id: '2', summary: 'Retreat', start: { date: '2026-09-15' }, end: { date: '2026-09-16' } }], calls));
    expect(out?.events.map((x) => [x.summary, x.allDay])).toEqual([['Standup', false], ['Retreat', true]]);
    expect(calls[0]!.url).toContain('/calendars/primary/events?');
    expect(calls[0]!.url).toContain('singleEvents=true');
    expect(await listEvents(e, BOB, {}, gcal([]))).toBeNull();
  });
  it('refreshes near expiry and keeps the new access token', async () => {
    const e = env();
    await storeFederatedToken(e, ALICE, { access: 'old', refresh: 'r' }, 10, CALENDAR_SCOPE_READ, '', 'google-calendar');
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    await listEvents(e, ALICE, {}, gcal([], calls));
    expect(calls[0]!.url).toBe('https://oauth2.googleapis.com/token');
    expect((calls[1]!.init?.headers as Record<string, string>).authorization).toBe('Bearer fresh');
    expect((await loadFederatedToken(e, ALICE, 'google-calendar'))?.tokens.access).toBe('fresh');
  });
  it('a write needs the events scope and the holder\'s mandate', async () => {
    const e = env();
    await storeFederatedToken(e, ALICE, { access: 'a', refresh: 'r' }, 3600, CALENDAR_SCOPE_READ, '', 'google-calendar');
    await expect(createEvent(e, ALICE, { summary: 'x', start: '2026-09-15T10:00:00Z', end: '2026-09-15T11:00:00Z' }, gcal([]))).rejects.toThrow(/read-only/);
    await storeFederatedToken(e, ALICE, { access: 'a', refresh: 'r' }, 3600, `${CALENDAR_SCOPE_READ} ${CALENDAR_SCOPE_EVENTS}`, '', 'google-calendar');
    const inv = calendarInvoker({ env: e, fetch: gcal([]) }, { wire: { delegator: BOB } }, ALICE);
    await expect(inv(CALENDAR_EVENT_CREATE, { holder: ALICE, summary: 'x', start: '2026-09-15T10:00:00Z', end: '2026-09-15T11:00:00Z' }, { intent: { goal: 'add' } } as never)).rejects.toThrow(/authorized by its holder/);
    const ok = await calendarInvoker({ env: e, fetch: gcal([]) }, { wire: { delegator: ALICE } }, ALICE)(CALENDAR_EVENT_CREATE, { summary: 'Lunch', start: '2026-09-15T10:00:00Z', end: '2026-09-15T11:00:00Z' }, { intent: { goal: 'add' } } as never) as { created: boolean; event: { summary: string } };
    expect(ok.created).toBe(true); expect(ok.event.summary).toBe('Lunch');
  });
  it('the tools answer in words; the asker is the default holder', async () => {
    const e = env();
    await storeFederatedToken(e, ALICE, { access: 'a', refresh: 'r' }, 3600, CALENDAR_SCOPE_READ, 'alice@example.org', 'google-calendar');
    const inv = calendarInvoker({ env: e, fetch: gcal([{ id: '1', summary: 'Standup', start: { dateTime: '2026-09-15T09:00:00Z' }, end: { dateTime: '2026-09-15T09:15:00Z' } }]) }, null, ALICE);
    const r = await inv(CALENDAR_EVENTS_LIST, {}, { intent: { goal: 'today' } } as never) as { answer: string; count: number };
    expect(r.count).toBe(1); expect(r.answer).toContain('Standup');
    const st = await inv(CALENDAR_STATUS, {}, { intent: { goal: 'status' } } as never) as { connected: boolean; account: string };
    expect(st.connected).toBe(true); expect(st.account).toBe('alice@example.org');
    const none = await calendarInvoker({ env: e, fetch: gcal([]) }, null, BOB)(CALENDAR_EVENTS_LIST, {}, { intent: { goal: 'today' } } as never) as { refused?: string };
    expect(none.refused).toMatch(/not connected/);
  });
});
