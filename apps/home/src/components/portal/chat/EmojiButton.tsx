'use client';
// A lightweight emoji picker — a 😊 button that opens a grid popover. Client-only, zero deps: emoji are
// just Unicode, so picking one appends to the composer and it renders everywhere with no backend. Stays
// open across picks (Telegram behavior); closes on outside-click / Escape.
import { useEffect, useRef, useState } from 'react';

// A curated, broadly-useful set (kept small so the picker is instant — a full set can come later).
const EMOJI = [
  '😀', '😄', '😁', '😅', '😂', '🙂', '😉', '😊',
  '😍', '😘', '😎', '🤝', '🤔', '😐', '🙄', '😴',
  '🤯', '😳', '🥳', '😅', '😢', '😭', '😡', '🥺',
  '👍', '👎', '👌', '🙏', '👏', '🙌', '💪', '👀',
  '🔥', '✨', '⭐', '🎉', '❤️', '🧡', '💛', '💚',
  '💙', '💜', '✅', '❌', '⚠️', '💡', '📌', '🚀',
  '💰', '📈', '📉', '🗓️', '⏰', '🎯', '📎', '💬',
];

export function EmojiButton({ onPick }: { onPick: (emoji: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);

  return (
    <div ref={ref} style={{ position: 'relative', flex: 'none' }}>
      <button
        type="button"
        title="Emoji"
        aria-label="Insert emoji"
        onClick={() => setOpen((v) => !v)}
        style={{
          border: 'none', background: 'transparent', cursor: 'pointer', fontSize: '1.25rem',
          lineHeight: 1, padding: '0.2rem 0.35rem', opacity: open ? 1 : 0.7, borderRadius: 8, minHeight: 0,
        }}
      >
        😊
      </button>
      {open && (
        <div
          role="menu"
          style={{
            position: 'absolute', bottom: 'calc(100% + 8px)', right: 0, zIndex: 70, width: 272,
            background: '#fff', border: '1px solid #e5e7eb', borderRadius: 14,
            boxShadow: '0 12px 34px rgba(0,0,0,.16)', padding: '0.5rem',
            display: 'grid', gridTemplateColumns: 'repeat(8, 1fr)', gap: 2,
          }}
        >
          {EMOJI.map((e, i) => (
            <button
              key={`${e}-${i}`}
              type="button"
              onClick={() => onPick(e)}
              style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: '1.25rem', padding: '0.2rem', borderRadius: 8, minHeight: 0 }}
              onMouseEnter={(ev) => (ev.currentTarget.style.background = '#f1f5f9')}
              onMouseLeave={(ev) => (ev.currentTarget.style.background = 'transparent')}
            >
              {e}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
