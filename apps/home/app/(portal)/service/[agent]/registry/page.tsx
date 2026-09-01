'use client';
// Workspace → Settings → Registry: this agent's directory listing, driven by its agent card.
import { use } from 'react';
import { AgentRegistryListing } from '../../../../../src/components/portal/discovery/AgentRegistryListing';

export default function ServiceRegistryPage({ params }: { params: Promise<{ agent: string }> }) {
  const { agent } = use(params);
  return <AgentRegistryListing kind="service" agent={agent} />;
}
