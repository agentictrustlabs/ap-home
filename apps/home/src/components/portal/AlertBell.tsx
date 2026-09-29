'use client';
// THE BELL (gap register B6a) — what is waiting on me, on every page: a count in the top bar and, opened, the list — each
// row linking to where it is done. Signatures, decisions and answers are Today's own; invitations are the ones her inbox
// holds that she has not accepted. It shows; it authorizes nothing.
import { useEffect, useRef, useState } from 'react';
import { useSession } from '../../context/session';
import { useWaitingOnMe } from '../../home/use-waiting-on-me';
import { WAITING_LABEL } from '../../home/waiting-on-me';
import { BellIcon } from '../shared/Icons';

export function AlertBell() {
  const { session, agentAddress } = useSession();
  const { items, refresh } = useWaitingOnMe(session, agentAddress);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  if (!session || !agentAddress) return null;
  const count = items?.length ?? 0;
  return (
    <div className="alert-bell" ref={ref}>
      <button
        type="button" className={`alert-bell__btn${open ? ' on' : ''}`} data-testid="alert-bell"
        aria-label={count ? `${count} waiting on you` : 'Nothing waiting on you'} aria-expanded={open} title="Waiting on you"
        onClick={() => { setOpen((o) => !o); if (!open) refresh(); }}
      >
        <BellIcon size={16} />
        {count > 0 && <span className="alert-bell__count" data-testid="alert-count">{count > 9 ? '9+' : count}</span>}
      </button>
      {open && (
        <div className="alert-bell__panel" role="dialog" aria-label="Waiting on you" data-testid="alert-list">
          <div className="alert-bell__head">Waiting on you</div>
          {items === null && <div className="alert-bell__empty">Reading…</div>}
          {items !== null && items.length === 0 && <div className="alert-bell__empty">Nothing is waiting on you.</div>}
          {items?.map((it) => (
            <a key={it.id} className="alert-bell__row" href={it.href} data-testid="alert-item" data-kind={it.kind} onClick={() => setOpen(false)}>
              <span className="alert-bell__kind">{WAITING_LABEL[it.kind]}</span>
              <span className="alert-bell__title">{it.title}</span>
              {it.detail && <span className="alert-bell__detail">{it.detail}</span>}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
