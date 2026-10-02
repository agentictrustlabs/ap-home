// Spec 400 W4 — Today's calendar read: the Ask with a supplied plan (`calendar.events.list`) addressed to the person's
// own agent. The screen shows what the agent would answer to "what's on my calendar today" — the same read, the same
// standing, the same connector. Not connected is an answer, never an empty list.
import type { Address } from '@agenticprimitives/types';
import type { AskReply } from './ask';
import { ensureCsrfToken, csrfHeaders } from '../csrf';

export interface CalendarEventRow { id: string; summary: string; start: string; end: string; allDay: boolean; location?: string; link?: string; attendees?: Array<{ email: string; response?: string }> }
export type CalendarRead = { connected: false } | { connected: true; events: CalendarEventRow[]; window: { from: string; to: string } };

const j = async (r: Response) => (await r.json().catch(() => ({}))) as { reply?: AskReply; error?: string; detail?: string };

export async function readCalendarThroughHarness(input: { person: Address; session: { token: string }; from?: string; to?: string }): Promise<{ ok: true; read: CalendarRead } | { ok: false; error: string }> {
  await ensureCsrfToken();
  const args = { ...(input.from ? { from: input.from } : {}), ...(input.to ? { to: input.to } : {}) };
  const out = await j(await fetch('/a2a/harness/ask', {
    method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', ...csrfHeaders() },
    body: JSON.stringify({ session: input.session.token, addressee: input.person.toLowerCase(), message: "what's on my calendar today", rowsOnly: true, plan: { steps: [{ toolId: 'calendar.events.list', args }] } }),
  }));
  const reply = out.reply;
  if (reply?.kind === 'answer') {
    const rows = (reply as { results?: Array<{ toolId: string; result: unknown }> }).results ?? [];
    const found = rows.find((x) => x.toolId === 'calendar.events.list')?.result as ({ connected?: boolean; refused?: string; events?: CalendarEventRow[]; window?: { from: string; to: string } }) | undefined;
    if (found?.connected === false || found?.refused) return { ok: true, read: { connected: false } };
    if (found?.events && found.window) return { ok: true, read: { connected: true, events: found.events, window: found.window } };
  }
  return { ok: false, error: out.detail ?? out.error ?? (reply?.kind === 'refused' ? reply.error : 'the calendar could not be read') };
}

/** Today's window in the viewer's local day. */
export function todayWindow(now = new Date()): { from: string; to: string } {
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  const end = new Date(start); end.setDate(end.getDate() + 1);
  return { from: start.toISOString(), to: end.toISOString() };
}
