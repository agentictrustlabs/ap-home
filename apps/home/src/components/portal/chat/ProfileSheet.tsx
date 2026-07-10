'use client';

import { useEffect } from 'react';
import { AvatarUpload } from './AvatarUpload';
import { personAvatarKey, setPersonAvatar } from '../../../lib/avatar-store';
import { useAvatar } from './use-avatar';

export interface ProfileTarget {
  name: string;
  label?: string;
  subject?: string;
  subtitle?: string;
  isYou?: boolean;
}

export function ProfileSheet({
  target,
  onClose,
  onMessage,
}: {
  target: ProfileTarget | null;
  onClose: () => void;
  onMessage: (t: ProfileTarget) => void;
}) {
  const avatarKey = target?.subject ? personAvatarKey(target.subject) : null;
  const imageUrl = useAvatar(avatarKey);

  useEffect(() => {
    if (!target) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [target, onClose]);

  if (!target) return null;

  return (
    <>
      <div className="chat-profile-sheet-scrim" onClick={onClose} />
      <div className="chat-profile-sheet" role="dialog" aria-label={`${target.name} profile`}>
        <AvatarUpload
          name={target.name}
          imageUrl={imageUrl}
          size={72}
          editable={!!target.isYou && !!target.subject}
          onUpload={(url) => { if (target.subject) setPersonAvatar(target.subject, url); }}
        />
        <div className="chat-profile-sheet__name">
          {target.name}{target.isYou ? ' (you)' : ''}
        </div>
        {target.label && <div className="chat-profile-sheet__label">{target.label}</div>}
        {target.subtitle && <div className="chat-profile-sheet__label">{target.subtitle}</div>}
        <div className="chat-profile-sheet__actions">
          {!target.isYou && target.label && (
            <button type="button" className="btn" onClick={() => onMessage(target)}>
              Message
            </button>
          )}
          <button type="button" className="ghost" onClick={onClose}>Close</button>
        </div>
        {!target.isYou && target.label && (
          <p className="chat-profile-sheet__hint">Tip: tap a member&apos;s avatar in the channel to message instantly.</p>
        )}
      </div>
    </>
  );
}
