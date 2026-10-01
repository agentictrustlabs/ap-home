'use client';
// HOW TO READ THIS PAGE — a short panel above a report: the measured thing in a sentence, then each word that appears
// below, in plain language (owner, 2026-10-01: "Evals is not clear at all"). Words only; it derives no number.
import { CheckIcon } from '../shared/Icons';
import { Panel } from '../../ui/panel';

export function HowToRead({ lines, testId }: { lines: ReadonlyArray<readonly [string, string]>; testId?: string }) {
  return (
    <Panel title="How to read this page" icon={<CheckIcon size={18} />} state="ready" {...(testId ? { testId } : {})}>
      <div className="ui-panel-body">
        <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'minmax(9rem, 12rem) 1fr', gap: '.35rem 1rem' }}>
          {lines.map(([term, words]) => (
            <div key={term} style={{ display: 'contents' }}>
              <dt style={{ fontWeight: 600 }}>{term}</dt>
              <dd style={{ margin: 0 }}>{words}</dd>
            </div>
          ))}
        </dl>
      </div>
    </Panel>
  );
}
