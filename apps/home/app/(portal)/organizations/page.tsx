'use client';
// Organizations — the dedicated portal view of the orgs you created (spec 246 / ADR-0025).
// Same private-vault list as the /you summary; created from a community app, custodied by you.
// Selecting an org opens its detail view, which reads the org's vault (stewardship) and your
// member record (membership) live over the two person↔org delegations.
import { useState } from 'react';
import { useSession } from '../../../src/context/session';
import { whitelabel } from '../../../src/whitelabel/config';
import { SectionShell } from '../../../src/components/portal/SectionShell';
import { OrgList } from '../../../src/components/portal/OrgList';
import { OrgDetail } from '../../../src/components/portal/OrgDetail';
import type { MyOrg } from '../../../src/connect-client';

export default function OrganizationsPage() {
  const { session } = useSession();
  const [selected, setSelected] = useState<MyOrg | null>(null);
  const a = whitelabel.manageableAgents.find((x) => x.id === 'organization');
  // A relying app that can create orgs — offer it as the way to add one.
  const orgApp = whitelabel.relyingApps.find((r) => r.allowed_delegation_templates.includes('org-create'));

  return (
    <SectionShell
      title={selected ? selected.orgName || 'Organization' : a?.label ?? 'Organizations'}
      description={
        selected
          ? 'Everything your home knows about this organization, with live reads over your delegations.'
          : `${a?.blurb ?? 'Organizations you govern'} — their own Smart Agents, custodied by you.`
      }
    >
      {selected ? (
        <OrgDetail org={selected} onBack={() => setSelected(null)} />
      ) : (
        <>
          <OrgList token={session?.token ?? null} heading={false} onSelect={setSelected} />
          {orgApp && (
            <div className="dash-section" style={{ marginTop: '1.25rem' }}>
              <a className="btn-ghost onboarding-secondary" href={orgApp.redirect_uris[0]}>
                Create an organization in {whitelabel.brand.name} →
              </a>
            </div>
          )}
        </>
      )}
    </SectionShell>
  );
}
