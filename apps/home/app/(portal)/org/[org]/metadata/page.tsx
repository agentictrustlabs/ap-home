'use client';
// Organization → Manage → Metadata. Tiers live in src/components/portal/discovery/AgentMetadataTiers.tsx
// (shared with the workspace's Metadata page — the tiers belong to being a Smart Agent, not a class).
import { use } from 'react';
import { AgentDiscoveryShell } from '../../../../../src/components/portal/discovery/AgentDiscoveryShell';
import { AgentMetadataTiers } from '../../../../../src/components/portal/discovery/AgentMetadataTiers';

export default function OrgMetadataPage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = use(params);
  return (
    <AgentDiscoveryShell agent={org} cls="org" title="Metadata">
      {(a, name) => <AgentMetadataTiers agent={a} name={name} cls="org" />}
    </AgentDiscoveryShell>
  );
}
