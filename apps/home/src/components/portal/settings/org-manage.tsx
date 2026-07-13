'use client';
// Org "Manage" sections (spec 315) — the former single scrolling Data page (OrgDetail), broken into
// the pieces that become left-nav items under Manage: Profile, Members, Records, Access. Each is a real
// route so the sidebar's exact-path active state works; each renders the relevant OrgDetail export over
// the person↔org delegations. One shared loader for the MyOrg record.
import { useEffect, useState } from 'react';
import { useSession } from '../../../context/session';
import { SectionShell } from '../SectionShell';
import { OrgInvitePanel } from '../OrgInvitePanel';
import { OrgApplicationsPanel } from '../OrgApplicationsPanel';
import {
  DelegationCard,
  OrgMembers,
  OrgProfileManager,
  VaultReader,
} from '../OrgDetail';
import { listMyOrgs, type MyOrg } from '../../../connect-client';

/** Load the person's MyOrg record for one org SA (the delegation record the home holds). */
function useOrgRecord(orgSa: string): { record: MyOrg | null; loaded: boolean; token: string | null } {
  const { session } = useSession();
  const [record, setRecord] = useState<MyOrg | null>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (!session?.token) return;
    let cancelled = false;
    void listMyOrgs(session.token)
      .then((all) => {
        if (cancelled) return;
        setRecord(all.find((o) => o.orgAgent.toLowerCase() === orgSa.toLowerCase()) ?? null);
        setLoaded(true);
      })
      .catch(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, [session?.token, orgSa]);
  return { record, loaded, token: session?.token ?? null };
}

const NoRecord = ({ title }: { title: string }) => (
  <SectionShell title={title}>
    <p className="manage-card-blurb">No delegation record for this organization — nothing to show.</p>
  </SectionShell>
);
const NotSignedIn = ({ title }: { title: string }) => (
  <SectionShell title={title}><p>Not signed in.</p></SectionShell>
);
const Loading = ({ title }: { title: string }) => (
  <SectionShell title={title}><p className="manage-card-blurb">Loading…</p></SectionShell>
);

// ── Profile — the org's editable details (over the stewardship delegation) ────────────────────────
export function OrgProfileSection({ orgSa }: { orgSa: string }) {
  const { session } = useSession();
  const { record, loaded } = useOrgRecord(orgSa);
  if (!session) return <NotSignedIn title="Profile" />;
  if (!loaded) return <Loading title="Profile" />;
  if (!record) return <NoRecord title="Profile" />;
  return (
    <SectionShell title="Profile">
      {record.stewardshipDelegation
        ? <OrgProfileManager delegation={record.stewardshipDelegation} />
        : <p className="manage-card-blurb">No stewardship delegation on this org — its details can&rsquo;t be edited from here.</p>}
    </SectionShell>
  );
}

// ── Members — agents that delegated to the org ────────────────────────────────────────────────────
export function OrgMembersSection({ orgSa }: { orgSa: string }) {
  const { session } = useSession();
  const { record, loaded, token } = useOrgRecord(orgSa);
  if (!session) return <NotSignedIn title="Members" />;
  if (!loaded) return <Loading title="Members" />;
  if (!record) return <NoRecord title="Members" />;
  return (
    <SectionShell title="Members">
      <OrgMembers org={record} token={token} />
      {/* spec 324 §7/§12 — ONE enrollment surface: pending join requests (steward decides) + Invite live with
          the roster (the standalone /invite page 308-redirects here; the topbar "Invite member" points here). */}
      <OrgApplicationsPanel org={orgSa} />
      <OrgInvitePanel org={orgSa} />
    </SectionShell>
  );
}

// ── Records — the org's vault data (stewardship) + your member record (membership) ────────────────
export function OrgRecordsSection({ orgSa }: { orgSa: string }) {
  const { session } = useSession();
  const { record, loaded } = useOrgRecord(orgSa);
  if (!session) return <NotSignedIn title="Records" />;
  if (!loaded) return <Loading title="Records" />;
  if (!record) return <NoRecord title="Records" />;
  return (
    <SectionShell title="Records">
      {record.stewardshipDelegation
        ? <VaultReader
            title="Organization records"
            hint="Every record in the org's vault, read with your stewardship delegation (org → you). The org owns this data; you oversee it."
            delegation={record.stewardshipDelegation}
          />
        : <p className="manage-card-blurb">No stewardship delegation — can&rsquo;t read the org&rsquo;s vault.</p>}
      {record.membershipDelegation && (
        <VaultReader
          title="Your member record (what this org can read about you)"
          hint="Read from YOUR vault using the membership delegation (you → org) — exactly what the org is entitled to see about you. It stays in your vault."
          delegation={record.membershipDelegation}
        />
      )}
    </SectionShell>
  );
}

// ── Access — the person↔org delegations that make everything above possible ───────────────────────
export function OrgAccessSection({ orgSa }: { orgSa: string }) {
  const { session } = useSession();
  const { record, loaded } = useOrgRecord(orgSa);
  if (!session) return <NotSignedIn title="Access" />;
  if (!loaded) return <Loading title="Access" />;
  if (!record) return <NoRecord title="Access" />;
  const any = record.delegation || record.membershipDelegation || record.stewardshipDelegation;
  return (
    <SectionShell title="Access">
      <p className="manage-card-blurb" style={{ margin: '0 0 .8rem' }}>
        The scoped, revocable delegations between you and this organization — the authority behind every read above.
      </p>
      {any ? (
        <div className="manage-grid">
          {record.delegation && <DelegationCard kind="App access" d={record.delegation} />}
          {record.membershipDelegation && <DelegationCard kind="Membership" d={record.membershipDelegation} />}
          {record.stewardshipDelegation && <DelegationCard kind="Stewardship" d={record.stewardshipDelegation} />}
        </div>
      ) : (
        <p className="manage-card-blurb">No delegations recorded for this organization.</p>
      )}
    </SectionShell>
  );
}
