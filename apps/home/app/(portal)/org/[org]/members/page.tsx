'use client';
import { use } from 'react';
import { OrgMembersSection } from '../../../../../src/components/portal/settings/org-manage';
export default function OrgMembersPage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = use(params);
  return <OrgMembersSection orgSa={org} />;
}
