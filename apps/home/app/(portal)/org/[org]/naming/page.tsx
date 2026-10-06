'use client';
// Organization → Settings → Identity & presence → Naming (spec 348 §2.3).
// The name, then everything published under it: the name records (including the A2A endpoint, which is
// a name record and used to be set inside the card editor), the card projection that writes them, and
// the read-only account profile. Three screens before this.
import { Suspense, use, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { AgentDiscoveryShell } from '../../../../../src/components/portal/discovery/AgentDiscoveryShell';
import { AgentNamingPanel } from '../../../../../src/components/portal/discovery/AgentDiscoveryPanels';
import { AgentNamingEditor } from '../../../../../src/components/portal/discovery/AgentNamingEditor';
import { useSession } from '../../../../../src/context/session';
import { resolveVia } from '../../../../../src/home/onboarding';
import { ChangeNameCard } from '../../../../../src/components/portal/naming/ChangeNameCard';
import { TownDoneNote, TownHandoffNote, finishTownHandoff, useTownHandoff, useTownReturn } from '../../../../../src/components/portal/naming/TownHandoff';

export default function OrgNamingPage({ params }: { params: Promise<{ org: string }> }) {
  // `useSearchParams` needs a Suspense boundary for the static shell.
  return <Suspense fallback={null}><OrgNamingPageInner params={params} /></Suspense>;
}

function OrgNamingPageInner({ params }: { params: Promise<{ org: string }> }) {
  const { org } = use(params);
  // ap-town spec 430 N2 / N6c — sent here by the town's naming service: a label to claim, or a name to edit, and a way back.
  const handoff = useTownHandoff();
  const ret = useTownReturn();
  const editing = useSearchParams()?.get('name') ?? null;
  const [claimed, setClaimed] = useState<string | null>(null);
  const { session, profile } = useSession();
  const via = resolveVia(profile?.credential as string | undefined, session?.via);
  return (
    <AgentDiscoveryShell agent={org} cls="org" title="Naming">
      {(a, name, kind) => (
        <>
          {handoff && <TownHandoffNote handoff={handoff} claimed={claimed} kind={kind} />}
          {!handoff && editing && <TownDoneNote ret={ret} name={editing} />}
          <AgentNamingPanel agent={a} name={name} />
          <ChangeNameCard agent={a} kind={kind} via={via} token={session?.token ?? null} initialLabel={handoff?.label}
            onChanged={(n) => { if (n && (handoff || ret.popup)) { setClaimed(n); finishTownHandoff(ret, { name: n, agent: a, changed: !handoff }); } else window.location.reload(); }} />
          <AgentNamingEditor kind="org" agent={org} />
        </>
      )}
    </AgentDiscoveryShell>
  );
}
