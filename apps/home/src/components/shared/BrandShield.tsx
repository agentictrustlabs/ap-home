// The brand shield mark. Amber gradient in the portal (the warm faith identity); a
// `generic` indigo variant remains available for the neutral external-popup context
// (design §2.6). The wordmark/brand name itself is white-label config, supplied separately.
import { GCID_MARK_DARK } from './gcid-mark';

type Variant = 'brand' | 'generic';

const STOPS: Record<Variant, [string, string, string]> = {
  brand: ['#fbbf24', '#f59e0b', '#d97706'],
  generic: ['#818cf8', '#4338ca', '#3730a3'],
};

/** A deployment can carry its operator's mark instead of the shield (NEXT_PUBLIC_BRAND_MARK). Inlined at build.
 *    'gcid'  — GCID's own mark, the round indigo "GCID" (Global.Church's published file, gcid-mark.ts). What GCID's
 *              deployments wear from 2026-10-13: the sign-in page is GCID's, so it carries GCID's mark, the same one
 *              that is on its button.
 *    'globe' — Global.Church's globe (2026-10-12, replaced by 'gcid' a day later; kept for a deployment that wants it).
 *    unset   — the shield, as before. */
export const BRAND_MARK = process.env.NEXT_PUBLIC_BRAND_MARK;
export const GLOBE_BLUE = '#4F8BE0';

/** Global.Church's globe, as drawn on global.church: a stroked circle with two meridians and two parallels, in its
 *  blue. --brand-mark-color lets a themed window adjust the blue for its ground. */
function GlobeMark({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden="true" style={{ color: `var(--brand-mark-color, ${GLOBE_BLUE})` }}>
      <GlobeLines stroke="currentColor" />
    </svg>
  );
}

/** The globe's lines alone (viewBox 0 0 100 100), for the images next/og draws at build time (app/icon.tsx,
 *  app/opengraph-image.tsx), where there is no CSS: the caller gives the colour, and a favicon a heavier line.
 *  Those two CALL it ({GlobeLines({...})}) — next/og does not run a component nested inside an <svg>. */
export function GlobeLines({ stroke, strokeWidth = 5 }: { stroke: string; strokeWidth?: number }) {
  return (
    <g fill="none" stroke={stroke} strokeWidth={strokeWidth}>
      <circle cx="50" cy="50" r="44" />
      <ellipse cx="50" cy="50" rx="0.5" ry="44" />
      <ellipse cx="50" cy="50" rx="25" ry="44" />
      <ellipse cx="50" cy="50" rx="44" ry="0.5" />
      <ellipse cx="50" cy="50" rx="44" ry="25" />
    </g>
  );
}

/** GCID's mark at any size. The published file, never redrawn or recoloured — only scaled. */
function GcidCircle({ size }: { size: number }) {
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={GCID_MARK} width={size} height={size} alt="" aria-hidden="true" style={{ display: 'block', flex: 'none' }} />;
}
/** The one file both the page and the build-time images (app/icon.tsx, app/opengraph-image.tsx) draw. */
export const GCID_MARK = GCID_MARK_DARK;

export function BrandShield({ size = 28, variant = 'brand' }: { size?: number; variant?: Variant }) {
  if (BRAND_MARK === 'gcid' && variant === 'brand') return <GcidCircle size={size} />;
  if (BRAND_MARK === 'globe' && variant === 'brand') return <GlobeMark size={size} />;
  const id = `shield-${variant}`;
  const [a, b, c] = STOPS[variant];
  return (
    <svg width={size} height={(size * 46) / 40} viewBox="0 0 40 46" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          {/* The brand stops are CSS variables with the amber as the fallback, so a relying app's own
              look (whitelabel RelyingApp.theme) can tint the mark inside its window; unset = amber, as before. */}
          <stop offset="0%" style={{ stopColor: variant === 'brand' ? `var(--shield-stop-a, ${a})` : a }} />
          <stop offset="50%" style={{ stopColor: variant === 'brand' ? `var(--shield-stop-b, ${b})` : b }} />
          <stop offset="100%" style={{ stopColor: variant === 'brand' ? `var(--shield-stop-c, ${c})` : c }} />
        </linearGradient>
      </defs>
      <path
        d="M20 1.5 3 8.2v13.4C3 32.4 11 39.8 20 44.5c9-4.7 17-12.1 17-22.9V8.2L20 1.5Z"
        fill={`url(#${id})`}
      />
      <path d="M13.5 22.5 18 27l9-9" stroke="#fff" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}
