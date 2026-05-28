// First-class empty state for not-yet-live features — an honest, warm promise, never a
// greyed-out dead end. Always pairs the lock with a sentence explaining what WILL be here.
import type { ReactNode } from 'react';
import { LockIcon } from '../shared/Icons';

export function ComingSoonState({
  icon,
  title,
  body,
  cta,
}: {
  icon?: ReactNode;
  title: string;
  body: string;
  cta?: { label: string; href: string };
}) {
  return (
    <div className="coming-soon">
      <div className="coming-soon-icon" aria-hidden="true">{icon ?? <LockIcon size={40} />}</div>
      <div className="coming-soon-title">{title}</div>
      <p className="coming-soon-body">{body}</p>
      <span className="coming-soon-badge"><LockIcon size={13} /> Coming soon</span>
      {cta && (
        <a className="btn-ghost coming-soon-cta" href={cta.href}>
          {cta.label}
        </a>
      )}
    </div>
  );
}
