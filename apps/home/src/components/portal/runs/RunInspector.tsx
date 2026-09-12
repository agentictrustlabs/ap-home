'use client';
// THE RUN INSPECTOR IS ARTIFACT-FIRST — spec 398 §5.2. Order, fixed: OUTCOME (how it ended, in the one vocabulary; what
// stood if it was stopped) → ARTIFACTS (391 — what the run left, by record and digest) → DECISIONS taken and pending
// (393 approvals, rule decisions, each step's authority verdict) → PLAN AND PER-STEP AUTHORITY (the plan as admitted,
// each step's verdict with the chain it read) → EXECUTION DETAIL (the spans: timings, models, routes — RunTimeline) →
// PROVENANCE (the PROV graph, downloadable). Model reasoning is not shown and is not evidence. Read from the record
// form of the run's provenance — digests, verdicts and names, never arguments or words.
import { useEffect, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { fetchRunInspector, homeVocabulary, type AskVocabularyEntry, type RunInspectorRecord, type RunInspectorStep } from '../../../home/ask';
import { retryAffordance } from '../../../home/retry';
import { stateOf } from '../../../home/run-state';
import { StatePill } from '../StatePill';
import { RunTimeline } from './RunTimeline';

const short = (v: unknown, n = 14): string => { const t = String(v ?? ''); return t.length > n ? `${t.slice(0, n - 4)}…${t.slice(-3)}` : t; };
const kb = (b: number): string => (b >= 1024 ? `${(b / 1024).toFixed(1)} kB` : `${b} B`);

function H({ children, n }: { children: React.ReactNode; n?: number }) {
  return <div style={{ fontWeight: 600, marginTop: '0.55rem', display: 'flex', gap: '0.4rem', alignItems: 'baseline' }}>{children}{typeof n === 'number' && <span style={{ fontWeight: 400, opacity: 0.6 }}>{n}</span>}</div>;
}

/** Spec 398 §5.3 — what stood, in words. */
export function stoppedWords(c: NonNullable<RunInspectorRecord['canceled']>): string {
  return c.afterSteps === 0 ? 'stopped before any step ran' : `stopped after step ${c.afterSteps}; step${c.afterSteps === 1 ? ' 1' : `s 1–${c.afterSteps}`} happened`;
}

export function RunInspector({ token, addressee, runRef, goal, open = true }: { token: string; addressee: Address; runRef: string; /** the ask's words, from the listing — provenance never carries them */ goal?: string; /** false ⇒ a button opens it (the Ask's How pane); nothing is fetched for a run nobody opens */ open?: boolean }) {
  const [wanted, setWanted] = useState(open);
  const [rec, setRec] = useState<RunInspectorRecord | { error: string } | null>(null);
  const [vocabulary, setVocabulary] = useState<AskVocabularyEntry[]>([]);
  useEffect(() => {
    if (!wanted) return;
    let live = true;
    void fetchRunInspector({ token }, addressee, runRef).then((r) => { if (live) setRec(r); });
    void homeVocabulary(addressee).then((v) => { if (live) setVocabulary(v); }).catch(() => undefined);
    return () => { live = false; };
  }, [token, addressee, runRef, wanted]);
  if (!wanted) return <div className="muted" style={{ marginTop: 4, fontSize: 11.5 }}><button type="button" className="btn ghost" style={{ fontSize: 10.5, padding: '0 6px', minHeight: 0 }} onClick={() => setWanted(true)}>inspect this run</button></div>;
  if (rec === null) return <div className="muted" style={{ fontSize: 11.5 }}>reading the run back…</div>;
  if ('error' in rec) return <div className="muted" style={{ fontSize: 11.5, color: 'var(--c-danger, #dc2626)' }}>{rec.error}</div>;

  const state = stateOf({ kind: 'run', outcome: rec.outcome as never, ...(rec.canceled ? { canceled: true } : {}) });
  const artifacts = rec.steps.filter((s): s is RunInspectorStep & { artifact: NonNullable<RunInspectorStep['artifact']> } => !!s.artifact);
  const approvals = rec.steps.filter((s) => s.authority?.afterApproval);
  const ruleDecisions = rec.steps.flatMap((s) => (s.decisions ?? []).map((d) => ({ step: s.stepRef, ...d })));
  const pending = rec.steps.filter((s) => s.status === 'suspended' || s.status === 'authority-required' || s.status === 'awaiting');
  const effects = rec.steps.flatMap((s) => (s.effects ?? []).map((e) => ({ step: s.stepRef, ...e })));
  const txs = rec.steps.filter((s) => s.txHash);
  // Spec 398 §7.2 (1) — the retry affordance comes from the acted capability's declared idempotency, never from a guess.
  const acted = [...rec.steps].reverse().find((s) => s.capability?.id) ?? rec.steps[rec.steps.length - 1];
  const retry = retryAffordance(state, acted?.capability?.id ?? acted?.toolId, vocabulary);

  return (
    <div className="muted" style={{ marginTop: 4, fontSize: 11.5, lineHeight: 1.55 }} data-testid="run-inspector">
      {/* 1 · OUTCOME */}
      <H>outcome <StatePill state={state} native={rec.outcome} compact /></H>
      <div>
        {rec.canceled ? <>{stoppedWords(rec.canceled)}{rec.canceled.note ? ` — “${rec.canceled.note}”` : ''} · </> : null}
        {rec.steps.length} of {rec.plannedSteps ?? rec.steps.length} planned step{(rec.plannedSteps ?? rec.steps.length) === 1 ? '' : 's'} ran
        {effects.length ? ` · ${effects.filter((e) => e.ok).length}/${effects.length} effect${effects.length === 1 ? '' : 's'} produced` : ''}
        {txs.length ? ` · on chain: ${txs.map((s) => short(s.txHash)).join(', ')}` : ''}
        {rec.playbook ? ` · playbook ${rec.playbook.skillId}@${rec.playbook.version}` : ''}
        {rec.inResponseTo ? ` · in response to ${short(rec.inResponseTo.agent, 12)} run ${short(rec.inResponseTo.runRef, 16)}` : ''}
        {rec.bill ? ` · cost: ${rec.bill.vaultCalls} vault call${rec.bill.vaultCalls === 1 ? '' : 's'}, ${rec.bill.doRequests} serving request${rec.bill.doRequests === 1 ? '' : 's'}` : ''}
      </div>
      {retry.kind !== 'none' && (
        <div data-testid="run-retry" data-retry={retry.kind} title={retry.why}>
          <a href={`/ask${goal ? `?seed=${encodeURIComponent(goal)}` : ''}`}>{retry.label} →</a> <span style={{ opacity: 0.6 }}>{retry.why}</span>
        </div>
      )}

      {/* 2 · ARTIFACTS */}
      <H n={artifacts.length}>artifacts</H>
      {artifacts.length === 0
        ? <div style={{ opacity: 0.6 }}>nothing kept beyond the record (a result below the offload threshold stays in it)</div>
        : artifacts.map((s) => (
          <div key={s.stepRef} data-testid="run-artifact">
            <strong>{s.artifact.recordType}</strong> · {kb(s.artifact.bytes)} · from {s.toolId} ({s.stepRef}) · digest {short(s.artifact.digest)}
            {' '}<a href={`/library?q=${encodeURIComponent(s.artifact.recordType)}`}>in the Library →</a>
          </div>
        ))}

      {/* 3 · DECISIONS */}
      <H n={approvals.length + ruleDecisions.length + pending.length}>decisions</H>
      {approvals.length === 0 && ruleDecisions.length === 0 && pending.length === 0 && <div style={{ opacity: 0.6 }}>none were needed</div>}
      {approvals.map((s) => <div key={`a:${s.stepRef}`}>✓ approved: {s.capability?.id ?? s.toolId} ({s.stepRef}){s.authority?.presentedRef ? ` under ${short(s.authority.presentedRef)}` : ''}</div>)}
      {ruleDecisions.map((d, i) => <div key={`d:${i}`}>· {d.point} → rule {d.ruleId} ({d.step})</div>)}
      {pending.map((s) => <div key={`p:${s.stepRef}`} style={{ color: 'var(--color-amber-700, #b45309)' }}>pending: {s.capability?.id ?? s.toolId} ({s.stepRef}) — {s.status}</div>)}

      {/* 4 · PLAN AND PER-STEP AUTHORITY */}
      <H n={rec.steps.length}>plan and authority</H>
      {rec.steps.map((s) => {
        const st = stateOf({ kind: 'step', status: s.status });
        return (
          <div key={s.stepRef} style={{ display: 'flex', gap: 8, alignItems: 'baseline' }} data-testid="run-step">
            <span style={{ flex: 'none', width: 28, opacity: 0.6 }}>{s.stepRef}</span>
            <span style={{ flex: 1 }}>
              <strong>{s.capability?.id ?? s.toolId}</strong>{s.risk ? ` (${s.risk})` : ''} · <StatePill state={st} native={s.status} compact />
              {s.authority ? ` · authority ${s.authority.decision}${s.authority.presentedRef ? ` under ${short(s.authority.presentedRef)}` : ' — none presented'}${s.authority.chain ? `, chain depth ${s.authority.chain.depth} from ${short(s.authority.chain.accountabilityRoot, 12)}` : ''}${s.authority.afterApproval ? ' (after approval)' : ''}` : ' · no authority stage (informational)'}
              {s.actor?.actingAgent && s.actor.actingAgent.toLowerCase() !== rec.agent.toLowerCase() ? ` · acted by ${short(s.actor.actingAgent, 12)}` : ''}
              {s.delegatedTo ? ` · handed to ${short(s.delegatedTo, 12)}${s.delegatedToRun ? ` (run ${short(s.delegatedToRun, 16)})` : ''}` : ''}
              {s.errorClass ? ` · ${s.errorClass}` : ''}
              {s.receiptDigest ? ` · receipt ${short(s.receiptDigest)}` : ''}
            </span>
          </div>
        );
      })}

      {/* 5 · EXECUTION DETAIL + 6 · PROVENANCE — the span timeline and its downloads */}
      <H>execution detail · provenance</H>
      <RunTimeline token={token} addressee={addressee} runRef={runRef} open />
    </div>
  );
}
