// THE ACCOUNTABLE WORK ITEM — spec 398 §4.3. One contract for one item, on every surface that shows it:
//   goal · accountable owner (a person or org SA) · executor (person or agent SA) · status (§5.1) · linked
//   conversation · output artifacts · acceptance condition and who accepts · what it cost.
// Projected from the endeavor detail (334/393) as the serving plane returns it. A field the record does not carry
// is said to be absent — never filled in from a guess: "acceptance: nobody named" is a true sentence, and the one
// that gets a steward to name an approver.
import type { WorkDetailResponse } from '../lib/work-client';
import { lifecycleState } from '../components/portal/work/labels';
import type { ProjectedRunStateV1 } from './run-state';

export interface WorkItemV1 {
  endeavorId: string;
  goal: string;
  /** Who is ACCOUNTABLE: the organization that manages the endeavor (its steward decides adoption, closure). */
  owner: { agent: string; kind: 'org' };
  /** Who does the work: every allocated participant, and those who committed (a person or an agent SA). A withdrawn or
   *  reallocated commitment is not an executor; an allocation row is the serving plane's current set. */
  executors: Array<{ agent: string; name?: string; via: 'allocation' | 'commitment'; steps: number }>;
  state: ProjectedRunStateV1;
  native: string;
  /** The context-linked topic (312), when the record names one. */
  conversation?: { topicId: string };
  /** run.artifact refs and Library versions linked to the item — none are linked by the record yet (398 gap). */
  artifacts: Array<{ ref: string; kind: string }>;
  acceptance: { criteria: string[]; approvers: Array<{ agent: string; decisionKind?: string; pending: boolean }> };
  /** 396's numbers — not yet carried by the endeavor record (harness G3); absent is absent. */
  cost: null | { vaultCalls: number; doRequests: number };
}

const lc = (s: string) => s.toLowerCase();

export function workItemOf(org: string, endeavorId: string, d: WorkDetailResponse): WorkItemV1 | null {
  const e = d.endeavor;
  if (!e) return null;
  const names = new Map((d.participations ?? []).map((p) => [lc(p.participant), p.participantName] as const));
  const executors = new Map<string, WorkItemV1['executors'][number]>();
  for (const a of d.allocations ?? []) {
    const k = lc(a.participant);
    const prev = executors.get(k);
    executors.set(k, { agent: k, ...(names.get(k) ? { name: names.get(k) } : {}), via: prev?.via === 'commitment' ? 'commitment' : 'allocation', steps: (prev?.steps ?? 0) + a.steps.length });
  }
  for (const c of d.commitments ?? []) {
    if (c.status !== 'active') continue;
    const k = lc(c.participant);
    const prev = executors.get(k);
    executors.set(k, { agent: k, ...(names.get(k) ? { name: names.get(k) } : {}), via: 'commitment', steps: Math.max(prev?.steps ?? 0, c.steps.length) });
  }
  const approvers = (d.decisions ?? []).map((x) => ({ agent: lc(x.approver), ...(x.decisionKind ? { decisionKind: x.decisionKind } : {}), pending: x.status === 'pending' }));
  return {
    endeavorId,
    goal: e.outcome?.description?.trim() || e.title,
    owner: { agent: lc(org), kind: 'org' },
    executors: [...executors.values()],
    state: lifecycleState(e.lifecycle),
    native: e.lifecycle,
    artifacts: [],
    acceptance: { criteria: e.outcome?.criteria ?? [], approvers },
    cost: null,
  };
}

/** The same contract on a LIST ROW (398 §4.3 — one item, every surface): what the row carries (goal, owner, status,
 *  progress) and what only the item carries (executors, artifacts, acceptance, cost) — said, not implied. */
export interface WorkItemRowV1 {
  goal: string;
  owner: { agent: string; kind: 'org' };
  state: ProjectedRunStateV1;
  native: string;
  progress: { satisfied: number; total: number } | null;
  /** The fields this row cannot answer — the item can. Never rendered as empty lists. */
  onItem: ReadonlyArray<'executors' | 'artifacts' | 'acceptance' | 'cost'>;
}
export function workItemRow(org: string, row: { title: string; lifecycle: string; stepsTotal?: number; stepsSatisfied?: number }): WorkItemRowV1 {
  const lc = row.lifecycle as Parameters<typeof lifecycleState>[0];
  return {
    goal: row.title, owner: { agent: org.toLowerCase(), kind: 'org' }, state: lifecycleState(lc), native: row.lifecycle,
    progress: typeof row.stepsTotal === 'number' ? { satisfied: row.stepsSatisfied ?? 0, total: row.stepsTotal } : null,
    onItem: ['executors', 'artifacts', 'acceptance', 'cost'],
  };
}
