'use client';
// Whether to show the Admin row in the user menu (2026-10-09). The server decides — `/connect/admin/me` reads
// HOME_ADMINS — and the Admin routes refuse a non-admin regardless; this only saves everyone else a dead link.
// Remembered per session token for the tab's life, so opening the menu twice asks once.
import { useEffect, useState } from 'react';
import { useSession } from '../context/session';

const answers = new Map<string, boolean>();

export function useIsAdmin(): boolean {
  const { session } = useSession();
  const token = session?.token ?? '';
  const [admin, setAdmin] = useState<boolean>(() => answers.get(token) ?? false);
  useEffect(() => {
    if (!token) { setAdmin(false); return; }
    const known = answers.get(token);
    if (known !== undefined) { setAdmin(known); return; }
    let live = true;
    fetch('/connect/admin/me', { headers: { authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : { admin: false }))
      .then((j: { admin?: boolean }) => { answers.set(token, !!j.admin); if (live) setAdmin(!!j.admin); })
      .catch(() => undefined);
    return () => { live = false; };
  }, [token]);
  return admin;
}
