'use client';
// Shared Studio chrome: badges, state chips, the mono code badge, and the live region every multi-step
// signing sequence announces through (design §3.2, §8.2, §11). Colour is NEVER the only signal — every
// chip pairs its colour with a word or a glyph.
import type { CSSProperties, ReactNode } from 'react';
import type { FieldBadge } from '@agenticprimitives/home';

export type Tone = 'good' | 'warn' | 'danger' | 'muted' | 'accent';

const TONE_STYLE: Record<Tone, CSSProperties> = {
  good: { background: 'var(--c-success-bg)', color: 'var(--color-sage-700)' },
  warn: { background: 'var(--color-amber-100)', color: 'var(--color-amber-700)' },
  danger: { background: 'var(--c-danger-bg)', color: 'var(--c-danger)' },
  muted: { background: 'var(--c-g100)', color: 'var(--c-g500)' },
  accent: { background: 'var(--c-primary-subtle)', color: 'var(--c-primary)' },
};

export function Chip({ tone = 'muted', children, title, style }: { tone?: Tone; children: ReactNode; title?: string; style?: CSSProperties }) {
  return (
    <span
      title={title}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '.25rem',
        fontSize: '.7rem',
        fontWeight: 700,
        borderRadius: 999,
        padding: '.12rem .45rem',
        lineHeight: 1.5,
        whiteSpace: 'nowrap',
        ...TONE_STYLE[tone],
        ...style,
      }}
    >
      {children}
    </span>
  );
}

const BADGE: Record<FieldBadge, { tone: Tone; glyph?: string; label: string; help: string; outline?: boolean; italic?: boolean }> = {
  inherited: { tone: 'muted', label: 'Inherited', help: 'Comes from the profile, naming, catalog, runtime or claims — untouched.' },
  overridden: { tone: 'accent', label: 'Overridden', help: 'Was inherited; you replaced it. That is a recorded decision.' },
  manual: { tone: 'accent', outline: true, label: 'Manual', help: 'Hand-authored — no inherited source exists for this field.' },
  computed: { tone: 'muted', glyph: '⚙', label: 'Computed', help: 'Derived by the runtime — not editable by typing.' },
  verified: { tone: 'good', glyph: '✓', label: 'Verified', help: 'Runtime-tested and confirmed true.' },
  stale: { tone: 'warn', glyph: '⚠', label: 'Source changed', help: 'The inherited source changed since this field was last accepted.' },
  conflict: { tone: 'danger', glyph: '✕', label: 'Conflict', help: 'Two sources disagree and neither is recorded as chosen.' },
  'projection-only': { tone: 'muted', italic: true, label: 'Projection only', help: 'Only meaningful to one projection target, not the base card.' },
};

export function FieldBadgeChip({ badge }: { badge: FieldBadge }) {
  const b = BADGE[badge];
  return (
    <Chip
      tone={b.tone}
      title={b.help}
      style={{
        ...(b.outline ? { background: 'transparent', border: '1px solid var(--c-primary-border)' } : {}),
        ...(b.italic ? { fontStyle: 'italic' } : {}),
      }}
    >
      {b.glyph && <span aria-hidden>{b.glyph}</span>}
      {b.label}
    </Chip>
  );
}

/** Small mono code badge — for support/dev correlation. NEVER the only thing a steward reads (design §5). */
export function CodeBadge({ code }: { code: string }) {
  return (
    <code style={{ fontSize: '.68rem', background: 'var(--c-g100)', color: 'var(--c-g700)', padding: '.1rem .3rem', borderRadius: 4 }}>{code}</code>
  );
}

export function Digest({ value, label }: { value: string; label?: string }) {
  if (!value) return null;
  return (
    <code title={value} style={{ fontSize: '.72rem', color: 'var(--c-g500)' }}>
      {label ? `${label} ` : ''}
      {value.length > 22 ? `${value.slice(0, 19)}…` : value}
    </code>
  );
}

/** Visually-hidden polite live region — multi-step signing/publishing narrates each transition (design §11). */
export function LiveRegion({ message }: { message: string }) {
  return (
    <span
      aria-live="polite"
      style={{ position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0 }}
    >
      {message}
    </span>
  );
}

export function Banner({ tone, children, actions }: { tone: Tone; children: ReactNode; actions?: ReactNode }) {
  const s = TONE_STYLE[tone];
  return (
    <div
      role="status"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '.7rem',
        flexWrap: 'wrap',
        background: s.background,
        color: s.color,
        border: '1px solid var(--c-g200)',
        borderRadius: 8,
        padding: '.6rem .75rem',
        fontSize: '.8rem',
        margin: '0 0 .8rem',
      }}
    >
      <span>{children}</span>
      {actions && <span style={{ display: 'flex', gap: '.4rem' }}>{actions}</span>}
    </div>
  );
}

export function ErrorLine({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p className="manage-card-blurb" role="alert" style={{ color: 'var(--c-danger)', margin: '.4rem 0' }}>
      {error}
    </p>
  );
}

export const inputStyle: CSSProperties = {
  width: '100%',
  padding: '.5rem .7rem',
  borderRadius: 8,
  border: '1px solid var(--c-g300)',
  fontSize: '.85rem',
  background: 'var(--color-surface)',
  color: 'var(--c-g900)',
  minHeight: 40,
};

/** 44×44 hit area on touch, whatever the visual size (design §11 target size). */
export const iconButtonStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  minWidth: 32,
  minHeight: 32,
  padding: '.4rem',
  border: '1px solid var(--c-g200)',
  background: 'var(--color-surface)',
  borderRadius: 6,
  cursor: 'pointer',
  color: 'var(--c-g700)',
  fontSize: '.8rem',
};
