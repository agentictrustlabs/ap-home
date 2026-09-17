// AN AGENT'S BUDGET — the master gap analysis P1.4 (spec 398 §10 "cost visible; safe upgrade"; spec 396's numbers made a
// LIMIT). A steward declares, as a record in the agent's vault (`agent.budget`, `apctx:AgentBudget`), how much its agent
// may do in a day: asks, and vault calls (the unit spec 396 measures and every run's bill counts). The day's counters are
// SERVING-PLANE (DO-local on the agent's task object, rebuilt from the run records if wiped — a rebuild, not a
// bereavement); the record is the declaration and travels. Enforced at the door of `/harness/ask` BEFORE a model is
// called or a step runs: over budget ⇒ a stated refusal (429), never a silent degrade. A resume of a parked run is not a
// new ask and is not counted — the budget bounds what is STARTED, not what a person finishes signing.
import type { Address } from 'viem';
import { internalHeaders } from './internal-marker.js';

export const BUDGET_RECORD = 'agent.budget' as const;

export interface AgentBudgetV1 {
  type: 'ap.agent-budget.v1';
  /** Fresh asks per UTC day; null = unbounded. */
  asksPerDay: number | null;
  /** Vault calls per UTC day across the agent's runs (spec 396's unit); null = unbounded. */
  vaultCallsPerDay: number | null;
  note?: string;
  setBy?: string;
  setAt?: string;
}
export interface DayCounters { day: string; asks: number; vaultCalls: number; doRequests: number }

export const today = (now = Date.now()): string => new Date(now).toISOString().slice(0, 10);

export function budgetOf(raw: unknown): AgentBudgetV1 {
  const r = (raw ?? {}) as Partial<AgentBudgetV1>;
  const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null);
  return { type: 'ap.agent-budget.v1', asksPerDay: n(r.asksPerDay), vaultCallsPerDay: n(r.vaultCallsPerDay), ...(typeof r.note === 'string' ? { note: r.note.slice(0, 200) } : {}), ...(typeof r.setBy === 'string' ? { setBy: r.setBy } : {}), ...(typeof r.setAt === 'string' ? { setAt: r.setAt } : {}) };
}

/** What stands in the way, if anything — the sentence a person reads; null when within budget. */
export function overBudget(budget: AgentBudgetV1, counters: DayCounters): string | null {
  if (budget.asksPerDay !== null && counters.asks >= budget.asksPerDay) return `this agent's budget for today is spent: ${counters.asks} of ${budget.asksPerDay} asks (set by its steward; resets at 00:00 UTC)`;
  if (budget.vaultCallsPerDay !== null && counters.vaultCalls >= budget.vaultCallsPerDay) return `this agent's budget for today is spent: ${counters.vaultCalls} of ${budget.vaultCallsPerDay} vault calls (set by its steward; resets at 00:00 UTC)`;
  return null;
}

export interface BudgetEnv { A2A_TASKS: DurableObjectNamespace }
async function call(env: BudgetEnv, agent: Address, op: 'budget-get' | 'budget-ask', body: unknown): Promise<Record<string, unknown>> {
  const stub = env.A2A_TASKS.get(env.A2A_TASKS.idFromName(agent.toLowerCase()));
  const res = await stub.fetch(new Request(`https://a2a-task-do/internal/harness-run/${op}`, { method: 'POST', headers: internalHeaders(env as never), body: JSON.stringify(body) }));
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}
/** The agent's counters for the last `days` days (today first). */
export async function budgetCounters(env: BudgetEnv, agent: Address, days = 7): Promise<DayCounters[]> {
  const out = await call(env, agent, 'budget-get', { days });
  return (Array.isArray(out.days) ? out.days : []) as DayCounters[];
}
/** Count one fresh ask started now. */
export async function countAsk(env: BudgetEnv, agent: Address): Promise<void> {
  await call(env, agent, 'budget-ask', { day: today() }).catch(() => undefined);
}
