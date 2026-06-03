'use client';
// Organizations — the dedicated portal view of the orgs you created (spec 246 / ADR-0025).
// Same private-vault list as the /you summary; created from a community app, custodied by you.
import { useSession } from '../../../src/context/session';
import { whitelabel } from '../../../src/whitelabel/config';
import { SectionShell } from '../../../src/components/portal/SectionShell';
import { OrgList } from '../../../src/components/portal/OrgList';

export default function OrganizationsPage() {
  const { session } = useSession();
  const a = whitelabel.manageableAgents.find((x) => x.id === 'organization');
  // A relying app that can create orgs — offer it as the way to add one.
  const orgApp = whitelabel.relyingApps.find((r) => r.allowed_delegation_templates.includes('org-create'));

  return (
    <SectionShell
      title={a?.label ?? 'Organizations'}
      description={`${a?.blurb ?? 'Organizations you govern'} — their own Smart Agents, custodied by you.`}
    >
      <OrgList token={session?.token ?? null} heading={false} />
      {orgApp && (
        <div className="dash-section" style={{ marginTop: '1.25rem' }}>
          <a className="btn-ghost onboarding-secondary" href={orgApp.redirect_uris[0]}>
            Create an organization in {whitelabel.brand.name} →
          </a>
        </div>
      )}
    </SectionShell>
  );
}
