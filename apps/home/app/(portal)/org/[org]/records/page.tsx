'use client';
import { use } from 'react';
import { OrgRecordsSection } from '../../../../../src/components/portal/settings/org-manage';
export default function OrgRecordsPage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = use(params);
  return <OrgRecordsSection orgSa={org} />;
}
