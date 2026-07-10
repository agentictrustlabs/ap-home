'use client';

import { useEffect, useState } from 'react';
import { getAvatarByKey } from '../../../lib/avatar-store';

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
