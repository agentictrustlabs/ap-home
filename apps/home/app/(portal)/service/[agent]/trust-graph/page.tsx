'use client';
// Workspace → Discovery → Trust graph — the same LIVE graph, centred on THIS service agent. Service-class
// agents used to be filtered out of the graph entirely, so a workspace could not appear in it at all.
import { use } from 'react';
import { useSession } from '../../../../../src/context/session';
import { SectionShell } from '../../../../../src/components/portal/SectionShell';
import { ClassExplainer, GraphCard, useLivePerson } from '../../../../../src/components/graph/TrustGraph';

const lc = (s: string) => s.toLowerCase();

export default function ServiceTrustGraphPage({ params }: { params: Promise<{ agent: string }> }) {
  const { agent } = use(params);
  const { session } = useSession();
  const { live, loaded } = useLivePerson();

  if (!session) return <SectionShell title="Trust graph"><p>Not signed in.</p></SectionShell>;
  if (!live || !loaded) return <SectionShell title="Trust graph"><p className="manage-card-blurb">Loading your relationships…</p></SectionShell>;

  const rel = live.agents.find((a) => lc(a.agent) === lc(agent));
  if (!rel) {
    return (
      <SectionShell title="Trust graph">
        <p className="manage-card-blurb">
          You don&apos;t hold a relationship with an agent at this address. Pick one from the workspace switcher.
        </p>
      </SectionShell>
    );
  }

  return (
    <SectionShell title={`${rel.name ?? 'Service'} — trust graph`}>
      <ClassExplainer />
      <GraphCard live={live} focusAgent={agent} />
      <p style={{ fontSize: '.78rem', marginTop: '.9rem', color: 'var(--color-text-faint)' }}>
        Centred on <strong>{rel.name ?? agent}</strong> — your other agents are dimmed for context. The
        edges drawn are the ones that exist today: who holds keys, and who granted authority to whom.
      </p>
    </SectionShell>
  );
}
