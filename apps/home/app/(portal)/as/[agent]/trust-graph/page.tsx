'use client';
// Workspace → Discovery → Trust graph — the same LIVE graph, centred on THIS service agent. Service-class
// agents used to be filtered out of the graph entirely, so a workspace could not appear in it at all.
import { use } from 'react';
import { useSession } from '../../../../../src/context/session';
import { SectionShell } from '../../../../../src/components/portal/SectionShell';
import { ClassExplainer, GraphCard, useLivePerson } from '../../../../../src/components/graph/TrustGraph';

import { Loading } from '../../../../../src/components/shared/Loading';
const lc = (s: string) => s.toLowerCase();

export default function PersonaTrustGraphPage({ params }: { params: Promise<{ agent: string }> }) {
  const { agent } = use(params);
  const { session } = useSession();
  const { live, loaded } = useLivePerson();

  if (!session) return <SectionShell wide title="Trust graph"><p>Not signed in.</p></SectionShell>;
  if (!live || !loaded) return <SectionShell wide title="Trust graph"><Loading label="Loading your relationships…" /></SectionShell>;

  const rel = live.agents.find((a) => lc(a.agent) === lc(agent));
  if (!rel) {
    return (
      <SectionShell wide title="Trust graph">
        <p className="manage-card-blurb">
          You don&apos;t hold a relationship with an agent at this address. Pick one from the workspace switcher.
        </p>
      </SectionShell>
    );
  }

  return (
    <SectionShell wide title={`${rel.name ?? 'Service'} — trust graph`}>
      <ClassExplainer collapsible />
      <GraphCard live={live} focusAgent={agent}  fill />
      <p style={{ fontSize: '.78rem', marginTop: '.9rem', color: 'var(--color-text-faint)' }}>
        Centred on <strong>{rel.name ?? agent}</strong> — your other agents are dimmed for context. The
        edges drawn are the ones that exist today: who holds keys, and who granted authority to whom.
      </p>
    </SectionShell>
  );
}
