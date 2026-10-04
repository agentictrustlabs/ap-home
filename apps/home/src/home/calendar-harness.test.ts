// Spec 400 W4 — the Today calendar card reads through the harness with a supplied plan. An agent that has no
// calendar CAPABILITY at all (a persona whose archetype never exposes calendar.events.list) must read as "not
// connected", exactly like an unconnected one — never a raw plan_refused dump on the screen.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readCalendarThroughHarness } from './calendar-harness';

vi.mock('../csrf', () => ({ ensureCsrfToken: async () => undefined, csrfHeaders: () => ({}) }));

const PERSON = '0x8482b1963f00000000000000000000000000000000' as const;
const reply = (body: unknown) => ({ ok: true, json: async () => body }) as unknown as Response;

describe('readCalendarThroughHarness', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('an agent that does not EXPOSE calendar.events.list reads as not connected, not an error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply({
      reply: { kind: 'refused', error: 'plan_refused: step 1 names "calendar.events.list", which this agent does not offer — choose among: messaging.direct.send, kb.retrieve.' },
    })));
    const r = await readCalendarThroughHarness({ person: PERSON, session: { token: 't' } });
    expect(r).toEqual({ ok: true, read: { connected: false } });
  });

  it('an unconnected (but capable) agent reads as not connected', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply({
      reply: { kind: 'answer', results: [{ toolId: 'calendar.events.list', result: { connected: false } }] },
    })));
    const r = await readCalendarThroughHarness({ person: PERSON, session: { token: 't' } });
    expect(r).toEqual({ ok: true, read: { connected: false } });
  });

  it('a connected agent returns its events', async () => {
    const events = [{ id: 'e1', summary: 'Standup', start: '2026-10-04T09:00:00Z', end: '2026-10-04T09:30:00Z', allDay: false }];
    const window = { from: '2026-10-04T00:00:00Z', to: '2026-10-05T00:00:00Z' };
    vi.stubGlobal('fetch', vi.fn(async () => reply({
      reply: { kind: 'answer', results: [{ toolId: 'calendar.events.list', result: { connected: true, events, window } }] },
    })));
    const r = await readCalendarThroughHarness({ person: PERSON, session: { token: 't' } });
    expect(r).toEqual({ ok: true, read: { connected: true, events, window } });
  });

  it('a genuine refusal unrelated to the calendar capability stays an error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply({
      reply: { kind: 'refused', error: 'session expired' },
    })));
    const r = await readCalendarThroughHarness({ person: PERSON, session: { token: 't' } });
    expect(r).toEqual({ ok: false, error: 'session expired' });
  });
});
