'use client';
// THE GCID BUTTON (Global.Church, global.church/gcid/developers): "Four strings, two variants, nothing
// else" — mark on the left, text on the right, fixed padding, no recolouring. Dark variant on dark
// backgrounds, light on light.
//
// A relying app opts its sign-in window into it (whitelabel `theme.gcidButtons`), so the person can see
// that what they are signing in WITH is GCID even on a window dressed in the app's own colours.
//
// The mark here is drawn from the published button (a filled circle carrying "GCID"); swap the SVG for
// Global.Church's file when it is in hand — it is the only place the mark is drawn.
import { createContext, useContext, type ButtonHTMLAttributes } from 'react';

export type GcidVariant = 'dark' | 'light';
export type GcidLabel = 'Sign in with GCID' | 'Continue with GCID' | 'Sign up with GCID' | 'Connect your GCID';

/** Set by ClientThemeScope from the client's theme; null = this window uses the Home's own buttons. */
export const GcidButtonContext = createContext<GcidVariant | null>(null);
export const useGcidButtons = (): GcidVariant | null => useContext(GcidButtonContext);

export function GcidMark({ variant, size = 22 }: { variant: GcidVariant; size?: number }) {
  const fill = variant === 'dark' ? '#6E6AF0' : '#3B37A6';
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false" style={{ flex: 'none' }}>
      <circle cx="12" cy="12" r="12" fill={fill} />
      <text x="12" y="14.6" textAnchor="middle" fontFamily="Inter, system-ui, sans-serif" fontSize="6.6" fontWeight="800" fill="#FFFFFF" letterSpacing=".2">
        GCID
      </text>
    </svg>
  );
}

export function GcidButton({
  variant,
  label,
  busyLabel,
  busy = false,
  className,
  ...rest
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
  variant: GcidVariant;
  label: GcidLabel;
  /** Shown while working (e.g. "Sending…"); the mark stays. */
  busyLabel?: string;
  busy?: boolean;
}) {
  return (
    <button {...rest} className={`gcid-button gcid-${variant}${className ? ` ${className}` : ''}`} aria-busy={busy || undefined}>
      <GcidMark variant={variant} />
      <span>{busy && busyLabel ? busyLabel : label}</span>
    </button>
  );
}
