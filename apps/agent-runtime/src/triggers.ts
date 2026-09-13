// TRIGGERS — spec 370 P5. The playbook asks on its own, on a schedule, with the agent as the asker and NO
// mandate.
//
// The decision (the user's, 2026-09-08): the asker of an unattended run is the agent itself, presenting
// nothing. An informational ask completes and its answer is posted where the agent's stewards read; an ask
// that reaches an authority-bearing step suspends — exactly the parked run a work item becomes — and shows
// up in the stewards' unfinished runs, where one of them finishes it by granting the mandate. The
// obligation model IS "pause for approval"; a trigger adds a clock, never authority.
//
// Schedules are PER AGENT, on the agent's own task DO under its single alarm (the Cloudflare Agents
// pattern, ours to write), never a global cron sweeping objects — that would be the cross-owner scan spec
// 362 §6.4 forbids. Rows are rebuildable from the playbook (a DO wipe costs a re-sync, never a bereavement).
import type { Address } from 'viem';
import { durationMs, type TriggerV1 } from '@agenticprimitives/capability-claims';
import { internalHeaders } from './internal-marker.js';

export interface TriggerScheduleV1 {
  agent: Address;
  triggerId: string;
  /** Spec 375 — which source fires this row. Absent on rows written before the kinds existed ⇒ schedule. */
  kind?: 'schedule' | 'event' | 'webhook' | 'message';
  /** Spec 375 — what fires it: an Endeavor event type, or an exchange profile. */
  on?: { event?: string; profile?: string };
  /** Spec 375 — a webhook row's bearer token: admission for `POST /harness/hooks/<agent>/<id>`, never authority. */
  token?: string;
  ask: string;
  every?: string;
  everyMs?: number;
  /** When the next run is due (ms) — schedule rows only. */
  nextAt?: number;
  /** The playbook digest the trigger came from — a re-sync from a different digest replaces the row. */
  playbookDigest: string;
  lastAt?: number;
  lastRunRef?: string;
  /** What the last firing reached: answered · parked (waiting on a steward) · failed. */
  lastOutcome?: 'answered' | 'parked' | 'failed';
  lastSaid?: string;
  /** Spec 398 §5.3 — PAUSED: nothing new starts, state kept. A steward's act, or the budget's (§5.4). Never a
   *  cancel (the parked run stands), never a revoke (no authority changes hands). */
  paused?: { at: number; by: 'steward' | 'budget'; note?: string };
  /** Spec 398 §5.4 — the routine's budget per firing, in the numbers 396 counts. Exhaustion PAUSES the routine —
   *  it never widens a mandate and never tops up silently. */
  budget?: { vaultCalls: number; /** Declared on the SKILL.md trigger (spec 398 §5.4) rather than set by a steward. */ declared?: true };
  /** Spec 396 W3 — what the last firing cost. */
  lastBill?: { vaultCalls: number; doRequests: number };
}

/** The schedule rows a playbook's triggers become, first due one interval from now (never immediately —
 *  assigning a playbook is not asking). */
const hex = (n: number): string => `0x${[...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('')}`;

/** The rows a playbook's triggers become (spec 375 — every kind). A schedule is first due one interval
 *  from now (never immediately — assigning a playbook is not asking); a webhook row is minted a token. */
export function schedulesFor(agent: Address, playbookDigest: string, triggers: readonly TriggerV1[], now = Date.now()): TriggerScheduleV1[] {
  const a = agent.toLowerCase() as Address;
  return triggers.map((t): TriggerScheduleV1 => {
    // Spec 398 §5.4 — the budget the contract declares is the row's initial one, marked as declared so a
    // steward's own setting can be told from it (and survives a version change while this does not).
    const budget = t.budget ? { budget: { vaultCalls: t.budget.vaultCalls, declared: true as const } } : {};
    if (t.kind === 'schedule') {
      const everyMs = durationMs(t.every);
      return { agent: a, triggerId: t.id, kind: 'schedule', ask: t.ask, every: t.every, everyMs, nextAt: now + everyMs, playbookDigest, ...budget };
    }
    if (t.kind === 'event') return { agent: a, triggerId: t.id, kind: 'event', on: { event: t.on.event }, ask: t.ask, playbookDigest, ...budget };
    if (t.kind === 'webhook') return { agent: a, triggerId: t.id, kind: 'webhook', token: hex(24), ask: t.ask, playbookDigest, ...budget };
    return { agent: a, triggerId: t.id, kind: 'message', on: { profile: t.on.profile }, ask: t.ask, playbookDigest, ...budget };
  });
}

