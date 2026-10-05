'use client';
// Workspace → Settings → Identity & presence → Naming (spec 348 §2.3). Same page an organization gets —
// a name belongs to the agent, and a workspace is one (ADR-0046).
import { Suspense, use, useState } from 'react';
import { AgentDiscoveryShell } from '../../../../../src/components/portal/discovery/AgentDiscoveryShell';
import { AgentNamingPanel } from '../../../../../src/components/portal/discovery/AgentDiscoveryPanels';
import { AgentNamingEditor } from '../../../../../src/components/portal/discovery/AgentNamingEditor';
import { useSession } from '../../../../../src/context/session';
import { resolveVia } from '../../../../../src/home/onboarding';
import { ChangeNameCard } from '../../../../../src/components/portal/naming/ChangeNameCard';
import { TownHandoffNote, useTownHandoff } from '../../../../../src/components/portal/naming/TownHandoff';

export default function PersonaNamingPage({ params }: { params: Promise<{ agent: string }> }) {
  return <Suspense fallback={null}><PersonaNamingInner params={params} /></Suspense>;
}

function PersonaNamingInner({ params }: { params: Promise<{ agent: string }> }) {
  const { agent } = use(params);
  const { session, profile } = useSession();
  const via = resolveVia(profile?.credential as string | undefined, session?.via);
  // ap-town spec 430 N2 — sent here by the town's naming service with a label to claim and a way back.
  const handoff = useTownHandoff();
  const [claimed, setClaimed] = useState<string | null>(null);
  return (
    <AgentDiscoveryShell agent={agent} cls="service" title="Naming">
      {(a, name, kind) => (
        <>
          {handoff && <TownHandoffNote handoff={handoff} claimed={claimed} />}
          <AgentNamingPanel agent={a} name={name} />
          <ChangeNameCard agent={a} kind={kind} via={via} token={session?.token ?? null} initialLabel={handoff?.label}
            onChanged={(n) => { if (n && handoff) setClaimed(n); else window.location.reload(); }} />
          <AgentNamingEditor kind="persona" agent={agent} />
        </>
      )}
    </AgentDiscoveryShell>
  );
}
