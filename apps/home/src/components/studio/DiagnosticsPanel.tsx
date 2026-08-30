'use client';
// Diagnostics, grouped by severity in a FIXED order (design §4.3): Errors, Evidence needed (its own group —
// never folded into warnings), Warnings, Info. Group headings are real <h3>s so a screen-reader user can
// navigate the panel exactly the way a sighted steward scans it (design §11).
import { useState } from 'react';
import type { ProjectionDiagnosticV1 } from '@agenticprimitives/types';
import { groupDiagnostics, type DiagnosticView } from '../../lib/studio-view';
import { CodeBadge } from './ui';

const TONE: Record<DiagnosticView['severity'], string> = {
  error: 'var(--c-danger)',
  evidenceNeeded: 'var(--color-amber-700)',
  warning: 'var(--color-amber-700)',
  info: 'var(--c-g500)',
};

function Row({ d, onGoToField }: { d: DiagnosticView; onGoToField(pointer: string): void }) {
  const [why, setWhy] = useState(false);
  return (
    <li style={{ padding: '.45rem 0', borderBottom: '1px solid var(--c-g200)' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '.4rem', flexWrap: 'wrap' }}>
        <CodeBadge code={d.code} />
        <span style={{ fontSize: '.78rem', color: TONE[d.severity], flex: 1, minWidth: '12rem' }}>{d.message}</span>
      </div>
      <div style={{ display: 'flex', gap: '.4rem', marginTop: '.3rem', flexWrap: 'wrap' }}>
        {d.explanation && (
          <button type="button" className="btn-ghost" style={{ minHeight: 32, padding: '.25rem .5rem', fontSize: '.72rem' }} onClick={() => setWhy((w) => !w)}>
            {why ? 'Hide why' : 'Why'}
          </button>
        )}
        {d.fix && d.pointer && d.fix.kind === 'manual' && (
          <button type="button" className="btn-ghost" style={{ minHeight: 32, padding: '.25rem .5rem', fontSize: '.72rem' }} onClick={() => onGoToField(d.pointer as string)}>
            {d.fix.label}
          </button>
        )}
        {d.fix && d.fix.kind !== 'manual' && (
          <span
            title={
              d.fix.kind === 'approvalRequired'
                ? 'This fix is an approval-required action — naming it here never skips the approval step.'
                : 'This fix would be applied by the Studio service; no operation exposes it in this wave.'
            }
            style={{ fontSize: '.72rem', color: 'var(--c-g500)', alignSelf: 'center' }}
          >
            {d.fix.kind === 'approvalRequired' ? '🔒 ' : ''}
            {d.fix.label}
          </span>
        )}
      </div>
      {why && d.explanation && (
        <p className="manage-card-blurb" style={{ margin: '.3rem 0 0' }}>
          {d.explanation}
        </p>
      )}
    </li>
  );
}

export function DiagnosticsPanel({
  diagnostics,
  onGoToField,
  emptyText = 'Nothing to fix — this draft validates clean.',
}: {
  diagnostics: readonly ProjectionDiagnosticV1[];
  onGoToField(pointer: string): void;
  emptyText?: string;
}) {
  const groups = groupDiagnostics(diagnostics);
  const collapseInfo = diagnostics.length > 5;
  if (groups.length === 0) return <p className="manage-card-blurb">{emptyText}</p>;
  return (
    <div>
      {groups.map((g) => (
        <section key={g.id} style={{ marginBottom: '.7rem' }}>
          <h3 style={{ fontSize: '.75rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.03em', color: 'var(--c-g500)', margin: '0 0 .2rem' }}>
            {g.heading} ({g.items.length})
          </h3>
          {g.id === 'evidence' && (
            <p className="manage-card-blurb" style={{ margin: '0 0 .3rem' }}>
              These claims need the running agent to confirm them. Confirming interfaces from the Home isn&rsquo;t wired
              in this wave — deploy the agent and re-validate.
            </p>
          )}
          {g.id === 'info' && collapseInfo ? (
            <details>
              <summary style={{ fontSize: '.75rem', cursor: 'pointer', color: 'var(--c-g500)' }}>Show {g.items.length} informational item(s)</summary>
              <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {g.items.map((d, i) => (
                  <Row key={`${d.code}-${i}`} d={d} onGoToField={onGoToField} />
                ))}
              </ul>
            </details>
          ) : (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {g.items.map((d, i) => (
                <Row key={`${d.code}-${i}`} d={d} onGoToField={onGoToField} />
              ))}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
}
