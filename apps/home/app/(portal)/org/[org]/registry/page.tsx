'use client';
// Organization → Discovery → Registry (spec 279): this org's entry in the discovery knowledge base.
import { use } from 'react';
import { AgentDiscoveryShell } from '../../../../../src/components/portal/discovery/AgentDiscoveryShell';
import { AgentRegistryPanel } from '../../../../../src/components/portal/discovery/AgentDiscoveryPanels';

export default function OrgRegistryPage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = use(params);
  return <AgentDiscoveryShell agent={org} cls="org" title="Registry">{(a, name) => <AgentRegistryPanel agent={a} name={name} />}</AgentDiscoveryShell>;
}
