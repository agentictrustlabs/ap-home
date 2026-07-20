'use client';
// Org Work — standalone Requests route (spec 334 §6). Thin shell over the SAME
// RequestsTriage list the Work "Requests" tab renders — one triage surface,
// two entries. Kept as a route for deep links / bookmarks.
import type { Address } from '@agenticprimitives/types';
import { useSession } from '../../../context/session';
import { SectionShell } from '../SectionShell';
import { useOrgMemberNames, useWorkList } from './useWork';
import { RequestsTriage } from './RequestsTriage';

export function OrgWorkRequestsView({ org }: { org: Address }) {
  const { session } = useSession();
  const communityId = org.toLowerCase();
  const { data, member, steward, error, refresh } = useWorkList(session, communityId);
  const names = useOrgMemberNames(session, communityId);

  if (!session) return <SectionShell title="Requests"><p>Not signed in.</p></SectionShell>;
  if (member === false) {
    return (
      <SectionShell title="Requests">
        <p style={{ fontSize: '0.85rem', opacity: 0.75 }}>Requests are visible to members of this organization.</p>
      </SectionShell>
    );
  }

  return (
    <SectionShell
      title="Requests"
      actions={<a href={`/org/${communityId}/work`} className="ghost" style={{ textDecoration: 'none', fontSize: '0.8rem' }}>← Work</a>}
    >
      {error && <p style={{ color: 'var(--color-danger)', fontSize: '0.8rem' }}>{error}</p>}
      {data === null ? (
        <p style={{ opacity: 0.6, fontSize: '0.85rem' }}>Loading…</p>
      ) : (
        <RequestsTriage org={communityId} requests={data.requests ?? []} steward={steward} names={names} refresh={refresh} />
      )}
    </SectionShell>
  );
}
