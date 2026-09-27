'use client';
// ONE TURN'S OPERATIONS — spec 418 §3. Where the turn's time went (the wall phases, then each named runtime stage), the
// model calls it made (role · model · tokens · ms, a skill's call under its step) and how it chose (the arm, the chosen
// skill or chain, the top probability, the hold). Numbers, names and ids as the runtime measured them — never prompt
// text. A fact the runtime did not record says "not recorded"; nothing here is estimated.
import { useState } from 'react';
import { fmtMs, stageWaterfallOf, classWord, type TurnModelCall, type TurnSelectionView, type turnModelCallsOf } from '../../../home/run-trace-view';

const BAR_BG = 'var(--color-border, #e5e7eb)';
const BAR_FG = 'var(--color-accent, #6366f1)';
const PHASE_FG = 'var(--color-accent-strong, #4338ca)';

function Bar({ ms, max, strong }: { ms: number; max: number; strong?: boolean }) {
  return (
    <span aria-hidden title={`${Math.round(ms)} ms`} style={{ display: 'inline-block', width: 96, height: 6, borderRadius: 3, background: BAR_BG, position: 'relative', flex: 'none' }}>
      <span style={{ position: 'absolute', inset: 0, width: `${Math.max(2, Math.min(100, (ms / max) * 100))}%`, borderRadius: 3, background: strong ? PHASE_FG : BAR_FG }} />
    </span>
  );
}
const row: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto 3.4rem', gap: 6, alignItems: 'center' };
const tokensWord = (c: { tokensIn?: number; tokensOut?: number }): string => (c.tokensIn !== undefined || c.tokensOut !== undefined ? `${c.tokensIn ?? '?'} → ${c.tokensOut ?? '?'} tok` : 'tokens not reported');

function CallRow({ c, indent }: { c: TurnModelCall; indent?: boolean }) {
  return (
    <div style={{ ...row, paddingLeft: indent ? 12 : 0 }} data-testid="turn-model-call" data-role={c.role}>
      <span style={{ minWidth: 0, overflowWrap: 'anywhere', color: c.failed ? 'var(--c-danger, #dc2626)' : undefined }}>
        <strong style={{ fontWeight: 600 }}>{c.role}</strong> · {c.provider ?? ''}{c.model ? `${c.provider ? ' / ' : ''}${c.model}` : c.provider ? '' : 'model'} · {tokensWord(c)}{c.failed ? ' · failed' : ''}
      </span>
      <span />
      <span style={{ textAlign: 'right' }}>{c.ms !== undefined ? fmtMs(c.ms) : '—'}</span>
    </div>
  );
}

