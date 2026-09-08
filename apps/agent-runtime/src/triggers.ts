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
  ask: string;
  every: string;
  everyMs: number;
  /** When the next run is due (ms). */
  nextAt: number;
  /** The playbook digest the trigger came from — a re-sync from a different digest replaces the row. */
  playbookDigest: string;
  lastAt?: number;
  lastRunRef?: string;
  /** What the last firing reached: answered · parked (waiting on a steward) · failed. */
  lastOutcome?: 'answered' | 'parked' | 'failed';
  lastSaid?: string;
}

/** The schedule rows a playbook's triggers become, first due one interval from now (never immediately —
 *  assigning a playbook is not asking). */
export function schedulesFor(agent: Address, playbookDigest: string, triggers: readonly TriggerV1[], now = Date.now()): TriggerScheduleV1[] {
  return triggers.filter((t) => t.kind === 'schedule').map((t) => {
    const everyMs = durationMs(t.every);
    return { agent: agent.toLowerCase() as Address, triggerId: t.id, ask: t.ask, every: t.every, everyMs, nextAt: now + everyMs, playbookDigest };
  });
}

/** The rows due now, oldest first. */
export function dueNow(rows: readonly TriggerScheduleV1[], now = Date.now()): TriggerScheduleV1[] {
  return rows.filter((r) => r.nextAt <= now).sort((a, b) => a.nextAt - b.nextAt);
}

/** The next moment any row is due, for the alarm. */
export function nextDue(rows: readonly TriggerScheduleV1[]): number | null {
  return rows.length ? Math.min(...rows.map((r) => r.nextAt)) : null;
}

/** After a firing: the next due time is one interval on from NOW (not from the planned time — a DO that
 *  slept through three intervals runs once, not three times). */
export function advanced(row: TriggerScheduleV1, outcome: TriggerScheduleV1['lastOutcome'], runRef: string, said: string | undefined, now = Date.now()): TriggerScheduleV1 {
  return { ...row, nextAt: now + row.everyMs, lastAt: now, lastRunRef: runRef, lastOutcome: outcome, ...(said ? { lastSaid: said.slice(0, 400) } : {}) };
}

// ── The rows on the task DO ───────────────────────────────────────────────────────────────────────────

export interface TriggerStoreEnv { A2A_TASKS: DurableObjectNamespace }

async function call(env: TriggerStoreEnv, agent: Address, op: 'trigger-sync' | 'trigger-list', body: unknown): Promise<Record<string, unknown>> {
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
