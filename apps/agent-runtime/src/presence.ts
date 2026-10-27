// PRESENCE — where a person is right now, told to their friends. A person's device (through a relying app, or the
// Home itself) BEATS every so often: "I am in <app>, at <scope>" — a heartbeat with a short life, kept in the
// person's own presence object (presence-do.ts), never a record, never an act, never a mandate. Their MUTUAL FRIENDS
// (spec 401: the person added them and they added the person back) may read it; nobody else, and nothing of it is
// public. A friend's presence is part of what a friendship grant lets a friend see of the person — their
// profile, as it stands this minute — so the friends view (friends.ts) is the one gate.
//
// Why not a harness run: a heartbeat every half minute cannot be a run on the person's agent (seconds and money,
// hard-problems §15), and it is no act — so the beat and the read are plain routes under the person's own token.
import type { ToolInvoker, ToolSpec } from '@agenticprimitives/orchestration';
import { friendsOf, type FriendRow, type FriendsDeps } from './friends.js';

export const PRESENCE_LIST_CAPABILITY = 'person.presence.list' as const;

/** The longest a beat lives without another; an app beats at a third of this. */
export const PRESENCE_TTL_MS = 90_000;
export const PRESENCE_MAX_TTL_MS = 10 * 60_000;

export interface PresenceEntry {
  /** The relying app (its client id), or `home` for the Home itself. */
  app: string;
  /** Where in the app, as the app names it (a chapter, a page, a room) — a label for friends, never a locator for the app. */
  scope?: string;
  /** What friends read: "reading John 3". */
  label?: string;
  /** When the last beat came (ms). */
  at: number;
  /** When this entry lapses without another beat (ms). */
  until: number;
}

/** Where a person WAS, lately: the places their beats named, newest first — what friends read as "Ruth read John 3".
 *  Kept a week, at most RECENT_MAX; told only while the person lets friends see where they are (their device beats
 *  only then, and turning it off forgets this too). A live session is never kept here. */
export interface RecentEntry { app: string; scope: string; label?: string; at: number }
export const RECENT_MAX = 30;
export const RECENT_DAYS = 7;

/** The recent list with a beat folded in: one row per app and place (its newest time), a week deep, bounded. */
export function foldRecent(recent: readonly RecentEntry[], entry: PresenceEntry, now: number): RecentEntry[] {
  const fresh = recent.filter((r) => now - r.at < RECENT_DAYS * 86_400_000);
  if (!entry.scope || entry.scope.startsWith('session:')) return fresh;
  const row: RecentEntry = { app: entry.app, scope: entry.scope, ...(entry.label ? { label: entry.label } : {}), at: entry.at };
  return [row, ...fresh.filter((r) => !(r.app === row.app && r.scope === row.scope))].slice(0, RECENT_MAX);
}

export interface FriendPresence extends FriendRow {
  /** Live entries, newest first; empty when the friend is not here now. */
  presence: PresenceEntry[];
  /** Where they were this past week, newest first. */
  recent: RecentEntry[];
}

/** The entries still alive at `now`, newest first. */
export function livePresence(entries: readonly PresenceEntry[], now: number): PresenceEntry[] {
  return entries.filter((e) => e.until > now).sort((a, b) => b.at - a.at);
}

/** A beat as the person's device sent it, bounded: the app is theirs to name, the life is capped. */
export function beatEntry(input: { app: string; scope?: unknown; label?: unknown; ttlMs?: unknown }, now: number): PresenceEntry {
  const ttl = Math.min(PRESENCE_MAX_TTL_MS, Math.max(5_000, Number(input.ttlMs) || PRESENCE_TTL_MS));
  const scope = typeof input.scope === 'string' ? input.scope.slice(0, 120) : undefined;
  const label = typeof input.label === 'string' ? input.label.slice(0, 120) : undefined;
  return { app: input.app.slice(0, 80), ...(scope ? { scope } : {}), ...(label ? { label } : {}), at: now, until: now + ttl };
}

