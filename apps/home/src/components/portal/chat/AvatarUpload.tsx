'use client';

import { useRef } from 'react';
import { Avatar } from './Avatar';
import { fileToAvatarDataUrl } from '../../../lib/avatar-store';

export function AvatarUpload({
  name,
  imageUrl,
  size = 48,
  editable,
  onUpload,
  ring,
}: {
  name: string;
  imageUrl?: string | null;
  size?: number;
  editable?: boolean;
  onUpload?: (dataUrl: string) => void;
  ring?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  const pick = async (file: File) => {
    if (!onUpload) return;
    try {
      onUpload(await fileToAvatarDataUrl(file));
    } catch {
      /* invalid image */
    }
  };

  if (!editable || !onUpload) {
    return <Avatar name={name} imageUrl={imageUrl} size={size} ring={ring} />;
  }

  return (
    <div className="avatar-upload-wrap">
      <Avatar name={name} imageUrl={imageUrl} size={size} ring={ring} />
      <button
        type="button"
        className="avatar-upload-overlay"
        aria-label="Change photo"
        onClick={() => inputRef.current?.click()}
      >
        Edit
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void pick(f);
          e.target.value = '';
        }}
      />
    </div>
  );
}
