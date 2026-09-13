// Wrapper for every portal section — THE page header (the UI system's `.ui-page-head`, 2026-09-12): the title, ONE
// line saying what the page answers (`description` — keep it to a sentence; a paragraph belongs in an empty state or
// a card, not above the fold), and the page's own actions on the right. Pages that need a rich header (a profile
// card) pass it as `header`. Every portal page goes through here so the header is the same shape everywhere.
// When status='soon' it renders the ComingSoonState instead of children (unless a `preview` node is supplied).
import type { ReactNode } from 'react';
import { ComingSoonState } from './ComingSoonState';
import { ReadyProvider, PageReadyLine, PageProgress } from '../../ui';

export function SectionShell({
  title,
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
  /** One sentence under the title — what this page answers. Longer copy is not a header. */
  description?: ReactNode;
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
    <ReadyProvider>
    <section
      className={`section-shell${wide ? ' section-shell--wide' : ''}`}
      {...(title ? { 'aria-labelledby': 'section-title' } : {})}
    >
      <PageProgress />
      {(title || actions) && (
        <header className="ui-page-head">
          <div style={{ minWidth: 0 }}>
            {title && <h1 id="section-title">{title}</h1>}
            {description && <p className="ui-page-desc">{description}</p>}
            <PageReadyLine />
          </div>
          {actions && <div className="ui-page-actions">{actions}</div>}
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
    </ReadyProvider>
  );
}
