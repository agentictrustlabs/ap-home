'use client';
// Telegram's tap-member-in-group flow: click a member/poster's avatar or name → a small profile card
// pops up anchored to the click, with "Send message" that opens the 1:1 (the caller routes to the
// person's own /messages — the correct workspace scope for person↔person, spec 315). This is the
// refined channel→DM path that replaces jumping through the workspace dropdown.
import { useEffect } from 'react';
import { Avatar } from './Avatar';

export interface ProfileTarget {
  name: string;
  /** Agent handle/label (e.g. `sarah.impact`). */
  label?: string;
  /** Secondary line — the shared org, role, etc. */
  subtitle?: string;
  imageUrl?: string | null;
  isYou?: boolean;
  /** Anchor point (viewport coords of the clicked element). */
  x: number;
  y: number;
}

const CARD_W = 232;

export function ProfilePopover({
  target,
  onClose,
  onMessage,
}: {
  target: ProfileTarget | null;
  onClose: () => void;
  onMessage: (t: ProfileTarget) => void;
}) {
  useEffect(() => {
    if (!target) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [target, onClose]);

  if (!target) return null;
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1200;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
  const left = Math.max(8, Math.min(target.x, vw - CARD_W - 8));
  const top = Math.min(target.y + 10, vh - 210);

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 80 }} />
      <div
        role="dialog"
        style={{
          position: 'fixed', left, top, zIndex: 81, width: CARD_W,
          background: '#fff', border: '1px solid #e5e7eb', borderRadius: 16,
          boxShadow: '0 16px 40px rgba(0,0,0,.18)', padding: '1rem 0.9rem 0.9rem',
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.35rem',
        }}
      >
        <Avatar name={target.name} imageUrl={target.imageUrl} size={60} />
        <div style={{ fontWeight: 700, fontSize: '0.98rem', textAlign: 'center', marginTop: '0.2rem' }}>
          {target.name}{target.isYou ? ' (you)' : ''}
        </div>
        {target.label && <div style={{ fontSize: '0.76rem', opacity: 0.6 }}>{target.label}</div>}
        {target.subtitle && <div style={{ fontSize: '0.74rem', opacity: 0.55, textAlign: 'center' }}>{target.subtitle}</div>}
        {!target.isYou && (
          <button
            className="btn"
            style={{ width: '100%', marginTop: '0.5rem' }}
            onClick={() => onMessage(target)}
          >
            💬 Send message
          </button>
        )}
      </div>
    </>
  );
}
