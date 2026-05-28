'use client';
// Topbar identity chip → popover (name, address, view portal, sign out).
import { useEffect, useRef, useState } from 'react';
import { useSession } from '../../context/session';
import { AddressChip } from '../shared/AddressChip';
import { ChevronDownIcon } from '../shared/Icons';

export function IdentityChip() {
  const { agentName, agentAddress, signOut } = useSession();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  return (
    <div className="identity-chip-wrap" ref={ref}>
      <button type="button" className="identity-chip" aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen((v) => !v)}>
        <span className="identity-chip-name">{agentName ?? 'Your portal'}</span>
        <ChevronDownIcon size={16} />
      </button>
      {open && (
        <div className="identity-popover" role="menu">
          <div className="identity-popover-name">{agentName ?? '—'}</div>
          {agentAddress && <AddressChip address={agentAddress} size="sm" />}
          <div className="identity-popover-divider" />
          <a className="identity-popover-item" href="/" role="menuitem">View your portal</a>
          <button type="button" className="identity-popover-item danger" role="menuitem" onClick={signOut}>
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
