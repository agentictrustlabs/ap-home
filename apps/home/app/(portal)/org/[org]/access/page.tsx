'use client';
import { use } from 'react';
import { OrgAccessSection } from '../../../../../src/components/portal/settings/org-manage';
export default function OrgAccessPage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = use(params);
  return <OrgAccessSection orgSa={org} />;
}
