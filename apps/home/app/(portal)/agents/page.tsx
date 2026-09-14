'use client';
// Agents — every agent you steward, grouped by CLASS (ADR-0046: an organization, a team, a circle and a
// church are all org-class; a workspace, a registry, a treasury and a plain `.svc` service are all
// service-class). Charter a new one of any kind whose typed root this chain has provisioned, and add an
// organization's treasury here — in-home, gasless, custodied by you. Selecting an organization opens its
// detail view, which reads the org's vault (stewardship) + your member record (membership) live over the
// two person↔org delegations (spec 246 / ADR-0025 + spec 275).
//
// This page was `/organizations`, and the name stopped being true the moment the Home could charter a
// service: the header said Organizations while the list held a `.svc`. The route moved with the meaning.
import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useSession } from '../../../src/context/session';
import { whitelabel } from '../../../src/whitelabel/config';
import { SectionShell } from '../../../src/components/portal/SectionShell';
import { OrganizationsManager } from '../../../src/components/portal/ManagedAgents';
import { OrgDetail } from '../../../src/components/portal/OrgDetail';
import { listMyOrgs, type MyOrg } from '../../../src/connect-client';

export default function OrganizationsPage() {
  const { session, agentAddress } = useSession();
  // agent-vocabulary.md D2 — the nav names the two KINDS (Organizations · Services); this one page serves both, filtered.
  const kindParam = useSearchParams()?.get('kind');
  const kind: 'all' | 'org' | 'service' = kindParam === 'org' || kindParam === 'service' ? kindParam : 'all';
  const [orgs, setOrgs] = useState<MyOrg[]>([]);
  const [selected, setSelected] = useState<MyOrg | null>(null);

  // Resolve full MyOrg records (with the stewardship delegation OrgDetail reads over) so a row's
  // "view data →" can open the vault view. Same /connect/related-orgs source as the manager list.
  useEffect(() => {
    if (!session?.token) return;
    let cancelled = false;
    // 'roster' (spec 342): the organizations page lists deactivated orgs too, so selecting one
    // must still resolve its full record.
    void listMyOrgs(session.token, 'roster').then((o) => { if (!cancelled) setOrgs(o); }).catch(() => {});
    return () => { cancelled = true; };
  }, [session?.token]);

  const a = whitelabel.manageableAgents.find((x) => x.id === 'organization');
  return (
    <SectionShell
      title={selected ? selected.orgName || 'Organization' : kind === 'org' ? 'Organizations you steward' : kind === 'service' ? 'Services you steward' : 'What you steward'}
      description={
        selected
          ? 'Everything your home knows about this organization, with live reads over your delegations.'
          : kind === 'org'
            ? 'Organizations, teams, workspaces, households, churches and circles you steward — each with its members and roster, named by the suffix that says which kind of body it is.'
            : kind === 'service'
              ? 'Services you steward — runtimes, treasuries, registries, coaches: software that acts for something, each with a role, named .svc / .treasury / .registry.'
              : 'The organizations and services you steward — you oversee them and can act for them; your key signs.'
      }
    >
      {selected ? (
        <OrgDetail org={selected} token={session?.token ?? null} onBack={() => setSelected(null)} />
      ) : (
        <OrganizationsManager
          key={kind}
          initialFilter={kind}
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
