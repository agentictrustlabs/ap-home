'use client';
// THE STATE PILL — spec 398 §5.1: the one way a run, task, endeavor or trigger state is shown. Renders the
// projected word (`runStateLabel`), coloured by tone, with the record's native term as the tooltip when the
// caller has one worth showing ("Planning" under `queued`). `data-state` carries the projected word for tests
// and for the census gate.
import type { CSSProperties } from 'react';
import { runStateLabel, stateTone, type ProjectedRunStateV1 } from '../../home/run-state';

const TONE: Record<ReturnType<typeof stateTone>, { bg: string; fg: string; border: string }> = {
  idle: { bg: 'var(--color-surface-sunken, #f4f4f2)', fg: 'var(--color-text-muted, #6b7280)', border: 'var(--color-border)' },
  active: { bg: 'var(--color-sage-50, #f0f7f2)', fg: 'var(--color-sage-700, #2f6846)', border: 'var(--color-sage-500, #5f9b76)' },
  attention: { bg: 'var(--color-amber-50, #fffbeb)', fg: 'var(--color-amber-700, #b45309)', border: 'var(--color-amber-400, #fbbf24)' },
  done: { bg: 'var(--color-sage-100, #dfeee4)', fg: 'var(--color-sage-700, #2f6846)', border: 'var(--color-sage-500, #5f9b76)' },
  bad: { bg: 'var(--color-red-50, #fef2f2)', fg: 'var(--color-red-700, #b91c1c)', border: 'var(--color-red-300, #fca5a5)' },
  // unknown — reconciling: neither running's green nor failed's red, on purpose (T10)
  uncertain: { bg: 'var(--color-surface-sunken, #f4f4f2)', fg: 'var(--color-text, #111827)', border: 'var(--color-amber-400, #fbbf24)' },
};

export function statePillStyle(p: ProjectedRunStateV1, extra?: CSSProperties): CSSProperties {
  const t = TONE[stateTone(p)];
  return {
    display: 'inline-block', padding: '1px 8px', borderRadius: 999, fontSize: '11.5px', fontWeight: 600, lineHeight: 1.5,
    whiteSpace: 'nowrap', background: t.bg, color: t.fg, border: `1px solid ${t.border}`, ...(extra ?? {}),
  };
}

export function StatePill({ state, native, style, compact }: { state: ProjectedRunStateV1 & { unknownNative?: string }; native?: string; style?: CSSProperties; compact?: boolean }) {
  const label = runStateLabel(state);
  const tip = state.unknownNative ? `unmapped state: ${state.unknownNative}` : native && native !== label ? native : undefined;
  return (
    <span
      className="state-pill"
      data-state={state.state}
      data-effect-uncertain={state.effectUncertain ? 'true' : undefined}
      title={tip}
      style={statePillStyle(state, { ...(compact ? { fontSize: '11px', padding: '0 7px' } : {}), ...(style ?? {}) })}
    >
      {label}
    </span>
  );
}
