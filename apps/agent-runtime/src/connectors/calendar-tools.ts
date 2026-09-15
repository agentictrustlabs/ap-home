// SPEC 400 W4 — THE CALENDAR AS CAPABILITIES. A read ("what's on my calendar today") is the person's own standing;
// an act (add an event) needs HER mandate (`authorityArg: holder`, the person the connector belongs to). The token is
// hers, kept by the Worker, read by nothing but these; the harness's receipt is the record of each act. Whoever asks
// — her Home, Claude through the Home MCP, a paired runtime — gets the harness's answer AS her, never the token.
import type { ToolSpec, ToolInvoker } from '@agenticprimitives/orchestration';
import { calendarStatus, listEvents, createEvent, deleteEvent } from './google-calendar.js';

export const CALENDAR_EVENTS_LIST = 'calendar.events.list' as const;
export const CALENDAR_EVENT_CREATE = 'calendar.event.create' as const;
export const CALENDAR_STATUS = 'calendar.status' as const;
export const CALENDAR_EVENT_DELETE = 'calendar.event.delete' as const;
export const CALENDAR_ACTS = new Set<string>([CALENDAR_EVENT_CREATE, CALENDAR_EVENT_DELETE]);

const holderArg = { holder: { type: 'string', description: 'Whose calendar — the person it belongs to (defaults to the asker)' } };

