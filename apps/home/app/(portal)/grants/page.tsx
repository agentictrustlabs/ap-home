'use client';
// Grants (spec 400 W2, B4) — every grant you have issued; revoke here.
import { SectionShell } from '../../../src/components/portal/SectionShell';
import { GrantsPanel } from '../../../src/components/portal/GrantsPanel';
import { DelegationsList } from '../../../src/components/portal/DelegationsList';
import { useSession } from '../../../src/context/session';

export default function GrantsPage() {
  const { session } = useSession();
  return (
    <SectionShell title="Grants" description="Every grant you have issued — apps reading your records (Claude and other connections among them), your contacts, a coach, a runtime you custody — who holds each, what it permits, and whether the chain still honours it. Revoke here; it is refused everywhere after.">
      <GrantsPanel />
      {/* spec 422 §6.1 (W1 move; W4 folds these into the list above): the site / membership / stewardship grants
          the person issued to organizations and apps, each revocable — they used to sit on /security. */}
      <DelegationsList token={session?.token ?? null} />
    </SectionShell>
  );
}
