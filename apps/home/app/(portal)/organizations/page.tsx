'use client';
// `/organizations` became `/agents` when the Home learned to charter services: a page titled
// Organizations that listed a `.svc` was lying about its own contents. Kept as a redirect because links
// to it exist in the wild (bookmarks, other apps, older docs) and a 404 teaches nothing.
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function OrganizationsMoved() {
  const router = useRouter();
  useEffect(() => { router.replace('/agents'); }, [router]);
  return null;
}
