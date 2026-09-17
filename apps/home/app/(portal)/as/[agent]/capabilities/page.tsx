'use client';
// Workspace → Discovery → Capabilities (spec 282; ADR-0051 — "capability" is the canonical noun, and a
// NEW route carries no legacy `skills` key).
import { use } from 'react';
import { AgentDiscoveryShell } from '../../../../../src/components/portal/discovery/AgentDiscoveryShell';
import { AgentCapabilitiesPanel } from '../../../../../src/components/portal/discovery/AgentDiscoveryPanels';

export default function PersonaCapabilitiesPage({ params }: { params: Promise<{ agent: string }> }) {
  const { agent } = use(params);
  return <AgentDiscoveryShell agent={agent} cls="service" title="Capabilities">{(a, name) => <AgentCapabilitiesPanel agent={a} name={name} />}</AgentDiscoveryShell>;
}
