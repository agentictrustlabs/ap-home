'use client';
// The org "Data" scroll-page was split into Manage sections (Profile/Members/Records/Access, spec 315).
import { use, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { orgHref } from '../../../../../src/lib/workspace';
export default function OrgDataRedirect({ params }: { params: Promise<{ org: string }> }) {
  const { org } = use(params);
  const router = useRouter();
  useEffect(() => { router.replace(orgHref(org, 'profile')); }, [org, router]);
  return null;
}
