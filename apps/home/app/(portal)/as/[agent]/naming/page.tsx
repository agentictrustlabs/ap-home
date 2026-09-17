'use client';
// Workspace → Settings → Identity & presence → Naming (spec 348 §2.3). Same page an organization gets —
// a name belongs to the agent, and a workspace is one (ADR-0046).
import { use } from 'react';
import { AgentDiscoveryShell } from '../../../../../src/components/portal/discovery/AgentDiscoveryShell';
import { AgentNamingPanel } from '../../../../../src/components/portal/discovery/AgentDiscoveryPanels';
import { AgentNamingEditor } from '../../../../../src/components/portal/discovery/AgentNamingEditor';
import { useSession } from '../../../../../src/context/session';
import { resolveVia } from '../../../../../src/home/onboarding';
import { ChangeNameCard } from '../../../../../src/components/portal/naming/ChangeNameCard';

export default function PersonaNamingPage({ params }: { params: Promise<{ agent: string }> }) {
  const { agent } = use(params);
  const { session, profile } = useSession();
  const via = resolveVia(profile?.credential as string | undefined, session?.via);
  return (
    <AgentDiscoveryShell agent={agent} cls="service" title="Naming">
      {(a, name, kind) => (
        <>
          <AgentNamingPanel agent={a} name={name} />
          <ChangeNameCard agent={a} kind={kind} via={via} token={session?.token ?? null} onChanged={() => window.location.reload()} />
          <AgentNamingEditor kind="persona" agent={agent} />
        </>
      )}
    </AgentDiscoveryShell>
  );
}
