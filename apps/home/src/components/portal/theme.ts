// Shared inline-style tokens for portal pages that pre-date the `manage-card`/`btn-*` CSS classes
// (Registry, Naming, "What this agent can do" — spec 279/280/282). These once hardcoded an indigo palette independent
// of the app's amber design tokens (`app/globals.css`); this module is the single source so all three
// pages render as ONE visual language, using the same CSS variables as every other portal surface.
// New self-contained-inline portal pages should import from here rather than re-declaring locally.
import type { CSSProperties } from 'react';

// 2026-09-12 — these now mirror the UI system (`src/ui`, `.ui-*`): the same card, button, input and chip as every
// page on the system, so the legacy inline pages read as one product until each is moved onto the primitives.
export const cardSty: CSSProperties = {
  background: 'var(--color-surface)',
  border: '1px solid var(--color-border)',
  borderRadius: 10,
  padding: '16px 20px',
};

export const btnSty: CSSProperties = {
  padding: '7px 12px',
  minHeight: 34,
  borderRadius: 8,
  fontWeight: 600,
  fontSize: '13.5px',
  lineHeight: 1,
  cursor: 'pointer',
  border: '1px solid var(--color-border-strong)',
  background: 'var(--color-surface)',
  color: 'var(--color-text-primary)',
  font: 'inherit',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
};

export const btnPrimarySty: CSSProperties = {
  ...btnSty,
  background: 'var(--color-action)',
  color: 'var(--color-action-fg)',
  border: '1px solid transparent',
};

export const mono: CSSProperties = { fontFamily: 'var(--font-mono)' };

export const mutedText: CSSProperties = { color: 'var(--color-text-muted)' };
export const errorText: CSSProperties = { color: 'var(--color-danger)' };

export const inputSty: CSSProperties = {
  padding: '7px 10px',
  borderRadius: 8,
  border: '1px solid var(--color-border-strong)',
  font: 'inherit',
  fontSize: '13.5px',
  background: 'var(--color-surface)',
  color: 'var(--color-text-primary)',
};

export type BadgeKind = 'ok' | 'warn' | 'err' | 'neutral';

export const BADGE_STY: Record<BadgeKind, CSSProperties> = {
  ok: { color: 'var(--color-sage-700)', background: 'var(--color-sage-50)', borderColor: 'var(--color-sage-500)' },
  warn: { color: 'var(--color-amber-700)', background: 'var(--color-amber-50)', borderColor: 'var(--color-amber-400)' },
  err: { color: '#991b1b', background: 'var(--color-danger-subtle)', borderColor: '#fecaca' },
  neutral: { color: 'var(--color-text-muted)', background: 'var(--color-surface-sunken)', borderColor: 'var(--color-border)' },
};

export function badgeStyle(kind: BadgeKind): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '.3rem',
    fontSize: '11.5px',
    fontWeight: 600,
    padding: '1px 8px',
    borderRadius: 999,
    border: '1px solid',
    whiteSpace: 'nowrap',
    ...BADGE_STY[kind],
  };
}

/** Toggle "pill" used by "What this agent can do" (published/private) — same visual language as `badgeStyle`. */
export function pillStyle(on: boolean): CSSProperties {
  return {
    fontSize: '11.5px',
    fontWeight: 600,
    padding: '1px 8px',
    borderRadius: 999,
    border: '1px solid',
    cursor: 'pointer',
    ...(on ? BADGE_STY.ok : BADGE_STY.neutral),
  };
}

/** Amber info banner — matches `.settings-banner--info` / `chat-dm-resolution-banner` elsewhere. */
/** An explanatory note — quiet, never an amber wash (amber is for warnings and the primary action). */
export const infoBannerSty: CSSProperties = {
  ...cardSty,
  background: 'var(--color-surface-raised)',
  color: 'var(--color-text-body)',
  fontSize: '12.5px',
  lineHeight: 1.5,
};

export const modalOverlaySty: CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(28, 25, 23, 0.5)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 1000,
  padding: '1rem',
};

export const shortAddr = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;
