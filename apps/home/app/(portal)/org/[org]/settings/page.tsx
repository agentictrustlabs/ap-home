'use client';
import { use } from 'react';
import { OrgSettingsSection } from '../../../../../src/components/portal/settings/org-manage';
export default function OrgSettingsPage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = use(params);
  return <OrgSettingsSection orgSa={org} />;
}
