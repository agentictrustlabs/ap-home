// Wrapper for every portal section — a LOW-PROFILE, consistent page header + responsive width.
// Product direction (2026-07): the header is a single compact row (title + optional right-aligned
// actions), NOT a big title + paragraph. Page `description` is intentionally NOT rendered — it ate
// above-the-fold space for little value; the `description` prop is kept for back-compat (callers
// unchanged) but ignored. Pages that need a rich header (e.g. a profile card) pass it as `header`.
// When status='soon' it renders the ComingSoonState instead of children (unless a `preview` node is supplied).
import type { ReactNode } from 'react';
import { ComingSoonState } from './ComingSoonState';

export function SectionShell({
  title,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- kept for back-compat; intentionally not rendered
  description,
  actions,
  header,
  status = 'live',
  comingSoon,
  preview,
  wide = false,
  children,
}: {
  /** The page's own heading. Omit it when the CONTENT already names itself — a chat rail headed
   *  "Direct messages" does not need a "Messages" title above it saying the same thing more faintly. */
  title?: string;
  /** DEPRECATED (not rendered) — kept so existing callers don't break. */
  description?: string;
  /** Optional right-aligned header controls (e.g. an Edit button). */
  actions?: ReactNode;
  /** Optional rich header block rendered BELOW the title row (e.g. a profile card). */
  header?: ReactNode;
  status?: 'live' | 'soon';
  /** Required when status='soon' (the honest "what will be here" copy + optional CTA). */
  comingSoon?: { icon?: ReactNode; title: string; body: string; cta?: { label: string; href: string } };
  /** Optional content to show even when status='soon' (e.g. a teaser). */
  preview?: ReactNode;
  /** DEPRECATED no-op — every section is full-width now (2026-07-20); kept so callers don't break. */
  wide?: boolean;
  children?: ReactNode;
}) {
  return (
    <section
      className={`section-shell${wide ? ' section-shell--wide' : ''}`}
      {...(title ? { 'aria-labelledby': 'section-title' } : {})}
    >
      {(title || actions) && (
        <header
          className="section-head"
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', margin: '0 0 0.9rem', minHeight: 0 }}
        >
          {title && <h1 id="section-title" style={{ fontSize: '1.2rem', fontWeight: 700, margin: 0, lineHeight: 1.2 }}>{title}</h1>}
          {actions && <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center', flex: 'none' }}>{actions}</div>}
        </header>
      )}
      {header}
      {status === 'soon' && comingSoon ? (
        <>
          {preview}
          <ComingSoonState {...comingSoon} />
        </>
      ) : (
        children
      )}
    </section>
  );
}
