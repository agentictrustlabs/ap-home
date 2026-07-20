'use client';
// ONE loading affordance for any panel that is fetching data: a visible spinner + label so a busy
// page ALWAYS shows it is working (UX rule: no silent in-flight loads — the twin of BusyButton for
// whole-section reads). Use wherever a view holds `data === null` before its first render.
import type { CSSProperties } from 'react';

export function Loading({
  label = 'Loading…',
  compact = false,
  style,
}: {
  label?: string;
  /** Inline, smaller spinner for a row/sub-section rather than a full panel. */
  compact?: boolean;
  style?: CSSProperties;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: compact ? 'flex-start' : 'center',
        gap: '.6rem',
        padding: compact ? '.5rem 0' : '2.25rem 1rem',
        color: 'var(--color-text-muted, #64748b)',
        fontSize: '.85rem',
        ...style,
      }}
    >
      <span className={compact ? 'spinner' : 'spinner spinner-lg'} aria-hidden />
      <span>{label}</span>
    </div>
  );
}
