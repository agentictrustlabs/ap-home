'use client';
// Settings → Registry, for the person's own agent. This route used to be the whole knowledge base — every
// named agent with a Register button beside it — which is an operator's roster, not a settings page.
// Browsing every agent is the Discovery app's job.
import { AgentRegistryListing } from '../../../src/components/portal/discovery/AgentRegistryListing';

export default function RegistryPage() {
  return <AgentRegistryListing kind="person" agent="" />;
}
