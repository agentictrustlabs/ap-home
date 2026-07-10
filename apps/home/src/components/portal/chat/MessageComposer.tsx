'use client';

import { useRef, useState } from 'react';
import { EmojiButton } from './EmojiButton';
import { fileToMessageDataUrl } from '../../../lib/avatar-store';
import { buildMessageBody } from './message-content';

export function MessageComposer({
  value,
  onChange,
  onSend,
  disabled,
  busy,
  placeholder = 'Message…',
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: (body: string) => void | Promise<void>;
  disabled?: boolean;
  busy?: boolean;
  placeholder?: string;
}) {
  const [pendingImage, setPendingImage] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const canSend = !disabled && !busy && (value.trim().length > 0 || pendingImage);

  const send = () => {
    if (!canSend) return;
    const body = buildMessageBody(value, pendingImage);
    void Promise.resolve(onSend(body)).then(() => {
      onChange('');
      setPendingImage(null);
    });
  };

  const attach = async (file: File) => {
    try {
      setPendingImage(await fileToMessageDataUrl(file));
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="chat-composer-bar">
      <div className="chat-composer">
        <button
          type="button"
          className="chat-composer__attach"
          title="Attach image"
          disabled={disabled}
          onClick={() => fileRef.current?.click()}
        >
          📎
        </button>
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void attach(f);
          e.target.value = '';
        }} />
        <textarea
          rows={1}
          value={value}
          disabled={disabled}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <EmojiButton onPick={(em) => onChange(value + em)} disabled={disabled} />
      </div>
      {pendingImage && (
        <div style={{ position: 'absolute', bottom: 72, left: 16, display: 'flex', alignItems: 'center', gap: 8, background: '#fff', border: '1px solid var(--color-border)', borderRadius: 12, padding: 6 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={pendingImage} alt="" style={{ width: 56, height: 56, objectFit: 'cover', borderRadius: 8 }} />
          <button type="button" className="ghost" style={{ minHeight: 0, padding: '0.2rem 0.5rem' }} onClick={() => setPendingImage(null)}>Remove</button>
        </div>
      )}
      <button type="button" className="chat-send-btn" disabled={!canSend} onClick={send} title="Send">
        {busy ? '…' : '➤'}
      </button>
    </div>
  );
}
