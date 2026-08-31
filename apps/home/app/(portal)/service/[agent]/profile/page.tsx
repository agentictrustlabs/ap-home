'use client';
// Settings → Identity & presence → Profile, for a service-class agent: the profile record in the
// AGENT's own vault, edited over its stewardship delegation. Same surface an organization gets — a
// profile belongs to the agent, and a workspace is one (ADR-0046).
import { use } from 'react';
import { OrgProfileSection } from '../../../../../src/components/portal/settings/org-manage';

export default function ServiceProfilePage({ params }: { params: Promise<{ agent: string }> }) {
  const { agent } = use(params);
  return <OrgProfileSection orgSa={agent} />;
}
