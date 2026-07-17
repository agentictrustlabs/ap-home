'use client';
// ONE busy affordance for every async action button: while `busy`, the button disables, shows the
// global `.spinner`, and (optionally) swaps to `busyLabel` — so pressing a button ALWAYS visibly
// does something (UX rule 2026-07-10: no silent in-flight actions). Use for any button that awaits
// network or signing work; prefer a busyLabel that names the work ("Sending…", "Signing…").
import type { CSSProperties, ReactNode } from 'react';

export function BusyButton({
  busy,
  busyLabel,
  children,
  className = 'btn',
  style,
  disabled,
  onClick,
  title,
  'aria-label': ariaLabel,
  'aria-pressed': ariaPressed,
}: {
  busy: boolean;
  /** Label while busy (defaults to children). Name the work: "Sending…", "Signing…". */
  busyLabel?: ReactNode;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  disabled?: boolean;
  onClick: () => void;
  title?: string;
  'aria-label'?: string;
  'aria-pressed'?: boolean;
}) {
  return (
    <button
      type="button"
      className={className}
      style={{ display: 'inline-flex', alignItems: 'center', gap: '.4rem', ...style }}
      disabled={busy || disabled}
      aria-busy={busy}
      aria-label={ariaLabel}
      aria-pressed={ariaPressed}
      onClick={onClick}
      title={title}
    >
      {busy && <span className="spinner" aria-hidden style={{ width: '.85em', height: '.85em', borderWidth: 2 }} />}
      {busy ? (busyLabel ?? children) : children}
    </button>
  );
}