const isSchedule = (r: TriggerScheduleV1): r is TriggerScheduleV1 & { nextAt: number; everyMs: number } => (r.kind ?? 'schedule') === 'schedule' && typeof r.nextAt === 'number';

/** The schedule rows due now, oldest first. Other kinds are fired by their sources, never by the clock. */
export function dueNow(rows: readonly TriggerScheduleV1[], now = Date.now()): TriggerScheduleV1[] {
  return rows.filter(isSchedule).filter((r) => !r.paused && r.nextAt <= now).sort((a, b) => a.nextAt - b.nextAt);
}

/** The next moment any schedule row is due, for the alarm. */
export function nextDue(rows: readonly TriggerScheduleV1[]): number | null {
  const s = rows.filter(isSchedule);
  return s.length ? Math.min(...s.map((r) => r.nextAt)) : null;
}

/** After a firing: a schedule's next due time is one interval on from NOW (not from the planned time — a
 *  DO that slept through three intervals runs once, not three times); every kind keeps its last outcome. */
export function advanced(row: TriggerScheduleV1, outcome: TriggerScheduleV1['lastOutcome'], runRef: string, said: string | undefined, now = Date.now(), bill?: { vaultCalls: number; doRequests: number }): TriggerScheduleV1 {
  // Spec 398 §5.4 — over budget ⇒ PAUSED, said on the row; the firing that went over still happened (its receipts stand).
  const over = bill && row.budget && bill.vaultCalls > row.budget.vaultCalls;
  return {
    ...row, ...(isSchedule(row) ? { nextAt: now + row.everyMs } : {}), lastAt: now, lastRunRef: runRef, lastOutcome: outcome,
    ...(said ? { lastSaid: said.slice(0, 400) } : {}), ...(bill ? { lastBill: { vaultCalls: bill.vaultCalls, doRequests: bill.doRequests } } : {}),
    ...(over ? { paused: { at: now, by: 'budget' as const, note: `the last firing cost ${bill.vaultCalls} vault calls against a budget of ${row.budget!.vaultCalls}` } } : {}),
  };
}

/** Spec 398 §5.3 — a steward pauses or resumes a routine; §5.4 — sets its budget. Pure: the row, changed. */
export function withPause(row: TriggerScheduleV1, paused: boolean, note: string | undefined, now = Date.now()): TriggerScheduleV1 {
  if (!paused) { const { paused: _p, ...rest } = row; return rest; }
  return { ...row, paused: { at: now, by: 'steward', ...(note ? { note: note.slice(0, 200) } : {}) } };
}
/** `null` clears the steward's budget — and the row RETURNS to the one its playbook declares (spec 398 §5.4), when
 *  the caller passes it: clearing a cap is not lifting the routine's own ceiling. */
export function withBudget(row: TriggerScheduleV1, vaultCalls: number | null, declared?: { vaultCalls: number } | null): TriggerScheduleV1 {
  if (vaultCalls === null) { const { budget: _b, ...rest } = row; return declared ? { ...rest, budget: { vaultCalls: declared.vaultCalls, declared: true } } : rest; }
  return { ...row, budget: { vaultCalls: Math.max(1, Math.floor(vaultCalls)) } };   // a steward's: never `declared`
}

/** Spec 375 — WHAT FIRED. The source a row is matched against, and the context its run receives. */
export type TriggerSource =
  | { kind: 'event'; event: { type: string; endeavorId: string; at?: string } & Record<string, unknown> }
  | { kind: 'webhook'; triggerId: string; token: string; payload: unknown }
  | { kind: 'message'; message: { id: string; from: string; fromName?: string; profile: string; subject?: string; text?: string;
      /** Spec 400 W2 (B3) — the THREAD the message is on (its conversation id) and, for a mention in a topic, the topic:
       *  what an open run is found by, and where the reply goes back to. */
      thread?: string; topic?: { org: string; channelId: string; title?: string } } };

