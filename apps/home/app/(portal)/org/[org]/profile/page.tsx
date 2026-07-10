'use client';
import { use } from 'react';
import { OrgProfileSection } from '../../../../../src/components/portal/settings/org-manage';
export default function OrgProfilePage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = use(params);
  return <OrgProfileSection orgSa={org} />;
}
