'use client';
// Presentational primitives — the repeated inline-style shapes across the portal, extracted once.
// Token-driven (warm CSS vars via ui.css); every one accepts `style`/`className` passthrough so callers
// can still tweak without dropping back to a full inline object.
import { cloneElement, useId, type CSSProperties, type ReactElement, type ReactNode } from 'react';
import './ui.css';

type Div = { style?: CSSProperties; className?: string; children?: ReactNode };

/** Raised, bordered, rounded surface — replaces the recurring manage-card / panel inline block. */
export function Card({ style, className = '', children }: Div) {
  return <div className={`ap-card ${className}`.trim()} style={style}>{children}</div>;
}

/** Vertical flex. `gap` in rem. */
export function Stack({ gap = 0.5, style, className = '', children }: Div & { gap?: number }) {
  return <div className={`ap-stack ${className}`.trim()} style={{ gap: `${gap}rem`, ...style }}>{children}</div>;
}

/** Horizontal flex (align-items:center). `gap` in rem; `justify` maps to justify-content. */
export function Row({ gap = 0.5, justify, wrap, style, className = '', children }: Div & { gap?: number; justify?: CSSProperties['justifyContent']; wrap?: boolean }) {
  return <div className={`ap-row ${className}`.trim()} style={{ gap: `${gap}rem`, justifyContent: justify, flexWrap: wrap ? 'wrap' : undefined, ...style }}>{children}</div>;
}

/** Labelled form field — generates an id, wires label htmlFor + the input's aria-describedby to the
 *  hint/error, and shows an error in the danger token. Pass a single input/textarea/select child. */
export function Field({
  label,
  hint,
  error,
  required,
  children,
  style,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  children: ReactElement<Record<string, unknown>>;
  style?: CSSProperties;
}) {
  const id = useId();
  const descId = `${id}-desc`;
  const control = cloneElement(children, {
    id,
    'aria-invalid': error ? true : undefined,
    'aria-describedby': hint || error ? descId : undefined,
    'aria-required': required || undefined,
  });
  return (
    <div style={style}>
      <label htmlFor={id} className="ap-field-label">{label}{required && <span aria-hidden style={{ color: 'var(--color-danger)' }}> *</span>}</label>
      {control}
      {error ? <p id={descId} className="ap-field-error" role="alert">{error}</p>
        : hint ? <p id={descId} className="ap-field-hint">{hint}</p> : null}
    </div>
  );
}
