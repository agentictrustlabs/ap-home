'use client';
import { use } from 'react';
import { OrgAgentSection } from '../../../../../src/components/portal/settings/org-agent';

export default function OrgAgentPanelPage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = use(params);
  return <OrgAgentSection orgSa={org} only="ask" />;
}
