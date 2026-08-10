'use client';
// Org workspace — Treasury (spec 315). The one treasury belonging to this org: balance, funding,
// naming, host connections. Reuses the spec 275 TreasuryCard ceremonies.
import { use } from 'react';
import { useSession } from '../../../../../src/context/session';
import { SectionShell } from '../../../../../src/components/portal/SectionShell';
import {
  useManagedAgents, TreasuryCard, CreateAgentForm, NameAgentForm,
} from '../../../../../src/components/portal/ManagedAgents';
import { nameLabel } from '../../../../../src/lib/domain';

const lc = (s: string) => s.toLowerCase();

export default function OrgTreasuryPage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = use(params);
  const { session, agentAddress } = useSession();
  // 'any' (spec 342) — addressed by the org's SA; see the overview page.
  const { agents, loaded, version, reload } = useManagedAgents(session?.token ?? null, 'any');

  if (!session || !agentAddress) return <SectionShell title="Treasury"><p>Not signed in.</p></SectionShell>;

  const orgAgent = agents.find((a) => a.kind === 'org' && lc(a.agent) === lc(org));
  const treasury = agents.find((a) => a.kind === 'org-treasury' && lc(a.parent) === lc(org));

  return (
    <SectionShell title={orgAgent?.name ? `${nameLabel(orgAgent.name)} — treasury` : 'Treasury'}>
      {!loaded ? (
        <p className="manage-card-blurb">Loading…</p>
      ) : treasury ? (
        <div className="manage-grid">
          <TreasuryCard
            name={treasury.name} address={treasury.agent} sublabel="Org treasury"
            person={agentAddress} via={session.via} token={session.token} refreshKey={version} onFunded={reload}
            nameSlot={
              <NameAgentForm agent={treasury.agent} kind="org-treasury" parent={org} person={agentAddress}
                token={session.token} via={session.via} onDone={reload} />
            }
          />
        </div>
      ) : orgAgent ? (
        <div className="manage-grid">
          <div className="manage-card">
            <div className="manage-card-head">
              <span className="manage-card-label">Treasury</span>
              <span className="manage-card-badge">Not yet</span>
            </div>
            <p className="manage-card-blurb">Create this organization&apos;s money agent.</p>
            <CreateAgentForm kind="org-treasury" parent={orgAgent.agent} person={agentAddress}
              token={session.token} via={session.via} onDone={reload} cta="Create org treasury" />
          </div>
        </div>
      ) : (
        <p className="manage-card-blurb">You don&apos;t steward an organization at this address.</p>
      )}
    </SectionShell>
  );
}
