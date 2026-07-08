'use client';
// Org workspace — Data (spec 315). Live vault reads for THIS org over the person↔org
// delegations (stewardship + membership), reusing the spec 246/275 OrgDetail view.
import { use, useEffect, useState } from 'react';
import { useSession } from '../../../../../src/context/session';
import { SectionShell } from '../../../../../src/components/portal/SectionShell';
import { OrgDetail } from '../../../../../src/components/portal/OrgDetail';
import { listMyOrgs, type MyOrg } from '../../../../../src/connect-client';
import { nameLabel } from '../../../../../src/lib/domain';

export default function OrgDataPage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = use(params);
  const { session } = useSession();
  const [record, setRecord] = useState<MyOrg | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!session?.token) return;
    let cancelled = false;
    void listMyOrgs(session.token)
      .then((all) => {
        if (cancelled) return;
        setRecord(all.find((o) => o.orgAgent.toLowerCase() === org.toLowerCase()) ?? null);
        setLoaded(true);
      })
      .catch(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, [session?.token, org]);

  if (!session) return <SectionShell title="Organization data"><p>Not signed in.</p></SectionShell>;

  return (
    <SectionShell title={record?.orgName ? `${nameLabel(record.orgName)} — data` : 'Organization data'}>
      {!loaded ? (
        <p className="manage-card-blurb">Loading…</p>
      ) : !record ? (
        <p className="manage-card-blurb">No delegation record for this organization — nothing to read.</p>
      ) : (
        <OrgDetail org={record} token={session.token} onBack={() => window.history.back()} />
      )}
    </SectionShell>
  );
}
