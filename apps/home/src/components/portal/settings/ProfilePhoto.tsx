'use client';
// THE PROFILE PHOTO — a picture of you, held in your own vault profile (`contact.photo`). Choosing one saves it at
// once (only the photo changes in the record); every avatar of yours on the page follows. Shown to you across this
// Home; no app receives it through a profile grant.
import { useRef, useState } from 'react';
import { Avatar } from '../chat/Avatar';
import { fileToAvatarDataUrl } from '../../../lib/avatar-store';
import { setOwnPhoto } from '../chat/use-avatar';

export function ProfilePhoto({ address, name, photo, onChange }: {
  address: string;
  name: string;
  photo: string | null;
  /** The record changed: the form keeps the same photo, so its own Save does not undo this one. */
  onChange: (photo: string | null) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<'saving' | 'removing' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const save = async (next: string | null) => {
    setBusy(next ? 'saving' : 'removing'); setError(null);
    try {
      await setOwnPhoto(address, next);
      onChange(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Your photo could not be saved. Nothing was changed.');
    } finally { setBusy(null); }
  };

  const pick = async (file: File) => {
    let url: string;
    try { url = await fileToAvatarDataUrl(file); }
    catch { setError('That file could not be read as an image. Try a JPEG or PNG.'); return; }
    await save(url);
  };

  return (
    <div className="settings-field" data-testid="profile-photo">
      <label>Photo</label>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-3, 12px)', flexWrap: 'wrap' }}>
        <Avatar name={name || '?'} imageUrl={photo} size={72} />
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className="btn" disabled={busy !== null} onClick={() => input.current?.click()}>
            {busy === 'saving' ? 'Saving…' : photo ? 'Change photo' : 'Add a photo'}
          </button>
          {photo && (
            <button type="button" className="btn ghost" disabled={busy !== null} onClick={() => void save(null)}>
              {busy === 'removing' ? 'Removing…' : 'Remove'}
            </button>
          )}
        </div>
        <input ref={input} type="file" accept="image/*" hidden data-testid="profile-photo-input"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void pick(f); e.target.value = ''; }} />
      </div>
      {error && <p role="alert" style={{ color: 'var(--color-danger)', fontSize: '0.8rem', margin: '0.4rem 0 0' }}>{error}</p>}
      <div className="settings-field__help">Shown beside your name across your Home. Saved to your encrypted vault as soon as you choose it.</div>
    </div>
  );
}
