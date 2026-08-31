'use client';
// Workspace → Discovery → Registry (spec 279): this agent's entry in the discovery knowledge base.
import { use } from 'react';
import { ServiceDiscoveryShell } from '../../../../../src/components/portal/discovery/ServiceDiscoveryShell';
import { AgentRegistryPanel } from '../../../../../src/components/portal/discovery/AgentDiscoveryPanels';

export default function ServiceRegistryPage({ params }: { params: Promise<{ agent: string }> }) {
  const { agent } = use(params);
  return <ServiceDiscoveryShell agent={agent} title="Registry">{(a, name) => <AgentRegistryPanel agent={a} name={name} />}</ServiceDiscoveryShell>;
}