/** The rows a source fires. A webhook must name its row AND carry that row's token — nothing else matches;
 *  an event matches by type; a message by profile. */
export function matchingTriggers(rows: readonly TriggerScheduleV1[], source: TriggerSource): TriggerScheduleV1[] {
  rows = rows.filter((r) => !r.paused);   // a paused routine fires from no source (398 §5.3)
  return rows.filter((r) => {
    if (source.kind === 'event') return r.kind === 'event' && r.on?.event === source.event.type;
    if (source.kind === 'webhook') return r.kind === 'webhook' && r.triggerId === source.triggerId && !!r.token && r.token === source.token;
    return r.kind === 'message' && r.on?.profile === source.message.profile;
  });
}

/**
 * Spec 375 W2 — WHAT AN ADMITTED MESSAGE FIRES. Built by the recipient's inbox gateway AFTER the exchange is
 * in the recipient's vault (admission first; a trigger never admits anything). The profile is the rail the
 * message came in on: a direct message (`dm`), a response to something this agent asked (`response`), a
 * credential delivered to it (`credential`). Agent-authored notices (`actor` set — a coordinator's "your
 * request is complete") fire nothing, the same convention the inbox auto-reply keeps: two agents whose
 * playbooks each react to the other's notices would otherwise chatter until a steward noticed. The text
 * rides as context for the planner, bounded; it is never an argument the planner may forge into an act.
 * `null` ⇒ nothing fires.
 */
export function messageTriggerSource(
  envelope: { id: string; from: string; actor?: string; subject?: string; conversationId?: string; contextRefs?: Array<{ kind: string; id: string; label?: string }> },
  admittedBy: string,
  bodyText: string | undefined,
  /** The sender's registered NAME, when the gateway could read one: the words a run's plan may name the
   *  reply's recipient by. The planner is told never to lift an ADDRESS out of its context into an act
   *  (it is who is asking, not who is meant) — a name is the person's own word for the party, and the
   *  resolver still settles it in the agent's own tier like any other. */
  fromName?: string | null,
): TriggerSource | null {
  // A MENTION is the one agent-authored admission that fires: the poster is a person (or an agent) speaking in a
  // topic, and `actor` names them, not a notice-writing agent. The `messaging.mention` skill says which it is.
  if (envelope.actor && admittedBy !== 'messaging.mention') return null;
  const from = (envelope.from.match(/0x[0-9a-fA-F]{40}$/)?.[0] ?? '').toLowerCase();
  if (!from) return null;
  const profile = admittedBy === 'messaging.mention' ? 'mention' : admittedBy === 'interactions.respond' ? 'response' : admittedBy === 'interactions.deliverCredential' ? 'credential' : 'dm';
  const text = (bodyText ?? '').trim().slice(0, 2_000);
  // A topic ref's id is `<org address>:<channelId>` (mentions.ts) — the org whose topic it is, and which channel.
  const topicRef = (envelope.contextRefs ?? []).find((r) => r.kind === 'topic' && /^0x[0-9a-f]{40}:.+$/i.test(r.id));
  const topic = topicRef ? { org: topicRef.id.slice(0, 42).toLowerCase(), channelId: topicRef.id.slice(43), ...(topicRef.label ? { title: topicRef.label } : {}) } : undefined;
  return { kind: 'message', message: { id: envelope.id, from, ...(fromName ? { fromName } : {}), profile, ...(envelope.subject ? { subject: envelope.subject } : {}), ...(text ? { text } : {}), ...(envelope.conversationId ? { thread: envelope.conversationId } : {}), ...(topic ? { topic } : {}) } };
}

/** The context a fired run receives — the source's public facts, for the planner; no verifier reads it. */
export function triggerContext(source: TriggerSource): Record<string, unknown> {
  if (source.kind === 'event') return { event: source.event };
  if (source.kind === 'webhook') return { payload: source.payload };
  return { message: source.message };
}

// ── The rows on the task DO ───────────────────────────────────────────────────────────────────────────

export interface TriggerStoreEnv { A2A_TASKS: DurableObjectNamespace }

