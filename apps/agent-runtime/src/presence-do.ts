// PRESENCE — one Durable Object per PERSON (named by their agent address), holding where they are right now: one
// entry per app, each a heartbeat with a short life. Serving-plane state (ADR-0055): wiped, it is empty until the
// next beat — nothing of record lives here, and nothing here is an act. Who may READ it is decided by the route
// (a mutual friend, and the person themselves), never by this object: it sees no session.
import type { PresenceEntry, RecentEntry } from './presence.js';
import { foldRecent, livePresence } from './presence.js';

type Op =
  | { op: 'beat'; entry: PresenceEntry }
  | { op: 'gone'; app: string; forget?: boolean }
  | { op: 'read' }
  | { op: 'recent' };

const KEY = 'presence:entries';
/** Where the person was this past week (presence.ts foldRecent) — serving-plane state too: wiped, it starts again. */
const RECENT_KEY = 'presence:recent';
const json = (b: unknown, status = 200) => Response.json(b, { status });

export class PresenceDO {
  constructor(private state: DurableObjectState) {}

  private async entries(): Promise<PresenceEntry[]> {
    return ((await this.state.storage.get<PresenceEntry[]>(KEY)) ?? []);
  }

  async fetch(request: Request): Promise<Response> {
    const op = (await request.json().catch(() => null)) as Op | null;
    if (!op) return json({ error: 'bad op' }, 400);
    const now = Date.now();
    if (op.op === 'read') return json({ entries: livePresence(await this.entries(), now) });
    const recent = (await this.state.storage.get<RecentEntry[]>(RECENT_KEY)) ?? [];
    if (op.op === 'recent') return json({ recent: foldRecent(recent, { app: '', at: now, until: now }, now) });
    const current = livePresence(await this.entries(), now);
    if (op.op === 'gone') {
      const next = current.filter((e) => e.app !== op.app);
      await this.state.storage.put(KEY, next);
      if (op.forget) await this.state.storage.put(RECENT_KEY, recent.filter((r) => r.app !== op.app));
      return json({ ok: true, entries: next });
    }
    const next = [...current.filter((e) => e.app !== op.entry.app), op.entry];
    await this.state.storage.put(KEY, next);
    await this.state.storage.put(RECENT_KEY, foldRecent(recent, op.entry, now));
    // The object wakes once after the last beat lapses and forgets, so an idle person costs no storage.
    const latest = Math.max(...next.map((e) => e.until));
    await this.state.storage.setAlarm(latest + 1000);
    return json({ ok: true, until: op.entry.until });
  }

  async alarm(): Promise<void> {
    const live = livePresence(await this.entries(), Date.now());
    if (live.length) await this.state.storage.put(KEY, live);
    else await this.state.storage.delete(KEY);
  }
}
