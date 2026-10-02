'use client';
// Org workspace — TODAY (spec 398 §4.2 over spec 315's Overview). The URL carries the org SA; everything here is
// scoped to that one organization: what needs a decision there, what is active, what it left, what next — then
// its identity.
//
// It carries NO custodial ceremonies AND no treasury. It used to hold every ceremony the org has — name
// it, create its treasury, name that, fund it — so the first screen of a workspace was a stack of forms,
// each of which already existed on the page that owns it. Creating a treasury is a Stewardship decision
// made on the Treasuries page; an organization's Overview is about the ORGANIZATION.
import { use } from 'react';
import { ExplorerLink } from '../../../../../src/components/shared/ExplorerLink';
import type { Address } from '@agenticprimitives/types';
import { useSession } from '../../../../../src/context/session';
import { SectionShell } from '../../../../../src/components/portal/SectionShell';
import { TodayView } from '../../../../../src/components/portal/TodayView';
import {
  useManagedAgents,
} from '../../../../../src/components/portal/ManagedAgents';
import { AddressChip } from '../../../../../src/components/shared/AddressChip';
import { BuildingIcon } from '../../../../../src/components/shared/Icons';
import { Section, Card, Empty, Meta, SkeletonRows } from '../../../../../src/ui';
import { nameLabel } from '../../../../../src/lib/domain';
import { agentClassOf, orgKindWordOf } from '../../../../../src/lib/agent-class';

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

  // STRUCTURE FIRST (owner, 2026-10-02 — the Today treatment): Today is scoped to the org SA in the URL and reads
  // nothing from the managed-agent tree, so it renders and self-skeletons immediately. Only the identity card and the
  // "not yours" message depend on the tree read — skeleton the card while it is out, and show the empty note only
  // once the tree has LOADED and confirmed you do not steward this address (never a spinner over the whole page).
  return (
    <SectionShell title={title} description={orgAgent ? <>{orgKindWordOf(orgAgent.kind)} · {orgAgent.name || 'unnamed'} · you steward it</> : undefined}>
      {loaded && !orgAgent ? (
        <Empty>You don&apos;t steward an organization at this address. Pick one from the workspace switcher.</Empty>
      ) : (
        <>
        <TodayView scope={{ kind: 'org', org }} />
        {/* Overview SHOWS this organization; it does not operate on it — each fact says where it is changed. */}
        <Section title="This organization" aside={orgAgent ? <ExplorerLink address={orgAgent.agent} label="explorer ↗" /> : undefined}>
          {!loaded || !orgAgent ? (
            <Card><SkeletonRows rows={1} lead /></Card>
          ) : (
          <Card>
            <div style={{ display: 'flex', gap: 'var(--sp-3)', alignItems: 'center', flexWrap: 'wrap' }}>
              <span className="ui-card-title" style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}><BuildingIcon size={16} /> {orgAgent.name || 'Unnamed organization'}</span>
              <span className="ui-chip" style={{ textTransform: 'capitalize' }}>{orgKindWordOf(orgAgent.kind)}</span>
              <AddressChip address={orgAgent.agent as `0x${string}`} size="sm" />
            </div>
            {!orgAgent.name && <p className="ui-meta" style={{ margin: 'var(--sp-2) 0 0' }}>It has no public name yet, so nothing can look it up. <a href={`/org/${org}/naming`}>Give it one under Naming →</a></p>}
          </Card>
          )}
        </Section>
        </>
      )}
    </SectionShell>
  );
}
