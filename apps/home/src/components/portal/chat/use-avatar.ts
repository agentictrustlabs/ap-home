'use client';

import { useEffect, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { getAvatarByKey, personAvatarKey, setPersonAvatar } from '../../../lib/avatar-store';
import { saveProfilePhoto } from '../../../profile-store';

/** Reactive avatar URL for a storage key (person or community). */
export function useAvatar(key: string | null | undefined): string | null {
  const [url, setUrl] = useState<string | null>(() => (key ? getAvatarByKey(key) : null));

  useEffect(() => {
    if (!key) {
      setUrl(null);
      return;
    }
    setUrl(getAvatarByKey(key));
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent<{ key: string }>).detail;
      if (detail?.key === key) setUrl(getAvatarByKey(key));
    };
    window.addEventListener('chat-avatar-changed', onChange);
    return () => window.removeEventListener('chat-avatar-changed', onChange);
  }, [key]);

  return url;
}

// ── THE PERSON'S OWN PHOTO ──────────────────────────────────────────────────────────────────────────────────
// The vault profile holds it (`contact.photo`); the session refreshes the cached copy from the vault when it reads
// the person's profile name, and every avatar of theirs draws from that cache.

/** Your own photo (or null), as every avatar of yours shows it. */
export function useOwnPhoto(address: string | null | undefined): string | null {
  return useAvatar(address ? personAvatarKey(address) : null);
}

/** Save (or remove, with null) your own photo: the vault first, then every avatar on the page. */
export async function setOwnPhoto(address: string, photo: string | null): Promise<void> {
  await saveProfilePhoto(address.toLowerCase() as Address, photo);
  setPersonAvatar(address, photo);
}
