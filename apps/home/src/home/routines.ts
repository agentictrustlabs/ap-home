// A ROUTINE AS A PRODUCT — spec 398 G3 (375 → product page): a VERSIONED SKILL (the playbook the trigger came from,
// by id, version and digest) + a TRIGGER (what fires it) + FRESH AUTHORITY (every firing asks as the agent, holding
// nothing; a firing that reaches an authority-bearing step parks and waits for a steward's mandate — never one carried
// from a previous firing) + its RUN HISTORY (the records whose intent names the trigger) + its state (§5.1), budget and
// bill (§5.4), pause (§5.3). Pure; absent is said absent.
import type { TriggerRow, RunRecordRow } from './ask';
import { stateOf, type ProjectedRunStateV1 } from './run-state';

export interface RoutineView {
  triggerId: string;
  ask: string;
  /** What fires it, in words. */
  source: string;
  kind: NonNullable<TriggerRow['kind']>;
  /** The versioned skill: the playbook pinned on the agent, when it is the one the row came from. */
  playbook: { archetypeId: string; version: string; digest: string; current: boolean } | null;
  state: ProjectedRunStateV1;
  native: string;
  paused: TriggerRow['paused'] | null;
  budget: number | null;
  /** Where the budget came from: the playbook's own declaration, or a steward's setting on the row. */
  budgetBy: 'playbook' | 'steward' | null;
  lastBill: TriggerRow['lastBill'] | null;
  nextAt: number | null;
  last: { at: number; runRef?: string; outcome: string; said?: string } | null;
  /** The firings on record, newest first. */
  history: Array<{ runRef: string; at: number; state: ProjectedRunStateV1; native: string; steps: number; receipts: number; bill?: { vaultCalls: number; doRequests: number } }>;
  /** Spec 398 §12 G3 — fresh authority: what a firing does when it reaches an act. */
  authority: string;
}

export interface RoutineInputs {
  triggers: ReadonlyArray<TriggerRow>;
  records: ReadonlyArray<RunRecordRow & { intent?: { context?: Record<string, unknown> } }>;
  /** The agent's pinned playbook, when read. */
  assignment: { archetypeId: string; archetypeVersion: string; definitionDigest: string } | null;
}

export function sourceWords(t: TriggerRow): string {
  if (t.kind === 'event') return `when ${t.on?.event ?? 'an event'} happens on an endeavor`;
  if (t.kind === 'webhook') return 'when a webhook posts (bearer token admits; it grants nothing)';
  if (t.kind === 'message') return `when a message arrives${t.on?.profile ? ` (${t.on.profile})` : ''}`;
  return t.every ? `every ${t.every.replace(/^PT?/, '').toLowerCase()}` : 'on a schedule';
}

export function assembleRoutines(i: RoutineInputs): RoutineView[] {
  const byTrigger = new Map<string, RoutineView['history']>();
  for (const r of i.records) {
    const tid = (r.intent?.context as { trigger?: unknown } | undefined)?.trigger;
    if (typeof tid !== 'string') continue;
    const list = byTrigger.get(tid) ?? [];
    list.push({ runRef: r.runRef, at: r.at, state: stateOf({ kind: 'run', outcome: r.outcome as never, ...(r.canceled ? { canceled: true } : {}) }), native: r.outcome, steps: r.steps, receipts: r.receipts, ...((r as { bill?: { vaultCalls: number; doRequests: number } }).bill ? { bill: (r as { bill?: { vaultCalls: number; doRequests: number } }).bill } : {}) });
    byTrigger.set(tid, list);
  }
  return i.triggers.map((t) => {
    const kind = t.kind ?? 'schedule';
    const st = t.paused
      ? stateOf({ kind: 'trigger', lastOutcome: t.lastOutcome ?? 'answered', paused: true })
      : t.lastOutcome ? stateOf({ kind: 'trigger', lastOutcome: t.lastOutcome }) : { state: 'queued' as const, effectUncertain: false };
    return {
      triggerId: t.triggerId, ask: t.ask, source: sourceWords(t), kind,
      playbook: i.assignment ? { archetypeId: i.assignment.archetypeId, version: i.assignment.archetypeVersion, digest: i.assignment.definitionDigest, current: true } : null,
      state: st, native: t.paused ? `paused by ${t.paused.by}` : t.lastOutcome ?? 'never fired',
      paused: t.paused ?? null, budget: t.budget?.vaultCalls ?? null, budgetBy: t.budget ? (t.budget.declared ? 'playbook' : 'steward') : null, lastBill: t.lastBill ?? null, nextAt: t.nextAt ?? null,
      last: t.lastAt ? { at: t.lastAt, ...(t.lastRunRef ? { runRef: t.lastRunRef } : {}), outcome: t.lastOutcome ?? 'unknown', ...(t.lastSaid ? { said: t.lastSaid } : {}) } : null,
      history: (byTrigger.get(t.triggerId) ?? []).sort((a, b) => b.at - a.at),
      authority: 'every firing asks as the agent holding nothing; a firing that reaches an act parks and waits for a steward\'s mandate — never one carried from a previous firing',
    };
  });
}
