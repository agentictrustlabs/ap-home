// TODAY — spec 398 §4.2, the outcome-led first page. Order, FIXED: decisions awaiting me → active goals → recent
// artifacts → routine exceptions → one suggested next act. Message counts and infrastructure statistics are not
// here. This module is the PURE assembly (table-tested): it takes what the clients already return — the runs parked
// on the agent (350 W3, each with its projected state), the person's work across their organizations (334/393),
// the Library's artifacts (391), the schedule (375), the vocabulary the playbook offers this realm (K5) — and
// returns the five sections. It fetches nothing and decides nothing about authority: a card here is a pointer to
// the surface where the act is signed, never the act.
import type { AskVocabularyEntry, ParkedRun, TriggerRow } from './ask';
import type { OrgWorkBundle } from '../components/portal/work/useWork';
import { stateOf, type ProjectedRunStateV1, type RunStateV1, type AwaitingKind } from './run-state';
import { lifecycleState } from '../components/portal/work/labels';

/** One card. `state` renders as the StatePill; `href` opens the surface that owns the act; `askSeed` seeds the Ask. */
export interface TodayItem {
  id: string;
  title: string;
  detail?: string;
  href?: string;
  askSeed?: string;
  state?: ProjectedRunStateV1;
  native?: string;
  at?: number;
  /** An unfinished run of the agent Today is about — the card carries its cancel control (398 §5.3). */
  runRef?: string;
}

export interface Today {
  /** Spec 398 §5.4 — what the last N days COST this agent's storage (396 numbers on the records), or null when no record carries a bill. */
  cost: { runs: number; vaultCalls: number; doRequests: number; days: number } | null;
  decisions: TodayItem[];
  active: TodayItem[];
  artifacts: TodayItem[];
  exceptions: TodayItem[];
  /** One, or none — never a list, never from a hand-kept table. */
  next: TodayItem | null;
}

export interface TodayArtifact { id: string; name: string; kind?: string; folder?: string; createdAt: number; version?: number }

export interface TodayInputs {
  now: number;
  /** The runs parked on the agent Today is about, each with the state the runtime projected (398 §5.1). */
  parked: ReadonlyArray<ParkedRun & { state?: RunStateV1 }>;
  /** The person's work across their organizations; `null` until read — Today says so rather than showing nothing. */
  bundles: ReadonlyArray<OrgWorkBundle> | null;
  artifacts: ReadonlyArray<TodayArtifact>;
  triggers: ReadonlyArray<TriggerRow>;
  vocabulary: ReadonlyArray<AskVocabularyEntry>;
  /** How far back "recent" reaches for artifacts (days). */
  recentDays?: number;
  /** The agent's run records (the listing keeps each run's bill). */
  records?: ReadonlyArray<{ at: number; bill?: { vaultCalls: number; doRequests: number } }>;
  /** Where a decision's page lives — the person's own Work, or the organization's. */
  workHref?: (org: string, endeavorId: string) => string;
}

const saOf = (caip: string): string => caip.match(/0x[0-9a-fA-F]{40}$/)?.[0]?.toLowerCase() ?? caip;
const defaultWorkHref = (org: string, endeavorId: string): string => `/org/${saOf(org)}/work/${encodeURIComponent(endeavorId)}`;

const parkedState = (r: ParkedRun & { state?: RunStateV1 }): ProjectedRunStateV1 =>
  r.state ? { state: r.state, effectUncertain: false } : stateOf({ kind: 'suspended', awaiting: r.awaiting?.kind as AwaitingKind | undefined, expired: false });