async function call(env: TriggerStoreEnv, agent: Address, op: 'trigger-sync' | 'trigger-list' | 'trigger-advance' | 'trigger-rotate', body: unknown): Promise<Record<string, unknown>> {
  const stub = env.A2A_TASKS.get(env.A2A_TASKS.idFromName(agent.toLowerCase()));
  const res = await stub.fetch(new Request(`https://a2a-task-do/internal/harness-run/${op}`, { method: 'POST', headers: internalHeaders(env as never), body: JSON.stringify(body) }));
  const out = (await res.json().catch(() => ({}))) as Record<string, unknown> & { ok?: boolean; error?: string };
  if (!res.ok || out.ok === false) throw new Error(String(out.error ?? `harness-run/${op} failed (${res.status})`));
  return out;
}

/** Make the agent's schedule match its playbook: rows for triggers it declares (existing ones keep their
 *  timing when the digest is unchanged), none for triggers it no longer declares, and the alarm armed. */
export async function syncTriggers(env: TriggerStoreEnv, agent: Address, playbook: { digest: string; triggers?: readonly TriggerV1[] } | null): Promise<{ rows: TriggerScheduleV1[] }> {
  const rows = playbook ? schedulesFor(agent, playbook.digest, playbook.triggers ?? []) : [];
  const out = await call(env, agent, 'trigger-sync', { rows, playbookDigest: playbook?.digest ?? null });
  return { rows: (out.rows as TriggerScheduleV1[] | undefined) ?? [] };
}

export async function listTriggers(env: TriggerStoreEnv, agent: Address): Promise<TriggerScheduleV1[]> {
  const out = await call(env, agent, 'trigger-list', {});
  return (out.rows as TriggerScheduleV1[] | undefined) ?? [];
}

/** Spec 375 W3 — mint a webhook row a new token; the old one stops opening the door. Stewards only (the route). */
export async function rotateTriggerToken(env: TriggerStoreEnv, agent: Address, triggerId: string): Promise<TriggerScheduleV1> {
  const out = await call(env, agent, 'trigger-rotate', { triggerId });
  return out.row as TriggerScheduleV1;
}

/** Record a firing on its row (spec 375 — sources other than the clock fire from outside the DO's alarm). */
export async function advanceTrigger(env: TriggerStoreEnv, agent: Address, row: TriggerScheduleV1): Promise<void> {
  await call(env, agent, 'trigger-advance', { row });
}

/**
 * Spec 375 — FIRE the rows a source matches at one agent: one unattended run per row, the agent as the
 * asker holding nothing (P5), the source as context. `run` is the harness's `runUnattendedAsk`; the
 * outcome lands on the row. Returns what fired, for the caller's log.
 */
export async function fireTriggers(
  env: TriggerStoreEnv,
  agent: Address,
  source: TriggerSource,
  run: (row: TriggerScheduleV1, runRef: string, context: Record<string, unknown>) => Promise<{ outcome: 'answered' | 'parked' | 'failed'; said?: string; runRef: string; bill?: { vaultCalls: number; doRequests: number } }>,
): Promise<Array<{ triggerId: string; runRef: string; outcome: string }>> {
  const rows = await listTriggers(env, agent).catch(() => [] as TriggerScheduleV1[]);
  const fired: Array<{ triggerId: string; runRef: string; outcome: string }> = [];
  for (const row of matchingTriggers(rows, source)) {
    let outcome: TriggerScheduleV1['lastOutcome'] = 'failed';
    let said: string | undefined;
    let runRef = `trigger-${row.triggerId}-${Date.now().toString(36)}`;
    let bill: { vaultCalls: number; doRequests: number } | undefined;
    try {
      const r = await run(row, runRef, triggerContext(source));
      outcome = r.outcome; said = r.said; runRef = r.runRef; bill = r.bill;
    } catch (e) {
      said = e instanceof Error ? e.message : String(e);
    }
    await advanceTrigger(env, agent, advanced(row, outcome, runRef, said, Date.now(), bill)).catch(() => undefined);
    fired.push({ triggerId: row.triggerId, runRef, outcome: outcome ?? 'failed' });
  }
  return fired;
}
