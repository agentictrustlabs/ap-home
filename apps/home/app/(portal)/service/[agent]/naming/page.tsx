'use client';
// Workspace → Settings → Identity & presence → Naming (spec 348 §2.3). Same page an organization gets —
// a name belongs to the agent, and a workspace is one (ADR-0046).
import { use } from 'react';
import { AgentDiscoveryShell } from '../../../../../src/components/portal/discovery/AgentDiscoveryShell';
import { AgentNamingPanel } from '../../../../../src/components/portal/discovery/AgentDiscoveryPanels';
import { AgentNamingEditor } from '../../../../../src/components/portal/discovery/AgentNamingEditor';

export default function ServiceNamingPage({ params }: { params: Promise<{ agent: string }> }) {
  const { agent } = use(params);
  return (
    <AgentDiscoveryShell agent={agent} cls="service" title="Naming">
      {(a, name) => (
        <>
          <AgentNamingPanel agent={a} name={name} />
          <AgentNamingEditor kind="service" agent={agent} />
        </>
      )}
    </AgentDiscoveryShell>
  );
}
