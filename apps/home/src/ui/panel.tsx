'use client';
// The readiness-aware pieces of the UI system (client components: they read the page's ReadyProvider). Split from
// index.tsx so a server-rendered page can still import the rest of the system without pulling a hook in.
import { useId, type ReactNode } from 'react';
import { useReadyReport, usePageReady } from './ready';
import { Unknown, Empty, EmptyState, SkeletonRows, timeLabel } from './index';

export type PanelState = 'loading' | 'ready' | 'empty' | 'unknown';

/**
 * A titled surface with ONE state. `loading` shows a skeleton (and counts toward the page's readiness); `ready`
 * shows the children; `empty` shows the fact (only ever after the read answered); `unknown` names the failed read.
 * A panel never shows an empty state while its read is still out — that is the half-done screen this replaces.
 */
export function Panel({ title, icon, count, aside, state, rows = 3, lead, empty, unknown, children, testId, id }: {
  title: ReactNode; icon?: ReactNode; count?: number; aside?: ReactNode; state: PanelState; rows?: number; lead?: boolean;
  /** The fact to say when there is nothing — a title and a line, optionally an action. */
  empty?: { icon?: ReactNode; title: ReactNode; hint?: ReactNode; action?: ReactNode };
  /** What could not be read (398 §6.3). */
  unknown?: { read: ReactNode; partial?: boolean };
  children?: ReactNode; testId?: string; id?: string;
}) {
  const autoId = useId();
  useReadyReport(id ?? autoId, state === 'loading');
  return (
    <section className="ui-panel" {...(testId ? { 'data-testid': testId } : {})} data-state={state}>
      <div className="ui-panel-head">
        <h2>{icon}{title}{typeof count === 'number' && state === 'ready' && <span className="ui-count">{count}</span>}</h2>
        {aside && <div className="ui-panel-aside">{aside}</div>}
      </div>
      {state === 'loading' && <SkeletonRows rows={rows} {...(lead ? { lead } : {})} />}
      {state === 'unknown' && unknown && <Unknown read={unknown.read} {...(unknown.partial ? { partial: true } : {})} />}
      {(state === 'ready' || (state === 'unknown' && unknown?.partial)) && children}
      {state === 'empty' && (empty ? <EmptyState {...empty} /> : <Empty>Nothing here.</Empty>)}
    </section>
  );
}


/** The page's own readiness line: pulses while reads are out; says "updated" once they are all in. */
export function PageReadyLine() {
  const { busy, settledAt } = usePageReady();
  if (!busy && !settledAt) return null;
  return <div className="ui-page-ready" data-busy={busy}>{busy ? 'Reading…' : `Up to date · ${timeLabel(settledAt!)}`}</div>;
}
export function PageProgress() { const { busy } = usePageReady(); return busy ? <div className="ui-progress" role="progressbar" aria-label="Loading" /> : null; }
