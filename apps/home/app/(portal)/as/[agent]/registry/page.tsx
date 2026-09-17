'use client';
// Workspace → Settings → Registry: this name's directory listing, driven by its agent card. A persona is
// looked up the same way anything else is — by name, through its card — which is what makes "people on the
// trail know me as Summit" a fact other systems can act on rather than a nickname.
import { use } from 'react';
import { AgentRegistryListing } from '../../../../../src/components/portal/discovery/AgentRegistryListing';

export default function PersonaRegistryPage({ params }: { params: Promise<{ agent: string }> }) {
  const { agent } = use(params);
  return <AgentRegistryListing kind="persona" agent={agent} />;
}
