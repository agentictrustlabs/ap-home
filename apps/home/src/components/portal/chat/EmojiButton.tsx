'use client';

import { useEffect, useRef, useState } from 'react';

const EMOJI = [
  '😀', '😄', '😁', '😅', '😂', '🙂', '😉', '😊',
  '😍', '😘', '😎', '🤝', '🤔', '😐', '🙄', '😴',
  '🤯', '😳', '🥳', '😅', '😢', '😭', '😡', '🥺',
  '👍', '👎', '👌', '🙏', '👏', '🙌', '💪', '👀',
  '🔥', '✨', '⭐', '🎉', '❤️', '🧡', '💛', '💚',
  '💙', '💜', '✅', '❌', '⚠️', '💡', '📌', '🚀',
  '💰', '📈', '📉', '🗓️', '⏰', '🎯', '📎', '💬',
];

export function EmojiButton({ onPick, disabled }: { onPick: (emoji: string) => void; disabled?: boolean }) {
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
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        style={{
          border: 'none', background: 'transparent', cursor: disabled ? 'not-allowed' : 'pointer',
          fontSize: '1.25rem', lineHeight: 1, padding: '0.2rem 0.35rem', opacity: open ? 1 : 0.7,
          borderRadius: 8, minHeight: 0,
        }}
      >
        😊
      </button>
      {open && (
        <div role="menu" className="chat-emoji-popover">
          {EMOJI.map((e, i) => (
            <button key={`${e}-${i}`} type="button" className="chat-emoji-btn" onClick={() => onPick(e)}>
              {e}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
