'use client';
// Organization → Settings → Registry: this org's directory listing, driven by its agent card.
import { use } from 'react';
import { AgentRegistryListing } from '../../../../../src/components/portal/discovery/AgentRegistryListing';

export default function OrgRegistryPage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = use(params);
  return <AgentRegistryListing kind="org" agent={org} />;
}
