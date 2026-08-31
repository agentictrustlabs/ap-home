'use client';
// Organization → Discovery → Capabilities (spec 282; ADR-0051 — "capability" is the canonical noun).
import { use } from 'react';
import { AgentDiscoveryShell } from '../../../../../src/components/portal/discovery/AgentDiscoveryShell';
import { AgentCapabilitiesPanel } from '../../../../../src/components/portal/discovery/AgentDiscoveryPanels';

export default function OrgCapabilitiesPage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = use(params);
  return <AgentDiscoveryShell agent={org} cls="org" title="Capabilities">{(a, name) => <AgentCapabilitiesPanel agent={a} name={name} />}</AgentDiscoveryShell>;
}
