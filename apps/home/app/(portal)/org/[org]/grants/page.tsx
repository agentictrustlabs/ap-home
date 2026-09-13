'use client';
// Grants (spec 400 W2, B4) — every grant this organization issued; revoke here.
import { use } from 'react';
import { SectionShell } from '../../../../../src/components/portal/SectionShell';
import { GrantsPanel } from '../../../../../src/components/portal/GrantsPanel';

export default function OrgGrantsPage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = use(params);
  return (
    <SectionShell title="Grants" description="Every grant this organization has issued — members' access, apps reading its records, runtimes' standing grants — who holds each, what it permits, and whether the chain still honours it. Revoke here; it is refused everywhere after.">
      <GrantsPanel subject={org} />
    </SectionShell>
  );
}
