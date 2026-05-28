// Wrapper for every portal section: a heading + optional description + responsive width.
// When status='soon' it renders the ComingSoonState instead of children (unless a
// `preview` node is supplied). Generic — copy comes from the route page (props in).
import type { ReactNode } from 'react';
import { ComingSoonState } from './ComingSoonState';

export function SectionShell({
  title,
  description,
  status = 'live',
  comingSoon,
  preview,
  children,
}: {
  title: string;
  description?: string;
  status?: 'live' | 'soon';
  /** Required when status='soon' (the honest "what will be here" copy + optional CTA). */
  comingSoon?: { icon?: ReactNode; title: string; body: string; cta?: { label: string; href: string } };
  /** Optional content to show even when status='soon' (e.g. a teaser). */
  preview?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section className="section-shell" aria-labelledby="section-title">
      <header className="section-head">
        <h1 id="section-title">{title}</h1>
        {description && <p className="section-desc">{description}</p>}
      </header>
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
