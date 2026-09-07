'use client';
// Settings → Household (spec 363 W4). A projection of the same capability model the Ask uses — no
// invoker of its own, no separate vocabulary, no UI-only concept.
import { SectionShell } from '../../../src/components/portal/SectionShell';
import { HouseholdPanel } from '../../../src/components/portal/HouseholdPanel';

export default function HouseholdPage() {
  return (
    <SectionShell
      title="Household"
      description="The people you live with, as you record them. Held in your own vault, published nowhere, and it grants nobody any authority."
    >
      <HouseholdPanel />
    </SectionShell>
  );
}
