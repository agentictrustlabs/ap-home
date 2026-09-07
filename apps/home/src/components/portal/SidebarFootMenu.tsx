'use client';
// THE PERSON AT THE FOOT OF THE NAV — field-web's rail pattern, ported whole.
//
// The first cut reused the shared Popover with CSS overrides, and the menu did not open reliably at the
// foot. field-web's Rail solved the same problem with LESS machinery: an initial-avatar button, one
// piece of local state, outside-click + Escape to close, and a menu absolutely positioned from the
// trigger's own corner with explicit inline positioning — no stacking-context archaeology, no shared
// component whose assumptions were made for the topbar. "Works great" over there; same shape here.
//
// Sign out is FIRST after the name (the way out of a session is never something to scroll for), then
// the user-menu links.
import { useEffect, useRef, useState } from 'react';
import { useSession } from '../../context/session';
import { whitelabel } from '../../whitelabel/config';
import { buildUserMenu } from './nav';
import { AddressChip } from '../shared/AddressChip';

export function SidebarFootMenu() {
  const { agentName, agentAddress, personName, signOut } = useSession();
  // The profile name leads (initial + label) when given; the handle is the fallback and, when both
  // exist, the handle stays as the second line of the menu heading.
  const shown = personName ?? agentName;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const initial = (shown ?? '?').trim().charAt(0).toUpperCase() || '?';
  const item: React.CSSProperties = {
    display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer',
    padding: '.45rem .55rem', borderRadius: 8, color: 'var(--color-text-body)', fontSize: '.875rem', textDecoration: 'none',
  };

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        type="button"
        data-testid="sidebar-person"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={shown ?? 'Account'}
        onClick={() => setOpen((v) => !v)}
        style={{
          display: 'flex', alignItems: 'center', gap: '.5rem', width: '100%', background: 'none',
          border: 'none', cursor: 'pointer', padding: '.35rem .4rem', borderRadius: 10, font: 'inherit',
        }}
      >
        <span aria-hidden style={{
          width: 30, height: 30, borderRadius: '50%', background: 'var(--color-sage-700, #3f6212)', color: '#fff',
          display: 'grid', placeItems: 'center', fontWeight: 800, fontSize: 13, flexShrink: 0,
        }}>{initial}</span>
        <span style={{ fontSize: '.85rem', fontWeight: 600, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {shown ?? 'Account'}
        </span>
      </button>
      {open && (
        <div
          role="menu"
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'absolute', bottom: 'calc(100% + 6px)', left: 0, minWidth: 200, maxWidth: '92vw',
            maxHeight: 'min(60vh, 420px)', overflowY: 'auto',
            background: 'var(--color-surface, #fff)', border: '1px solid var(--color-border)', borderRadius: 11,
            boxShadow: '0 10px 30px rgb(15 26 42 / 14%)', padding: 8, zIndex: 60,
          }}
        >
          <p style={{ padding: '6px 10px 2px', margin: 0, fontWeight: 700, fontSize: '.85rem' }}>{shown ?? '—'}</p>
          {personName && agentName && <p style={{ padding: '0 10px 2px', margin: 0, fontSize: '.75rem', opacity: 0.65 }}>{agentName}</p>}
          {agentAddress && <div style={{ padding: '0 10px 6px' }}><AddressChip address={agentAddress} size="sm" /></div>}
          <div style={{ height: 1, background: 'var(--color-border)', margin: '4px 0' }} />
          <button type="button" role="menuitem" data-testid="sidebar-signout" style={{ ...item, color: 'var(--color-danger, #b3261e)' }} onClick={signOut}>
            Sign out
          </button>
          <div style={{ height: 1, background: 'var(--color-border)', margin: '4px 0' }} />
          <a role="menuitem" href="/" style={item}>View your portal</a>
          {buildUserMenu(whitelabel).map((it) => (
            <a key={it.id} role="menuitem" href={it.href} style={item}>{it.label}</a>
          ))}
          <a role="menuitem" href="/names" style={item}>Registered names</a>
        </div>
      )}
    </div>
  );
}