export const CALENDAR_TOOLS: ToolSpec[] = [
  {
    id: CALENDAR_EVENTS_LIST,
    answers: ["what's on my calendar", 'what do I have today', 'my meetings', 'my schedule', 'am I free', 'what is on the calendar tomorrow', 'next meeting'],
    description: 'READS the person\'s Google Calendar events in a window (default: the next 24 hours; `from`/`to` ISO times; `query` filters by words; `max` caps the count). Answers what is on the calendar — never adds or changes anything. Says when the calendar is not connected.',
    inputSchema: { type: 'object', properties: { from: { type: 'string', description: 'ISO start of the window (default now)' }, to: { type: 'string', description: 'ISO end of the window (default from + 24h)' }, query: { type: 'string' }, max: { type: 'integer' }, ...holderArg } },
    establishes: 'lookup',
  },
  {
    id: CALENDAR_STATUS,
    answers: ['is my calendar connected', 'which calendar is connected', 'calendar connection'],
    description: 'Says whether the person\'s Google Calendar is connected, which account, and whether events may be added.',
    inputSchema: { type: 'object', properties: { ...holderArg } },
    establishes: 'lookup',
  },
  {
    id: CALENDAR_EVENT_CREATE,
    verbs: ['add to my calendar', 'put on my calendar', 'schedule', 'book time', 'create an event', 'block off'],
    description: 'ADDS ONE EVENT to the person\'s Google Calendar under her mandate: summary, start and end (ISO; `allDay` with dates), optional location, description, attendee emails. Never edits or deletes.',
    inputSchema: { type: 'object', properties: { summary: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' }, allDay: { type: 'boolean' }, location: { type: 'string' }, description: { type: 'string' }, attendees: { type: 'array', items: { type: 'string' } }, ...holderArg }, required: ['summary', 'start', 'end'] },
    capability: { id: CALENDAR_EVENT_CREATE, action: 'create', resourceArg: 'holder', authorityArg: 'holder' },
    risk: 'medium',
    establishes: 'submission',
  },
  {
    id: CALENDAR_EVENT_DELETE,
    verbs: ['remove from my calendar', 'delete the event', 'cancel the event', 'take it off my calendar', 'undo that event'],
    description: 'REMOVES ONE EVENT from the person\'s Google Calendar under her mandate — by `id` (from the calendar read or the create receipt). The undo of calendar.event.create.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, calendarId: { type: 'string' }, ...holderArg }, required: ['id'] },
    capability: { id: CALENDAR_EVENT_DELETE, action: 'delete', resourceArg: 'holder', authorityArg: 'holder' },
    risk: 'medium',
  },
];

export interface CalendarToolDeps {
  env: Parameters<typeof listEvents>[0];
  resolveName?: (name: string) => Promise<string | null>;
  fetch?: typeof fetch;
}

/** Whose calendar: the mandate's delegator for an act, `holder` for a read, else the asker. */
async function holderOf(deps: CalendarToolDeps, args: Record<string, unknown>, presented: { wire?: { delegator?: string } } | null, person: string | undefined): Promise<`0x${string}`> {
  const fromMandate = presented?.wire?.delegator;
  const raw = String(args.holder ?? fromMandate ?? person ?? '').trim();
  let address = /^0x[0-9a-fA-F]{40}$/.test(raw) ? raw.toLowerCase() : '';
  if (!address && raw && deps.resolveName) address = ((await deps.resolveName(raw).catch(() => null)) ?? '').toLowerCase();
  if (!address) throw new Error('whose calendar? — name the person (holder)');
  if (fromMandate && fromMandate.toLowerCase() !== address) throw new Error(`the mandate is ${fromMandate}'s, but the calendar asked for is ${address}'s — an act on a connector is authorized by its holder`);
  return address as `0x${string}`;
}

export function calendarInvoker(deps: CalendarToolDeps, presented: { wire?: { delegator?: string } } | null, person: string | undefined): ToolInvoker {
  return async (toolId, args) => {
    const holder = await holderOf(deps, args, presented, person);
    const f = deps.fetch ?? fetch;
    const notConnected = { refused: 'this calendar is not connected — connect Google Calendar at the Home (Connected → Google Calendar)', holder, connected: false };
    switch (toolId) {
      case CALENDAR_STATUS: return { holder, ...(await calendarStatus(deps.env, holder)) };
      case CALENDAR_EVENTS_LIST: {
        const out = await listEvents(deps.env, holder, { ...(typeof args.from === 'string' ? { timeMin: args.from } : {}), ...(typeof args.to === 'string' ? { timeMax: args.to } : {}), ...(typeof args.query === 'string' ? { query: args.query } : {}), ...(typeof args.max === 'number' ? { max: args.max } : {}) }, f);
        if (!out) return notConnected;
        return { holder, connected: true, ...out, count: out.events.length, answer: out.events.length ? out.events.map((e) => `${e.allDay ? e.start : e.start.replace('T', ' ').slice(0, 16)} — ${e.summary}${e.location ? ` (${e.location})` : ''}`).join('\n') : `Nothing on the calendar between ${out.window.from.slice(0, 16).replace('T', ' ')} and ${out.window.to.slice(0, 16).replace('T', ' ')}.` };
      }
      case CALENDAR_EVENT_CREATE: {
        const out = await createEvent(deps.env, holder, { summary: String(args.summary), start: String(args.start), end: String(args.end), ...(args.allDay === true ? { allDay: true } : {}), ...(typeof args.location === 'string' ? { location: args.location } : {}), ...(typeof args.description === 'string' ? { description: args.description } : {}), ...(Array.isArray(args.attendees) ? { attendees: (args.attendees as unknown[]).map(String) } : {}) }, f);
        if (!out) return notConnected;
        // What may follow (spec 368 §3 / 403 W5): the undo, proposed on the receipt — never done here.
        return { created: true, holder, event: out, next: { capability: CALENDAR_EVENT_DELETE, args: { id: out.id }, words: `undo — remove "${out.summary}" from your calendar`, why: 'the event as it was just added, taken back under your signature' } };
      }
      case CALENDAR_EVENT_DELETE: {
        const out = await deleteEvent(deps.env, holder, { id: String(args.id ?? ''), ...(typeof args.calendarId === 'string' ? { calendarId: args.calendarId } : {}) }, f);
        if (!out) return notConnected;
        return { deleted: true, holder, id: out.id, note: 'removed from your calendar' };
      }
      default: throw new Error(`${toolId} is not a calendar capability`);
    }
  };
}
