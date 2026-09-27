'use client';
// HOW IT RAN — spec 415 A3 (LangSmith's run tree, with the authority column it lacks). The door the intent came
// through, the run under its variant, the model calls it made, the harness capabilities that engaged (skill selection:
// what it was offered, chose and rejected), each step with the SKILL contract that governed it and what permitted it,
// and a child run on another agent. Then, on request, the run's measurements from its vault (W3C DQV). Ids, kinds,
// verdicts and numbers — never the words of the ask or a result.
import { useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { fetchRunMeasures, type RunInspectorRecord, type RunMeasureRow } from '../../../home/ask';
import { traceTreeOf, flattenTree, stepMeasuresOf, type TraceNode } from '../../../home/run-trace-view';

const TONE: Record<NonNullable<TraceNode['tone']>, string> = { ok: 'var(--color-green-700, #15803d)', warn: 'var(--color-amber-700, #b45309)', bad: 'var(--c-danger, #dc2626)', muted: 'inherit' };
const KIND_MARK: Record<TraceNode['kind'], string> = { door: '⇢', run: '▣', model: '◇', step: '▸', child: '↳', engagement: '·' };

export function RunTraceTree({ token, addressee, runRef, rec }: { token: string; addressee: Address; runRef: string; rec: RunInspectorRecord }) {
  const [measures, setMeasures] = useState<RunMeasureRow[] | { error: string } | 'loading' | null>(null);
  // Spec 418 §3 — once the measurements are read, each step carries its model calls and tokens beside its time.
  const perStep = Array.isArray(measures) ? stepMeasuresOf(measures) : undefined;
  const rows = flattenTree(traceTreeOf({ ...rec, steps: rec.steps.map((s) => ({ ...s, ...(s.capability ? { capability: { id: s.capability.id } } : {}) })) }, perStep));
  const maxMs = Math.max(1, ...rows.map((r) => r.node.ms ?? 0));
  const load = async () => { setMeasures('loading'); setMeasures(await fetchRunMeasures({ token }, addressee, runRef).then((r) => ('rows' in r ? r.rows : r))); };
  const runLevel = Array.isArray(measures) ? measures.filter((m) => !m.step) : [];
  return (
    <div data-testid="run-trace-tree" style={{ marginTop: 2 }}>
      <div role="tree" aria-label="how this run ran">
        {rows.map(({ node, depth }) => (
          <div key={node.id} role="treeitem" aria-level={depth + 1} data-kind={node.kind} data-testid={`trace-node-${node.kind}`}
            style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 8, paddingLeft: depth * 14, alignItems: 'baseline' }}>
            <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
              <span aria-hidden style={{ opacity: 0.55, marginRight: 4 }}>{KIND_MARK[node.kind]}</span>
              <strong style={{ color: node.tone ? TONE[node.tone] : undefined, fontWeight: node.kind === 'engagement' ? 400 : 600 }}>{node.label}</strong>
              {node.facts.length ? <span> · {node.facts.join(' · ')}</span> : null}
              {node.kind === 'step' && <span style={{ opacity: 0.75 }} data-testid="trace-authority"> · {node.authority}</span>}
            </span>
            {node.ms !== undefined
              ? <span aria-hidden title={`${node.ms} ms`} style={{ display: 'inline-block', width: 64, height: 6, borderRadius: 3, background: 'var(--color-border, #e5e7eb)', position: 'relative' }}>
                  <span style={{ position: 'absolute', inset: 0, width: `${Math.max(4, (node.ms / maxMs) * 100)}%`, borderRadius: 3, background: 'var(--color-accent, #6366f1)' }} />
                </span>
              : <span />}
          </div>
        ))}
      </div>
      <div style={{ marginTop: 4 }}>
        {(measures === null || measures === 'loading') && (
          <button type="button" className="btn ghost" style={{ fontSize: 10.5, padding: '0 6px', minHeight: 0 }} onClick={() => void load()} disabled={measures === 'loading'} aria-busy={measures === 'loading'} data-testid="run-measures-load">
            {measures === 'loading' ? 'reading the measurements…' : 'measurements (per-step time, model calls, tokens)'}
          </button>
        )}
        {measures && typeof measures === 'object' && 'error' in measures && <span style={{ opacity: 0.7 }}>measurements: {measures.error}</span>}
        {Array.isArray(measures) && (
          <div data-testid="run-measures" style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 12px' }}>
            {runLevel.map((m) => <span key={m.metric}><span style={{ opacity: 0.65 }}>{m.metric}</span> {m.value}{m.unit && m.unit !== 'count' ? ` ${m.unit}` : ''}</span>)}
            <span style={{ opacity: 0.55 }}>· {measures.length - runLevel.length} per-step · W3C DQV, in the agent's vault</span>
          </div>
        )}
      </div>
    </div>
  );
}
