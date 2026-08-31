'use client';
// Workspace → Discovery → Naming (spec 280): what this agent is called and whether the name resolves to it.
import { use } from 'react';
import { ServiceDiscoveryShell } from '../../../../../src/components/portal/discovery/ServiceDiscoveryShell';
import { AgentNamingPanel } from '../../../../../src/components/portal/discovery/AgentDiscoveryPanels';

export default function ServiceNamingPage({ params }: { params: Promise<{ agent: string }> }) {
  const { agent } = use(params);
  return <ServiceDiscoveryShell agent={agent} title="Naming">{(a, name) => <AgentNamingPanel agent={a} name={name} />}</ServiceDiscoveryShell>;
}
