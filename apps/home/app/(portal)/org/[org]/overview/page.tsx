'use client';
// Org workspace — Overview (spec 315). The URL carries the org SA; everything here is scoped to
// that one organization: identity and its treasury, at a glance.
//
// It carries NO custodial ceremonies AND no treasury. It used to hold every ceremony the org has — name
// it, create its treasury, name that, fund it — so the first screen of a workspace was a stack of forms,
// each of which already existed on the page that owns it. Creating a treasury is a Stewardship decision
// made on the Treasuries page; an organization's Overview is about the ORGANIZATION.
import { use } from 'react';
import type { Address } from '@agenticprimitives/types';
import { useSession } from '../../../../../src/context/session';
import { SectionShell } from '../../../../../src/components/portal/SectionShell';
import {
  useManagedAgents,
} from '../../../../../src/components/portal/ManagedAgents';
import { AddressChip } from '../../../../../src/components/shared/AddressChip';
import { BuildingIcon, LandmarkIcon } from '../../../../../src/components/shared/Icons';
import { nameLabel } from '../../../../../src/lib/domain';
import { agentClassOf, orgKindWordOf } from '../../../../../src/lib/agent-class';

const EXPLORER = 'https://sepolia.basescan.org/address/';
const lc = (s: string) => s.toLowerCase();

export default function OrgOverviewPage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = use(params);
  const { session, agentAddress } = useSession();
  // 'any' (spec 342) — this page is addressed by the org's SA; hiding it here would 'lose' the org.
  const { agents, loaded, version, reload } = useManagedAgents(session?.token ?? null, 'any');

  if (!session || !agentAddress) return <SectionShell title="Organization"><p>Not signed in.</p></SectionShell>;

  // Class, not kind: a team IS an organization (ADR-0046) and its workspace lives here too.
  const orgAgent = agents.find((a) => agentClassOf(a.kind) === 'org' && lc(a.agent) === lc(org));
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
          {/* Overview SHOWS this organization; it does not operate on it. It used to carry every
              custodial ceremony the org has — name it, create its treasury, name that, fund it — so the
              first screen of a workspace was a form stack, and the same forms existed again on the pages
              that own them. Each card now says what is true and points at where that is done. */}
          <div className="manage-card">
            <div className="manage-card-head">
              <span className="manage-card-label"><BuildingIcon size={16} /> {orgAgent.name || 'Unnamed organization'}</span>
              <span className="manage-card-badge live" style={{ textTransform: 'capitalize' }}>{orgKindWordOf(orgAgent.kind)}</span>
            </div>
            <div style={{ margin: '.45rem 0' }}><AddressChip address={orgAgent.agent as `0x${string}`} size="sm" /></div>
            <p className="manage-card-blurb">
              Its own on-chain Smart Agent, custodied by you.{' '}
              <a href={EXPLORER + orgAgent.agent} target="_blank" rel="noreferrer">explorer ↗</a>
            </p>
            {!orgAgent.name && (
              <p className="manage-card-blurb">
                It has no public name yet, so nothing can look it up.{' '}
                <a href={`/org/${org}/naming`}>Give it one under Naming →</a>
              </p>
            )}
          </div>
        </div>
      )}
    </SectionShell>
  );
}