export function TurnOperations({ stages, totalMs, calls, selection, selectionMs, skillStage, recalledTurns, contextId, testId = 'turn-operations' }: {
  stages?: Record<string, number>;
  /** The whole turn as the caller observed it (ms) — adds the after-run phase. */
  totalMs?: number;
  /** The turn's model calls; omit where another view already lists them (the run tree). */
  calls?: ReturnType<typeof turnModelCallsOf> | null;
  selection?: TurnSelectionView | null;
  selectionMs?: number;
  skillStage?: string;
  recalledTurns?: number;
  contextId?: string;
  testId?: string;
}) {
  const [allStages, setAllStages] = useState(false);
  const w = stageWaterfallOf(stages, totalMs);
  const shownStages = w ? (allStages ? w.stages : w.stages.slice(0, 6)) : [];
  return (
    <div data-testid={testId} style={{ marginTop: 4, fontSize: 11, lineHeight: 1.5 }}>
      {/* WHERE THE TIME WENT */}
      <div style={{ fontWeight: 600 }}>stages{w?.totalMs ? <span style={{ fontWeight: 400, opacity: 0.65 }}> · turn {fmtMs(w.totalMs)}</span> : null}</div>
      {!w && <div style={{ opacity: 0.65 }} data-testid="turn-stages-absent">stages: not recorded</div>}
      {w && (
        <div data-testid="turn-waterfall">
          {w.phases.map((p) => (
            <div key={p.name} style={row} data-testid="turn-phase"><span>{p.name}</span><Bar ms={p.ms} max={w.maxMs} strong /><span style={{ textAlign: 'right' }}>{fmtMs(p.ms)}</span></div>
          ))}
          {shownStages.map((s) => (
            <div key={s.name} style={{ ...row, paddingLeft: 12 }} data-testid="turn-stage"><span style={{ minWidth: 0, overflowWrap: 'anywhere', opacity: 0.85 }}>{s.name}</span><Bar ms={s.ms} max={w.maxMs} /><span style={{ textAlign: 'right' }}>{fmtMs(s.ms)}</span></div>
          ))}
          {w.stages.length > 6 && (
            <button type="button" className="btn ghost" style={{ fontSize: 10, padding: '0 6px', minHeight: 0 }} onClick={() => setAllStages((x) => !x)}>
              {allStages ? 'fewer stages' : `all ${w.stages.length} stages`}
            </button>
          )}
          {w.stages.length > 0 && <div style={{ opacity: 0.55 }}>stages are summed per name and may overlap — a profile, not a timeline</div>}
        </div>
      )}

      {/* THE MODEL CALLS */}
      {calls !== undefined && (
        <>
          <div style={{ fontWeight: 600, marginTop: 4 }}>
            model calls
            {calls?.reported ? <span style={{ fontWeight: 400, opacity: 0.65 }}> · {calls.tokensIn} → {calls.tokensOut} tokens</span> : null}
          </div>
          {!calls || (calls.run.length === 0 && calls.byStep.length === 0)
            ? <div style={{ opacity: 0.65 }}>no model call recorded on this turn</div>
            : (
              <div data-testid="turn-model-calls">
                {calls.run.map((c, i) => <CallRow key={`r${i}`} c={c} />)}
                {calls.byStep.map((g) => (
                  <div key={g.stepRef} data-testid="turn-step-calls">
                    <div style={{ opacity: 0.8 }}>step {g.stepRef}</div>
                    {g.calls.map((c, i) => <CallRow key={i} c={c} indent />)}
                  </div>
                ))}
              </div>
            )}
        </>
      )}

      {/* HOW IT CHOSE */}
      <div style={{ fontWeight: 600, marginTop: 4 }}>selection</div>
      {!selection
        ? <div style={{ opacity: 0.65 }} data-testid="turn-selection-absent">{skillStage === 'handed-to-planner' ? 'handed to the planner — no selection arm decided' : 'no selection arm ran on this turn'}{selectionMs !== undefined ? ` · choosing took ${fmtMs(selectionMs)}` : ''}</div>
        : (
          <div data-testid="turn-selection" data-approach={selection.approach}>
            <div>
              <strong style={{ fontWeight: 600 }}>{selection.approach}</strong>
              {selection.chose
                ? <> · chose <strong>{selection.chose}</strong></>
                : <span style={{ color: 'var(--c-warning, #92700e)' }}> · held{selection.hold ? ` (${selection.hold})` : ''}</span>}
              {selection.confidence !== undefined ? ` · top p ${selection.confidence.toFixed(2)}` : ''}
              {selection.judge ? ` · judge ${selection.judge}` : ''}
              {selectionMs !== undefined ? ` · ${fmtMs(selectionMs)}` : ''}
              {skillStage ? ` · skill stage ${skillStage}` : ''}
            </div>
            {selection.chain && selection.chain.length > 1 && <div>chain: {selection.chain.join(' → ')}</div>}
            {selection.missing?.length ? <div style={{ color: 'var(--c-warning, #92700e)' }}>missing: {selection.missing.map(classWord).join(', ')}</div> : null}
            {selection.supplied?.length ? <div>supplied by the request: {selection.supplied.slice(0, 6).map((x) => `${classWord(x.name)} ${x.p.toFixed(2)}`).join(' · ')}</div> : null}
            {selection.edges?.length ? <div>arrows: {selection.edges.slice(0, 6).map((x) => `${classWord(x.name)} ${x.p.toFixed(2)}`).join(' · ')}{selection.edges.length > 6 ? ` · +${selection.edges.length - 6}` : ''}</div> : null}
          </div>
        )}
      {(contextId || recalledTurns !== undefined) && (
        <div style={{ opacity: 0.7, marginTop: 2 }}>
          {contextId ? `conversation ${contextId.length > 18 ? `${contextId.slice(0, 12)}…${contextId.slice(-4)}` : contextId}` : 'no conversation id'}
          {recalledTurns !== undefined ? ` · ${recalledTurns} earlier turn${recalledTurns === 1 ? '' : 's'} recalled` : ''}
        </div>
      )}
    </div>
  );
}
