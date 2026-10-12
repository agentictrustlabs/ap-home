'use client';
// THE RUN INSPECTOR IS ARTIFACT-FIRST — spec 398 §5.2. Order, fixed: OUTCOME (how it ended, in the one vocabulary; what
// stood if it was stopped) → ARTIFACTS (391 — what the run left, by record and digest) → DECISIONS taken and pending
// (393 approvals, rule decisions, each step's authority verdict) → PLAN AND PER-STEP AUTHORITY (the plan as admitted,
// each step's verdict with the chain it read) → EXECUTION DETAIL (the spans: timings, models, routes — RunTimeline) →
// EVIDENCE (438 §4 — five readings of how complete the record is) → PROVENANCE (the PROV graph, downloadable).
// Model reasoning is not shown and is not evidence. Read from the record
// form of the run's provenance — digests, verdicts and names, never arguments or words.
import { useEffect, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { fetchRunInspector, homeVocabulary, type AskVocabularyEntry, type RunInspectorRecord, type RunInspectorStep } from '../../../home/ask';
import { retryAffordance } from '../../../home/retry';
import { stateOf } from '../../../home/run-state';
import { StatePill } from '../StatePill';
import { RunTimeline } from './RunTimeline';
import { RunTraceTree } from './RunTraceTree';
import { TurnOperations } from './TurnOperations';
import { DisputePanel } from './DisputePanel';
import { EvidencePanel } from './EvidencePanel';
import { WorkAndAssessment } from './WorkAndAssessment';
import { SaveAsRecipe } from './SaveAsRecipe';
import { canSaveAsRecipe } from '@agenticprimitives/harness/recipe';
import { usePathname } from 'next/navigation';
import { parseWorkspacePath } from '../../../lib/workspace';

/** Spec 410 §2 — the four words a receipt attests, said so a stranger reads them right. */
const ATTESTS: Record<'attempted' | 'accepted' | 'committed' | 'confirmed', string> = { attempted: 'attempted — nothing came back to vouch for it', accepted: 'accepted by the provider, not yet committed', committed: 'committed by the provider', confirmed: 'confirmed — read back' };

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
  const pathname = usePathname();
  const scope = parseWorkspacePath(pathname ?? '/');
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
      {/* Spec 398 §5 / APUX-034 — successful work becomes a draft recipe in the Library; a stopped or failed run does not. */}
      {canSaveAsRecipe(state, rec.outcome) && <SaveAsRecipe token={token} addressee={addressee} runRef={runRef} scope={scope} />}

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
              {/* Spec 410 §2 — the one word the receipt attests, and the provider's reference. "confirmed" alone means read back. */}
              {s.observation ? ` · ${ATTESTS[s.observation.outcome]}${s.observation.providerRef ? ` (${short(s.observation.providerRef, 18)})` : ''}` : ''}
              {s.receiptDigest ? ` · receipt ${short(s.receiptDigest)}` : ''}
              {/* WHAT THE STEP ASKED FOR, WHAT CAME BACK, AND WHO IT REACHED (spec 438 §13 / 426).
                  The inspector showed everything ABOUT a run and nothing OF it: a step that asked how many
                  unreached people groups are in Kenya rendered as a tool id, a receipt digest and a duration,
                  with the country, the number and the MCP server it reached all absent. A reader cannot check
                  a run whose substance is not in it. Bounded at the view: counts, flags and sources, never the
                  rows — the rows are the artifact's, listed above. */}
              {s.invoke && (
                <div style={{ opacity: 0.75, marginTop: 2 }}>
                  reached executor <strong>{s.invoke.executor}</strong> for <code>{s.invoke.intent}</code>
                </div>
              )}
              {s.args && (
                <div style={{ opacity: 0.75, marginTop: 2 }}>
                  asked: {Object.entries(s.args).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' · ')}
                </div>
              )}
              {s.output && (
                <div style={{ opacity: 0.75, marginTop: 2 }}>
                  came back: {Object.entries(s.output).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' · ')}
                  <span style={{ opacity: 0.7 }}> — a summary; the rows, when any were kept, are under artifacts above</span>
                </div>
              )}
            </span>
          </div>
        );
      })}

      {/* 4b · HOW IT RAN (spec 415 A3) — the run tree from the door: variant, model calls, skill selection, each step's
          skill and authority, child runs; the run's measurements on request. */}
      <H>how it ran</H>
      {/* Spec 418 §3 — the turn's operations as the record kept them (stages, selection, conversation); the model calls
          are in the tree below, each skill's under its step. A run recorded before 418 has none — said so. */}
      {rec.operational
        ? <TurnOperations testId="run-operations" stages={rec.operational.stages} selection={rec.operational.selection ?? null}
            {...(rec.operational.selectionMs !== undefined ? { selectionMs: rec.operational.selectionMs } : {})}
            {...(rec.operational.skillStage ? { skillStage: rec.operational.skillStage } : {})}
            {...(rec.operational.turn?.contextId ? { contextId: rec.operational.turn.contextId } : {})}
            {...(rec.operational.turn?.recalledTurns !== undefined ? { recalledTurns: rec.operational.turn.recalledTurns } : {})} />
        : <div style={{ opacity: 0.6 }} data-testid="run-operations-absent">operations (stages, selection): not recorded for this run</div>}
      <RunTraceTree token={token} addressee={addressee} runRef={runRef} rec={rec} />

      {/* 4b · EVIDENCE (spec 438 §4) — how complete what the run left behind actually is, in five separate
          readings. It sits ABOVE the span timeline because it is what tells a person whether to trust the
          detail below it: a run whose coverage is incomplete or whose parts disagree is not read the same way. */}
      <H>evidence</H>
      <EvidencePanel token={token} addressee={addressee} runRef={runRef} />

      {/* 4c · WORK AND ASSESSMENT (spec 438 §3 / §5) — what this run was part of, and whether anyone has judged
          it. Attaching is an ACT with an author, never an inference: everything needed to guess the endeavour is
          already on the record, and a guess would be indistinguishable from somebody's assertion. */}
      <H>work · assessment</H>
      <WorkAndAssessment
        token={token}
        addressee={addressee}
        runRef={runRef}
        {...(rec.work ? { work: rec.work } : {})}
        {...(scope.kind === 'org' ? { org: scope.org } : {})}
      />

      {/* 5 · EXECUTION DETAIL + 6 · PROVENANCE — the span timeline and its downloads */}
      <H>execution detail · provenance</H>
      <RunTimeline token={token} addressee={addressee} runRef={runRef} open />

      {/* 7 · THE DISPUTE (spec 410 §10) — whether a dispute cites this receipt, and what this person may do about it.
          The counterparty is whom the receipt names on the other side: the agent a step was routed to or acted by,
          else the run's own agent when that is not the viewer. */}
      <DisputePanel token={token} addressee={addressee} runRef={runRef} counterparty={counterpartyOf(rec, addressee)} stepRef={rec.steps.find((s) => s.authority && s.authority.decision === 'allow')?.stepRef} />
    </div>
  );
}

function counterpartyOf(rec: RunInspectorRecord, viewer: Address): Address | undefined {
  const me = viewer.toLowerCase();
  for (const s of rec.steps) {
    const other = (s.delegatedTo ?? s.actor?.actingAgent ?? '').toLowerCase();
    if (/^0x[0-9a-f]{40}$/.test(other) && other !== me) return other as Address;
  }
  return rec.agent.toLowerCase() !== me ? (rec.agent.toLowerCase() as Address) : undefined;
}
