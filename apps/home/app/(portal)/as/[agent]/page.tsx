'use client';
// PERSONA WORKSPACE — TODAY. Another name of the same human (a trail name, a pen name, a character in a
// game): person-CLASS, with its own card, its own vault and its own playbook, and never the one the home
// opens as. The URL carries its address, so a refresh, a deep link and the back button all stay in this name
// rather than falling back to the person — which is exactly what the switcher used to do.
//
// It is NOT "you, in something". There is no second party here and no grant between a person and themselves,
// so this page says which NAME is acting, where an organization's says on what authority.
import { use } from 'react';
import { useSession } from '../../../../src/context/session';
import { SectionShell } from '../../../../src/components/portal/SectionShell';
import { TodayView } from '../../../../src/components/portal/TodayView';
import { useManagedAgents } from '../../../../src/components/portal/ManagedAgents';
import { AddressChip } from '../../../../src/components/shared/AddressChip';
import { ExplorerLink } from '../../../../src/components/shared/ExplorerLink';
import { UserIcon } from '../../../../src/components/shared/Icons';
import { Section, Card, Empty, Meta } from '../../../../src/ui';
import { nameLabel } from '../../../../src/lib/domain';
import { agentClassOf } from '../../../../src/lib/agent-class';

import { Loading } from '../../../../src/components/shared/Loading';
const lc = (s: string) => s.toLowerCase();

export default function PersonaWorkspacePage({ params }: { params: Promise<{ agent: string }> }) {
  const { agent } = use(params);
  const { session, agentAddress, agentName } = useSession();
  // 'any' (spec 342): this page is addressed by the persona's own SA, and a lifecycle filter here would
  // 'lose' a name the person is standing inside.
  const { agents, loaded } = useManagedAgents(session?.token ?? null, 'any');

  if (!session || !agentAddress) return <SectionShell title="Person"><p>Not signed in.</p></SectionShell>;

  const who = agents.find((a) => agentClassOf(a.kind) === 'person' && lc(a.agent) === lc(agent));
  const you = agentName ? nameLabel(agentName) : 'you';
  const title = who?.name ? nameLabel(who.name) : 'Another name of yours';

  return (
    <SectionShell
      title={title}
      description={who ? <>another name of yours · custodied by the same credential as {you} · never the one your home opens as</> : undefined}
    >
      {!loaded ? (
        <Loading />
      ) : !who ? (
        <Empty>You don&apos;t have another name at this address. Pick one from the switcher.</Empty>
      ) : (
        <>
          <TodayView scope={{ kind: 'persona', agent }} />
          {/* What is true of this name, and where each of it is changed — the same grammar the org overview
              keeps: a workspace's first screen SHOWS the agent, it does not run ceremonies on it. */}
          <Section title="This name" aside={<ExplorerLink address={who.agent} label="explorer ↗" />}>
            <Card>
              <div style={{ display: 'flex', gap: 'var(--sp-3)', alignItems: 'center', flexWrap: 'wrap' }}>
                <span className="ui-card-title" style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                  <UserIcon size={16} /> {who.name || 'Unnamed person'}
                </span>
                <span className="ui-chip">person</span>
                <AddressChip address={who.agent as `0x${string}`} size="sm" />
              </div>
              <p className="ui-meta" style={{ margin: 'var(--sp-2) 0 0' }}>
                Its own vault, its own card and its own playbook. The same key signs for it — a persona is
                another name for the same human, never a claim to be somebody else — and everything it does is
                answerable to {you}.
              </p>
              {!who.name && (
                <p className="ui-meta" style={{ margin: 'var(--sp-2) 0 0' }}>
                  It has no public name yet, so nothing can look it up. <a href={`/as/${agent}/naming`}>Give it one under Naming →</a>
                </p>
              )}
            </Card>
          </Section>
        </>
      )}
    </SectionShell>
  );
}
