import { whitelabel } from '../../../src/whitelabel/config';
import { SectionShell } from '../../../src/components/portal/SectionShell';
import { BuildingIcon } from '../../../src/components/shared/Icons';

export default function OrganizationsPage() {
  const a = whitelabel.manageableAgents.find((x) => x.id === 'organization');
  // If a relying app can create orgs, offer it as the way to use organizations today.
  const orgApp = whitelabel.relyingApps.find((r) => r.allowed_delegation_templates.includes('org-create'));
  const cta = orgApp ? { label: `Go to ${whitelabel.brand.name} →`, href: orgApp.redirect_uris[0] } : undefined;

  return (
    <SectionShell
      title={a?.label ?? 'Organizations'}
      status={a?.status === 'live' ? 'live' : 'soon'}
      comingSoon={{
        icon: <BuildingIcon size={40} />,
        title: a?.label ?? 'Organizations',
        body: `${a?.blurb ?? 'Organizations you govern'} They'll appear here — their own agents, custodied by you.`,
        cta,
      }}
    />
  );
}
