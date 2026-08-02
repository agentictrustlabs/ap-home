'use client';
// Manage → Visibility (spec 338 §20, W6) — who can find this agent, the invitations issued, and the
// recipient-side check. See src/components/portal/visibility/VisibilityTab.tsx.
import { SectionShell } from '../../../src/components/portal/SectionShell';
import { VisibilityTab } from '../../../src/components/portal/visibility/VisibilityTab';

export default function VisibilityPage() {
  return (
    <SectionShell title="Visibility">
      <VisibilityTab />
    </SectionShell>
  );
}
