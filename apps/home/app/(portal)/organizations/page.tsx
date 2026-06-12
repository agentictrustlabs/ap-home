'use client';
// Organizations — the dedicated portal view of the orgs you control (spec 246 / ADR-0025 + spec 275).
// Create an organization and add its treasury here (in-home, gasless, custodied by you); selecting an
// org opens its detail view, which reads the org's vault (stewardship) + your member record (membership)
// live over the two person↔org delegations.
import { useEffect, useState } from 'react';
import { useSession } from '../../../src/context/session';
import { whitelabel } from '../../../src/whitelabel/config';
import { SectionShell } from '../../../src/components/portal/SectionShell';
import { OrganizationsManager } from '../../../src/components/portal/ManagedAgents';
import { OrgDetail } from '../../../src/components/portal/OrgDetail';
import { listMyOrgs, type MyOrg } from '../../../src/connect-client';

export default function OrganizationsPage() {
  const { session, agentAddress } = useSession();
  const [orgs, setOrgs] = useState<MyOrg[]>([]);
  const [selected, setSelected] = useState<MyOrg | null>(null);

  // Resolve full MyOrg records (with the stewardship delegation OrgDetail reads over) so a row's
  // "view data →" can open the vault view. Same /connect/related-orgs source as the manager list.
  useEffect(() => {
    if (!session?.token) return;
    let cancelled = false;
    void listMyOrgs(session.token).then((o) => { if (!cancelled) setOrgs(o); }).catch(() => {});
    return () => { cancelled = true; };
  }, [session?.token]);

  const a = whitelabel.manageableAgents.find((x) => x.id === 'organization');
  return (
    <SectionShell
      title={selected ? selected.orgName || 'Organization' : a?.label ?? 'Organizations'}
      description={
        selected
          ? 'Everything your home knows about this organization, with live reads over your delegations.'
          : `${a?.blurb ?? 'Organizations you govern'} — their own Smart Agents, custodied by you. Create one and add its treasury, all from your home.`
      }
    >
      {selected ? (
        <OrgDetail org={selected} token={session?.token ?? null} onBack={() => setSelected(null)} />
      ) : (
        <OrganizationsManager
          token={session?.token ?? null}
          person={agentAddress ?? null}
          via={session?.via ?? ''}
          onSelect={(orgAgent) => {
            const m = orgs.find((o) => o.orgAgent.toLowerCase() === orgAgent.toLowerCase());
            if (m) setSelected(m);
          }}
        />
      )}
    </SectionShell>
  );
}
