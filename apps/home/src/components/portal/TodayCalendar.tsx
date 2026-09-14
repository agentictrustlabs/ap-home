'use client';
// Spec 400 W4 — "Today on your calendar": the harness's `calendar.events.list` for today's window, on the person's own
// Today. Reads only; not connected says so and offers the Connections page. A connected calendar is one more thing the
// agent knows — Claude through the Home MCP and a paired runtime get the same answer, as her.
import { useEffect, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { useSession } from '../../context/session';
import { Panel, List, Row, Meta, useReadyReport, type PanelState } from '../../ui';
import { readCalendarThroughHarness, todayWindow, type CalendarRead } from '../../home/calendar-harness';
import { ClockIcon } from './today-icons';

const hm = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

export function TodayCalendar({ person }: { person: Address }) {
  const { session } = useSession();
  const [read, setRead] = useState<CalendarRead | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useReadyReport('calendar', read === null && !err);
  useEffect(() => {
    if (!session?.token) return;
    let live = true;
    void readCalendarThroughHarness({ person, session: { token: session.token }, ...todayWindow() }).then((r) => {
      if (!live) return;
      if (r.ok) setRead(r.read); else setErr(r.error);
    });
    return () => { live = false; };
  }, [session?.token, person]);

  const events = read?.connected ? read.events : [];
  const state: PanelState = read === null && !err ? 'loading' : err ? 'unknown' : read?.connected ? (events.length ? 'ready' : 'empty') : 'empty';
  return (
    <Panel title="Today on your calendar" icon={<ClockIcon />} count={events.length} state={state} rows={2} testId="today-calendar"
      aside={read?.connected ? <a href="/apps">Connections →</a> : undefined}
      empty={read?.connected
        ? { icon: <ClockIcon />, title: 'Nothing on your calendar today', hint: 'Ask "what\'s on tomorrow" — or add something, and your agent will ask you to sign it.' }
        : { icon: <ClockIcon />, title: 'Calendar not connected', hint: 'Connect Google Calendar so your agent can answer "what\'s on today" — the credential stays yours, revocable any time.', action: <a className="ui-btn ui-btn--secondary ui-btn--sm" href="/apps">Connect Google Calendar</a> }}
      unknown={{ read: `your calendar could not be read (${err ?? ''})` }}>
      <List>
        {events.map((e) => (
          <Row key={e.id} title={e.summary} meta={`${e.allDay ? 'all day' : `${hm(e.start)} – ${hm(e.end)}`}${e.location ? ` · ${e.location}` : ''}${e.attendees?.length ? ` · ${e.attendees.length} attendee${e.attendees.length === 1 ? '' : 's'}` : ''}`}
            side={e.link ? <a href={e.link} target="_blank" rel="noreferrer"><Meta>open</Meta></a> : undefined} />
        ))}
      </List>
    </Panel>
  );
}
