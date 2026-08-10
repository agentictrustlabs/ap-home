'use client';
import { use, useEffect, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { OrgAccessSection } from '../../../../../src/components/portal/settings/org-manage';
import { OrgEntitlementsPanel } from '../../../../../src/components/portal/OrgEntitlementsPanel';
import { useSession } from '../../../../../src/context/session';
import { listMyOrgs, type MyOrg } from '../../../../../src/connect-client';

export default function OrgAccessPage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = use(params);
  const { session } = useSession();
  // Same MyOrg loader pattern as org-manage's useOrgRecord — the stewardship wire (org → you) is the
  // org-authority the entitlements console presents (uupg-interop port of the GC impact home's
  // MembersPanel; issue/list/revoke all ride that wire, requester = you, its delegate).
  const [record, setRecord] = useState<MyOrg | null>(null);
  useEffect(() => {
    if (!session?.token) return;
    let cancelled = false;
    void listMyOrgs(session.token, 'any')
      .then((all) => {
        if (cancelled) return;
        setRecord(all.find((o) => o.orgAgent.toLowerCase() === org.toLowerCase()) ?? null);
      })
      .catch(() => { /* the section below simply doesn't render */ });
    return () => { cancelled = true; };
  }, [session?.token, org]);

  const stewardship = record?.stewardshipDelegation ?? null;
  return (
    <>
      <OrgAccessSection orgSa={org} />
      {/* Cross-principal member entitlements — steward-only (needs the stewardship wire). */}
      {stewardship && (
        <div className="dash-section" style={{ marginTop: '1.5rem' }}>
          <h2>Member entitlements</h2>
          <p className="manage-card-blurb" style={{ margin: '0 0 0.8rem' }}>
            Scoped, revocable read grants this organization issued to OTHER Smart Agents — access by
            credential, never by custody.
          </p>
          <OrgEntitlementsPanel
            org={org as Address}
            stewardship={stewardship}
            requester={stewardship.delegate}
          />
        </div>
      )}
    </>
  );
}
