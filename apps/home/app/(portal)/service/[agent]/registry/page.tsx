'use client';
// Workspace → Discovery → Registry (spec 279): this agent's entry in the discovery knowledge base.
import { use } from 'react';
import { AgentDiscoveryShell } from '../../../../../src/components/portal/discovery/AgentDiscoveryShell';
import { AgentRegistryPanel } from '../../../../../src/components/portal/discovery/AgentDiscoveryPanels';

export default function ServiceRegistryPage({ params }: { params: Promise<{ agent: string }> }) {
  const { agent } = use(params);
  return <AgentDiscoveryShell agent={agent} cls="service" title="Registry">{(a, name) => <AgentRegistryPanel agent={a} name={name} />}</AgentDiscoveryShell>;
}
