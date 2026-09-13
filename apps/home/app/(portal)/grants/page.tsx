'use client';
// Grants (spec 400 W2, B4) — every grant you have issued; revoke here.
import { SectionShell } from '../../../src/components/portal/SectionShell';
import { GrantsPanel } from '../../../src/components/portal/GrantsPanel';

export default function GrantsPage() {
  return (
    <SectionShell title="Grants" description="Every grant you have issued — apps reading your records (Claude and other connections among them), your contacts, a coach, a runtime you custody — who holds each, what it permits, and whether the chain still honours it. Revoke here; it is refused everywhere after.">
      <GrantsPanel />
    </SectionShell>
  );
}
