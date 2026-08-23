'use client';
// Service-workspace Manage pages (ADR-0046). Same stewardship read as org Records/Access —
// the workspace (or treasury) owns the vault; you oversee it via workspace → you.
import { useSession } from '../../context/session';
import { useManagedAgents } from './ManagedAgents';
import { SectionShell } from './SectionShell';
import { DelegationCard, VaultReader } from './OrgDetail';
import { agentClassOf } from '../../lib/agent-class';
import type { DelegationWire } from '../../lib/delegation';

const lc = (s: string) => s.toLowerCase();

function useServiceAgent(agent: string) {
  const { session } = useSession();
  const { agents, loaded } = useManagedAgents(session?.token ?? null, 'any');
  const svc = agents.find((a) => agentClassOf(a.kind) === 'service' && lc(a.agent) === lc(agent));
  return { session, loaded, svc };
}

export function ServiceRecordsSection({ agent }: { agent: string }) {
  const { session, loaded, svc } = useServiceAgent(agent);
  if (!session) return <SectionShell title="Records"><p>Not signed in.</p></SectionShell>;
  if (!loaded) return <SectionShell title="Records"><p className="manage-card-blurb">Loading…</p></SectionShell>;
  if (!svc) {
    return (
      <SectionShell title="Records">
        <p className="manage-card-blurb">You don&apos;t manage a service agent at this address.</p>
      </SectionShell>
    );
  }
  const d = svc.stewardshipDelegation as DelegationWire | undefined;
  return (
    <SectionShell title="Records">
      {d ? (
        <VaultReader
          title={svc.kind === 'workspace' ? 'Workspace records' : 'Service records'}
          hint="Every record in this agent’s vault, read with your stewardship delegation (service → you). The agent owns the data; you oversee it."
          delegation={d}
        />
      ) : (
        <p className="manage-card-blurb">
          No stewardship delegation on this agent — Home cannot list its vault from here.
          {svc.kind === 'workspace'
            ? ' The roster still lives at gather27:organizations; gather27-a2a reads it over the service-agent-wire, not this portal.'
            : ''}
        </p>
      )}
    </SectionShell>
  );
}

export function ServiceAccessSection({ agent }: { agent: string }) {
  const { session, loaded, svc } = useServiceAgent(agent);
  if (!session) return <SectionShell title="Access"><p>Not signed in.</p></SectionShell>;
  if (!loaded) return <SectionShell title="Access"><p className="manage-card-blurb">Loading…</p></SectionShell>;
  if (!svc) {
    return (
      <SectionShell title="Access">
        <p className="manage-card-blurb">You don&apos;t manage a service agent at this address.</p>
      </SectionShell>
    );
  }
  const d = svc.stewardshipDelegation as DelegationWire | undefined;
  return (
    <SectionShell title="Access">
      <p className="manage-card-blurb" style={{ margin: '0 0 .8rem' }}>
        The scoped, revocable delegations between you and this service agent — the authority behind Records.
      </p>
      {d ? (
        <div className="manage-grid">
          <DelegationCard kind="Stewardship" d={d} />
        </div>
      ) : (
        <p className="manage-card-blurb">
          No stewardship recorded on this Home link.
          {svc.kind === 'workspace'
            ? ' The service-agent-wire (workspace → gather27-a2a) is held by the Worker, not this portal — authorize it from Gather ops.'
            : ''}
        </p>
      )}
    </SectionShell>
  );
}
