'use client';
// ONE loading affordance for any read in flight (UX rule: no silent in-flight loads — the twin of BusyButton for
// whole-section reads). Two things happen, always, so a busy page is OBVIOUS everywhere in the Home (owner,
// 2026-10-01: "instead of just showing 'Loading' in small text, show the progress bar like other areas"):
//   1. it REPORTS to the page's readiness (`useReadyReport`), so the thin amber progress line under the topbar runs
//      and the "updated" line waits — the same signal every `Panel` in a loading state sends;
//   2. it renders the SHAPE of what is coming (`SkeletonRows`), never a lone sentence; `compact` keeps a spinner +
//      label for a row or a sub-line.
// Use wherever a view holds `data === null` before its first render.
import { useId, type CSSProperties } from 'react';
import { SkeletonRows } from '../../ui';
import { useReadyReport } from '../../ui/ready';

export function Loading({
  label = 'Loading…',
  compact = false,
  rows = 3,
  style,
}: {
  label?: string;
  /** Inline, smaller spinner + label for a row/sub-section rather than a full panel. */
  compact?: boolean;
  /** Skeleton rows for the full-panel shape. */
  rows?: number;
  style?: CSSProperties;
}) {
  const id = useId();
  useReadyReport(id, true);
  if (compact) {
    return (
      <div role="status" aria-live="polite" aria-busy style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-start', gap: '.6rem', padding: '.5rem 0', color: 'var(--color-text-muted, #64748b)', fontSize: '.85rem', ...style }}>
        <span className="spinner" aria-hidden />
        <span>{label}</span>
      </div>
    );
  }
  return (
    <div role="status" aria-live="polite" aria-busy aria-label={label} style={style}>
      <SkeletonRows rows={rows} />
      <span className="ui-micro" style={{ display: 'block', marginTop: 'var(--sp-2)' }}>{label}</span>
    </div>
  );
}