export function assembleToday(input: TodayInputs): Today {
  const workHref = input.workHref ?? defaultWorkHref;
  const recentMs = (input.recentDays ?? 7) * 86_400_000;
  const decisions: TodayItem[] = [];
  const active: TodayItem[] = [];

  // ── 1. decisions awaiting me: a parked run waiting for MY signature (382), a declared-approver decision (393),
  //       an allocation waiting for my commitment (334) ─────────────────────────────────────────────────────────
  for (const r of input.parked) {
    const st = parkedState(r);
    const item: TodayItem = {
      id: `run:${r.runRef}`, title: r.message, state: st, at: r.updatedAt, runRef: r.runRef,
      askSeed: r.message,
      ...(r.awaiting?.prompt ? { detail: r.awaiting.prompt } : {}),
      ...(r.origin?.endeavorId && r.origin.principal ? { href: workHref(r.origin.principal, r.origin.endeavorId) } : {}),
    };
    if (st.state === 'awaiting-approval') decisions.push(item);
    else if (st.state === 'expired' || st.state === 'canceled') continue;
    else active.push(item);
  }
  for (const b of input.bundles ?? []) {
    for (const c of b.decisions) {
      decisions.push({
        id: `decision:${c.decisionId}`, title: c.title,
        detail: [b.orgName, c.summary, c.dueAt ? `due ${new Date(c.dueAt).toLocaleDateString()}` : undefined].filter(Boolean).join(' · '),
        href: workHref(b.org, c.endeavorId), state: { state: 'awaiting-approval', effectUncertain: false }, native: c.decisionKind,
        at: Date.parse(c.requestedAt),
      });
    }
    for (const e of b.entries) {
      if (e.status === 'allocated') {
        decisions.push({
          id: `allocation:${e.allocationId ?? e.endeavorId}`, title: e.endeavorTitle,
          detail: [b.orgName, `${e.stepIds.length} plan step${e.stepIds.length === 1 ? '' : 's'} waiting for your commitment`, e.deadline ? `due ${new Date(e.deadline).toLocaleDateString()}` : undefined].filter(Boolean).join(' · '),
          href: '/work', state: { state: 'awaiting-approval', effectUncertain: false }, native: 'allocated', at: Date.parse(e.updatedAt),
        });
      } else {
        // ── 2. active goals: what I committed to, and the endeavor it belongs to ──
        const endeavor = b.endeavors.find((x) => x.endeavorId === e.endeavorId);
        active.push({
          id: `commitment:${e.commitmentId ?? e.endeavorId}`, title: e.endeavorTitle,
          detail: [b.orgName, `${e.stepIds.length} step${e.stepIds.length === 1 ? '' : 's'} committed`, e.deadline ? `due ${new Date(e.deadline).toLocaleDateString()}` : undefined].filter(Boolean).join(' · '),
          href: workHref(b.org, e.endeavorId),
          state: endeavor ? lifecycleState(endeavor.lifecycle) : { state: 'running', effectUncertain: false },
          ...(endeavor ? { native: endeavor.lifecycle } : {}), at: Date.parse(e.updatedAt),
        });
      }
    }
  }
  // A routine parked for a signature is a decision too (375 → 382).
  for (const t of input.triggers) {
    if (t.lastOutcome === 'parked') {
      decisions.push({
        id: `trigger-parked:${t.triggerId}`, title: t.ask, detail: 'a routine is waiting for your signature',
        href: '/playbook', state: stateOf({ kind: 'trigger', lastOutcome: 'parked' }), native: 'parked', ...(t.lastAt ? { at: t.lastAt } : {}),
      });
    }
  }
  decisions.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  active.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));

  // ── 3. recent artifacts (391 run.artifact, Library releases) — newest first, the last N days ──
  const artifacts: TodayItem[] = input.artifacts
    .filter((a) => a.createdAt >= input.now - recentMs && a.createdAt <= input.now + 60_000)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 6)
    .map((a) => ({
      id: `artifact:${a.id}`, title: a.name,
      detail: [a.kind, a.version && a.version > 1 ? `v${a.version}` : undefined, a.folder ? `in ${a.folder}` : undefined].filter(Boolean).join(' · '),
      href: `/library?open=${encodeURIComponent(a.id)}`, at: a.createdAt,
    }));

  // ── 4. routine exceptions: a firing that failed (paused triggers are shown when the schedule carries pause) ──
  const exceptions: TodayItem[] = input.triggers
    .filter((t) => t.lastOutcome === 'failed')
    .map((t) => ({
      id: `trigger:${t.triggerId}`, title: t.ask, detail: t.lastSaid ? t.lastSaid.slice(0, 160) : 'the last firing failed',
      href: '/playbook', state: stateOf({ kind: 'trigger', lastOutcome: 'failed' }), native: 'failed', ...(t.lastAt ? { at: t.lastAt } : {}),
    }))
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0));

  // ── 5. one suggested next act — from the vocabulary the playbook offers THIS realm (K5-narrowed), never a hand
  //       list: the lowest-risk act with a label, that nothing above is already about; deterministic by id ──
  const busy = new Set(input.parked.map((r) => r.message.toLowerCase()));
  const rank = (t: string): number => ({ informational: 0, low: 1, medium: 2, high: 3, critical: 4 } as Record<string, number>)[t] ?? 5;
  const candidate = [...input.vocabulary]
    .filter((v) => (v.label ?? '').trim() && !busy.has((v.label ?? '').toLowerCase()))
    .sort((a, b) => rank(a.riskTier) - rank(b.riskTier) || a.id.localeCompare(b.id))[0];
  const next: TodayItem | null = candidate
    ? { id: `next:${candidate.id}`, title: candidate.label ?? candidate.id, ...(candidate.description || candidate.resultKind ? { detail: [candidate.description, candidate.resultKind ? `→ a ${candidate.resultKind}` : undefined].filter(Boolean).join(' · ') } : {}), askSeed: candidate.label ?? candidate.id, native: candidate.id }
    : null;

  // ── cost (§5.4): the bills on the records of the last N days — shown on Today because the record carries them (harness G3).
  const billed = (input.records ?? []).filter((r) => r.at >= input.now - recentMs && r.bill);
  const cost = billed.length
    ? { runs: billed.length, vaultCalls: billed.reduce((n, r) => n + (r.bill?.vaultCalls ?? 0), 0), doRequests: billed.reduce((n, r) => n + (r.bill?.doRequests ?? 0), 0), days: input.recentDays ?? 7 }
    : null;

  return { cost, decisions, active, artifacts, exceptions, next };
}
