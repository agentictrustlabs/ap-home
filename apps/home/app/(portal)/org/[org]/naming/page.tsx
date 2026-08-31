'use client';
// Organization → Settings → Identity & presence → Naming (spec 348 §2.3).
// The name, then everything published under it: the name records (including the A2A endpoint, which is
// a name record and used to be set inside the card editor), the card projection that writes them, and
// the read-only account profile. Three screens before this.
import { use } from 'react';
import { AgentDiscoveryShell } from '../../../../../src/components/portal/discovery/AgentDiscoveryShell';
import { AgentNamingPanel } from '../../../../../src/components/portal/discovery/AgentDiscoveryPanels';
import { AgentNamingEditor } from '../../../../../src/components/portal/discovery/AgentNamingEditor';

export default function OrgNamingPage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = use(params);
  return (
    <AgentDiscoveryShell agent={org} cls="org" title="Naming">
      {(a, name) => (
        <>
          <AgentNamingPanel agent={a} name={name} />
          <AgentNamingEditor kind="org" agent={org} />
        </>
      )}
    </AgentDiscoveryShell>
  );
}