/** The presence objects, by person — the Worker binds them; a test fakes this. */
export interface PresencePort {
  read(agent: string): Promise<PresenceEntry[]>;
  /** Where they were this past week (the person's own object; a friend reads it through the same gate). */
  recent(agent: string): Promise<RecentEntry[]>;
  beat(agent: string, entry: PresenceEntry): Promise<void>;
  /** `forget`: the person stopped letting friends see where they are — the week's list goes too. */
  gone(agent: string, app: string, forget?: boolean): Promise<void>;
}

export function presencePort(env: { PRESENCE?: DurableObjectNamespace }): PresencePort | null {
  const ns = env.PRESENCE;
  if (!ns) return null;
  const stub = (agent: string) => ns.get(ns.idFromName(agent.toLowerCase()));
  const call = async (agent: string, body: unknown) =>
    (await (await stub(agent).fetch('https://presence/', { method: 'POST', body: JSON.stringify(body) })).json()) as { entries?: PresenceEntry[]; recent?: RecentEntry[] };
  return {
    read: async (agent) => (await call(agent, { op: 'read' })).entries ?? [],
    recent: async (agent) => (await call(agent, { op: 'recent' })).recent ?? [],
    beat: async (agent, entry) => { await call(agent, { op: 'beat', entry }); },
    gone: async (agent, app, forget) => { await call(agent, { op: 'gone', app, ...(forget ? { forget: true } : {}) }); },
  };
}

/** The person's mutual friends, each with where they are now — the one read of another's presence there is. */
export async function friendsPresence(deps: FriendsDeps, port: PresencePort, person: string, now = Date.now()): Promise<FriendPresence[]> {
  const { friends } = await friendsOf(deps, person);
  const out: FriendPresence[] = [];
  for (const f of friends) {
    const [live, recent] = await Promise.all([port.read(f.agent).catch(() => []), port.recent(f.agent).catch(() => [])]);
    out.push({ ...f, presence: livePresence(live, now), recent: recent.filter((r) => now - r.at < RECENT_DAYS * 86_400_000) });
  }
  // Those here now first, then by name.
  return out.sort((a, b) => (b.presence.length ? 1 : 0) - (a.presence.length ? 1 : 0) || String(a.name ?? a.agent).localeCompare(String(b.name ?? b.agent)));
}

export const PRESENCE_LIST_TOOL: ToolSpec = {
  id: PRESENCE_LIST_CAPABILITY,
  answers: ['who is online', 'which friends are here now', 'who is reading now', 'is bob online', 'where are my friends'],
  description:
    'WHICH OF YOUR FRIENDS ARE HERE NOW, and where — the live presence each friend\'s device reports (an app, a place in '
    + 'it such as a chapter). Mutual friends only (person.friend.list); nobody else\'s presence is readable, and nothing here is '
    + 'public. Args: none. NOT a message and NOT a session — a glance at who is around.',
  inputSchema: { type: 'object', properties: {} },
  establishes: 'lookup',
};

/** `person.presence.list` — a read for the Ask ("who is online"); the same gate as the route. */
export function presenceListInvoker(deps: FriendsDeps, port: PresencePort | null, person: string | undefined): ToolInvoker {
  return async () => {
    if (!person) return { refused: 'presence is read by a person\'s own agent — there is no person on this run' };
    if (!port) return { refused: 'this deployment keeps no presence' };
    const rows = await friendsPresence(deps, port, person);
    const here = rows.filter((r) => r.presence.length);
    return {
      count: here.length,
      here: here.map((r) => ({ agent: r.agent, name: r.name, presence: r.presence })),
      away: rows.filter((r) => !r.presence.length).map((r) => ({ agent: r.agent, name: r.name })),
      interpretation: `read the live presence of the person's ${rows.length} friend(s)`,
      note: here.length
        ? here.map((r) => `${r.name ?? r.agent}: ${r.presence.map((p) => p.label ?? p.app).join(', ')}`).join('; ')
        : rows.length ? 'None of your friends is here right now.' : 'No friends yet — presence is what friends see of each other.',
    };
  };
}
