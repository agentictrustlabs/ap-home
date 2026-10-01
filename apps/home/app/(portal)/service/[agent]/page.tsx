'use client';
// Service workspace — TODAY (spec 398 §4.2 over spec 315's Overview / ADR-0046): what this service agent has
// parked, what it is doing, what it left, what next — then its role panel. One custodial SERVICE-class agent,
// selected from the header switcher. Role-agnostic shell: the treasury role renders the
// spec 275 TreasuryCard (balance, funding, naming, host connections); future service roles
// add their own panel here without new nav categories.
import { use } from 'react';
import { useSession } from '../../../../src/context/session';
import { SectionShell } from '../../../../src/components/portal/SectionShell';
import { TodayView } from '../../../../src/components/portal/TodayView';
import { useManagedAgents, TreasuryCard, NameAgentForm } from '../../../../src/components/portal/ManagedAgents';
import { AddressChip } from '../../../../src/components/shared/AddressChip';
import { agentClassOf, serviceRoleOf, authorityLineage } from '../../../../src/lib/agent-class';
import { nameLabel } from '../../../../src/lib/domain';

import { Loading } from '../../../../src/components/shared/Loading';
const lc = (s: string) => s.toLowerCase();

export default function ServiceWorkspacePage({ params }: { params: Promise<{ agent: string }> }) {
  const { agent } = use(params);
  const { session, agentAddress, agentName } = useSession();
  // 'any' (spec 342) — a service is addressed by its own SA, and the default filter would also drop
  // it whenever its parent org is deactivated.
  const { agents, loaded, version, reload } = useManagedAgents(session?.token ?? null, 'any');

  if (!session || !agentAddress) return <SectionShell title="Service"><p>Not signed in.</p></SectionShell>;

  const svc = agents.find((a) => agentClassOf(a.kind) === 'service' && lc(a.agent) === lc(agent));
  const role = svc ? serviceRoleOf(svc.kind) : null;
  const you = agentName ? nameLabel(agentName) : 'you';
  const lineage = svc
    ? [...authorityLineage(svc, agents, you, agentAddress).map((n) => (n === you || n === 'unnamed' ? n : nameLabel(n))), role].join(' → ')
    : '';
  const parentOrg = svc?.kind === 'org-treasury' ? agents.find((a) => agentClassOf(a.kind) === 'org' && lc(a.agent) === lc(svc.parent)) : undefined;
  const sublabel = svc?.kind === 'person-treasury' ? 'Personal treasury' : parentOrg?.name ? `${nameLabel(parentOrg.name)} treasury` : 'Org treasury';

  return (
    <SectionShell title={svc?.name ? nameLabel(svc.name) : 'Service'}>
      {!loaded ? (
        <Loading />
      ) : !svc ? (
        <p className="manage-card-blurb">
          You don&apos;t manage a service agent at this address. Pick one from the workspace switcher.
        </p>
      ) : (
        <>
          <TodayView scope={{ kind: 'service', agent }} />
          <p className="manage-card-blurb" style={{ marginBottom: '.8rem' }}>
            Service agent · role: <b>{role}</b> · authority: <code style={{ fontSize: '.82rem' }}>{lineage}</code>
          </p>
          {role === 'treasury' ? (
            <div className="manage-grid">
              <TreasuryCard
                name={svc.name} address={svc.agent} sublabel={sublabel}
                person={agentAddress} via={session.via} token={session.token} refreshKey={version} onFunded={reload}
                // Naming happens under Naming — an Overview says what is true, it does not run ceremonies.
                nameSlot={
                  <a className="manage-card-blurb" href={`/service/${svc.agent}/naming`}>Give it a name under Naming →</a>
                }
              />
            </div>
          ) : (
            <div className="manage-card">
              <div className="manage-card-head">
                <span className="manage-card-label">{svc.name || 'Unnamed service'}</span>
                <span className="manage-card-badge live">{role}</span>
              </div>
              <div style={{ margin: '.45rem 0' }}><AddressChip address={svc.agent as `0x${string}`} size="sm" /></div>
              <p className="manage-card-blurb">
                You steward it — your key signs for it.
                {role === 'workspace'
                  ? ' The member-organization roster lives in this agent’s vault — open Records to read it.'
                  : ' Role-specific actions land here as this service role gets its panel.'}
              </p>
            </div>
          )}
        </>
      )}
    </SectionShell>
  );
}
