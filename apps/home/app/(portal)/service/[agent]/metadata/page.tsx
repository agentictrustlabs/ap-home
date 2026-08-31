'use client';
// Workspace → Manage → Metadata. Tiers live in src/components/portal/discovery/AgentMetadataTiers.tsx
// (shared with the organization's Metadata page — the tiers belong to being a Smart Agent, not a class).
import { use } from 'react';
import { AgentDiscoveryShell } from '../../../../../src/components/portal/discovery/AgentDiscoveryShell';
import { AgentMetadataTiers } from '../../../../../src/components/portal/discovery/AgentMetadataTiers';

export default function ServiceMetadataPage({ params }: { params: Promise<{ agent: string }> }) {
  const { agent } = use(params);
  return (
    <AgentDiscoveryShell agent={agent} cls="service" title="Metadata">
      {(a, name) => <AgentMetadataTiers agent={a} name={name} cls="service" />}
    </AgentDiscoveryShell>
  );
}
