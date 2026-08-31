'use client';
// Workspace → Discovery → Capabilities (spec 282; ADR-0051 — "capability" is the canonical noun, and a
// NEW route carries no legacy `skills` key).
import { use } from 'react';
import { ServiceDiscoveryShell } from '../../../../../src/components/portal/discovery/ServiceDiscoveryShell';
import { AgentCapabilitiesPanel } from '../../../../../src/components/portal/discovery/AgentDiscoveryPanels';

export default function ServiceCapabilitiesPage({ params }: { params: Promise<{ agent: string }> }) {
  const { agent } = use(params);
  return <ServiceDiscoveryShell agent={agent} title="Capabilities">{(a, name) => <AgentCapabilitiesPanel agent={a} name={name} />}</ServiceDiscoveryShell>;
}
