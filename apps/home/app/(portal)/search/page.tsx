'use client';
// Search (spec 400 W2, B5) — one box over the person's own work.
import { SectionShell } from '../../../src/components/portal/SectionShell';
import { SearchPanel } from '../../../src/components/portal/SearchPanel';

export default function SearchPage() {
  return (
    <SectionShell
      title="Search"
      description="Find where something was said or done — “auth refresh from six months ago” — across your messages, your runs, and the topics of the organizations you steward. Answered from your own records; every result says where it lives."
    >
      <SearchPanel />
    </SectionShell>
  );
}
