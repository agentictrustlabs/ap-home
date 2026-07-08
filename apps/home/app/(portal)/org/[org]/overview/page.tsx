'use client';
// Org workspace — Overview (spec 315). The URL carries the org SA; everything here is scoped to
// that one organization: identity, naming, and its treasury. Actions reuse the spec 275 managed-
// agent ceremonies (custodied by the connected person, gasless).
import { use } from 'react';
import type { Address } from '@agenticprimitives/types';
import { useSession } from '../../../../../src/context/session';
import { SectionShell } from '../../../../../src/components/portal/SectionShell';
import {
  useManagedAgents, NameAgentForm, CreateAgentForm, FundForm, BalanceLine,
} from '../../../../../src/components/portal/ManagedAgents';
import { AddressChip } from '../../../../../src/components/shared/AddressChip';
import { BuildingIcon, LandmarkIcon } from '../../../../../src/components/shared/Icons';
import { nameLabel } from '../../../../../src/lib/domain';

const EXPLORER = 'https://sepolia.basescan.org/address/';
const lc = (s: string) => s.toLowerCase();

export default function OrgOverviewPage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = use(params);
  const { session, agentAddress } = useSession();
  const { agents, loaded, version, reload } = useManagedAgents(session?.token ?? null);

  if (!session || !agentAddress) return <SectionShell title="Organization"><p>Not signed in.</p></SectionShell>;

  const orgAgent = agents.find((a) => a.kind === 'org' && lc(a.agent) === lc(org));
  const treasury = agents.find((a) => a.kind === 'org-treasury' && lc(a.parent) === lc(org));
  const title = orgAgent?.name ? nameLabel(orgAgent.name) : 'Organization';

  return (
    <SectionShell title={title}>
      {!loaded ? (
        <p className="manage-card-blurb">Loading…</p>
      ) : !orgAgent ? (
        <p className="manage-card-blurb">
          You don&apos;t steward an organization at this address. Pick one from the workspace switcher.
        </p>
      ) : (
        <div className="manage-grid">
          <div className="manage-card">
            <div className="manage-card-head">
              <span className="manage-card-label"><BuildingIcon size={16} /> {orgAgent.name || 'Unnamed organization'}</span>
              <span className="manage-card-badge live">Organization</span>
            </div>
            <div style={{ margin: '.45rem 0' }}><AddressChip address={orgAgent.agent as `0x${string}`} size="sm" /></div>
            <p className="manage-card-blurb">
              Its own on-chain Smart Agent, custodied by you.{' '}
              <a href={EXPLORER + orgAgent.agent} target="_blank" rel="noreferrer">explorer ↗</a>
            </p>
            {!orgAgent.name && (
              <NameAgentForm agent={orgAgent.agent} kind="org" parent={agentAddress} person={agentAddress}
                token={session.token} via={session.via} onDone={reload} />
            )}
          </div>

          <div className="manage-card">
            <div className="manage-card-head">
              <span className="manage-card-label"><LandmarkIcon size={16} /> {treasury ? (treasury.name || 'Unnamed treasury') : 'Treasury'}</span>
              <span className="manage-card-badge">{treasury ? 'Org treasury' : 'Not yet'}</span>
            </div>
            {treasury ? (
              <>
                <div style={{ margin: '.45rem 0' }}><AddressChip address={treasury.agent as `0x${string}`} size="sm" /></div>
                <p className="manage-card-blurb" style={{ display: 'flex', justifyContent: 'space-between', gap: '.5rem' }}>
                  <BalanceLine address={treasury.agent} refreshKey={version} />
                  <a href={EXPLORER + treasury.agent} target="_blank" rel="noreferrer">explorer ↗</a>
                </p>
                {!treasury.name && (
                  <NameAgentForm agent={treasury.agent} kind="org-treasury" parent={orgAgent.agent} person={agentAddress}
                    token={session.token} via={session.via} onDone={reload} />
                )}
                <FundForm treasury={treasury.agent} person={agentAddress} via={session.via} token={session.token} onDone={reload} />
              </>
            ) : (
              <>
                <p className="manage-card-blurb">This organization&apos;s money agent — holds and moves its funds, separate from its identity.</p>
                <CreateAgentForm kind="org-treasury" parent={orgAgent.agent} person={agentAddress}
                  token={session.token} via={session.via} onDone={reload} cta="Create org treasury" />
              </>
            )}
          </div>
        </div>
      )}
    </SectionShell>
  );
}
