'use client';
// Treasury workspace — Overview (spec 315). One custodial money agent, selected from the header
// switcher: balance, funding, naming, host connections. Reuses the spec 275 TreasuryCard ceremonies.
import { use } from 'react';
import { useSession } from '../../../../src/context/session';
import { SectionShell } from '../../../../src/components/portal/SectionShell';
import { useManagedAgents, TreasuryCard, NameAgentForm } from '../../../../src/components/portal/ManagedAgents';
import { nameLabel } from '../../../../src/lib/domain';

const lc = (s: string) => s.toLowerCase();

export default function TreasuryWorkspacePage({ params }: { params: Promise<{ agent: string }> }) {
  const { agent } = use(params);
  const { session, agentAddress } = useSession();
  const { agents, loaded, version, reload } = useManagedAgents(session?.token ?? null);

  if (!session || !agentAddress) return <SectionShell title="Treasury"><p>Not signed in.</p></SectionShell>;

  const t = agents.find((a) => (a.kind === 'person-treasury' || a.kind === 'org-treasury') && lc(a.agent) === lc(agent));
  const parentOrg = t?.kind === 'org-treasury' ? agents.find((a) => a.kind === 'org' && lc(a.agent) === lc(t.parent)) : undefined;
  const sublabel = t?.kind === 'person-treasury' ? 'Personal treasury' : parentOrg?.name ? `${nameLabel(parentOrg.name)} treasury` : 'Org treasury';

  return (
    <SectionShell title={t?.name ? nameLabel(t.name) : 'Treasury'}>
      {!loaded ? (
        <p className="manage-card-blurb">Loading…</p>
      ) : !t ? (
        <p className="manage-card-blurb">
          You don&apos;t manage a treasury at this address. Pick one from the workspace switcher.
        </p>
      ) : (
        <div className="manage-grid">
          <TreasuryCard
            name={t.name} address={t.agent} sublabel={sublabel}
            person={agentAddress} via={session.via} token={session.token} refreshKey={version} onFunded={reload}
            nameSlot={
              <NameAgentForm agent={t.agent} kind={t.kind} parent={t.parent} person={agentAddress}
                token={session.token} via={session.via} onDone={reload} />
            }
          />
        </div>
      )}
    </SectionShell>
  );
}
