'use client';
// THE GCID BUTTON (Global.Church, global.church/gcid/developers): "Four strings, two variants, nothing
// else" — mark on the left, text on the right, fixed padding, no recolouring. Dark variant on dark
// backgrounds, light on light.
//
// A relying app opts its sign-in window into it (whitelabel `theme.gcidButtons`), so the person can see
// that what they are signing in WITH is GCID even on a window dressed in the app's own colours.
//
// The mark is Global.Church's published file (gcid-mark.ts); the styles are the guide's, exactly.
import { createContext, useContext, type ButtonHTMLAttributes } from 'react';

import { GCID_MARK_DARK, GCID_MARK_LIGHT } from './gcid-mark';

export type GcidVariant = 'dark' | 'light';
export type GcidLabel = 'Sign in with GCID' | 'Continue with GCID' | 'Sign up with GCID' | 'Connect your GCID';

/** Set by ClientThemeScope from the client's theme; null = this window uses the Home's own buttons. */
export const GcidButtonContext = createContext<GcidVariant | null>(null);
export const useGcidButtons = (): GcidVariant | null => useContext(GcidButtonContext);

/** Global.Church's mark, from its published files (gcid-mark.ts) — never redrawn, recoloured or rescaled: 20px
 *  inside the button, as the guide requires. Decorative here: the button's text says GCID. */
export function GcidMark({ variant }: { variant: GcidVariant }) {
  return <img src={variant === 'dark' ? GCID_MARK_DARK : GCID_MARK_LIGHT} width={20} height={20} alt="" aria-hidden="true" style={{ flex: 'none', display: 'block' }} />;
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
