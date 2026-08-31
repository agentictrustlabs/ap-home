'use client';
// Organization → Discovery → Naming (spec 280): what this org is called and whether the name resolves to it.
import { use } from 'react';
import { AgentDiscoveryShell } from '../../../../../src/components/portal/discovery/AgentDiscoveryShell';
import { AgentNamingPanel } from '../../../../../src/components/portal/discovery/AgentDiscoveryPanels';

export default function OrgNamingPage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = use(params);
  return <AgentDiscoveryShell agent={org} cls="org" title="Naming">{(a, name) => <AgentNamingPanel agent={a} name={name} />}</AgentDiscoveryShell>;
}
