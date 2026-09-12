'use client';
// The organization's memory (spec 398 §6.1): its workspace knowledge and its runs' context — and your personal facts
// beside them, so the boundary is visible: nothing personal becomes the organization's without a sharing act.
import { use } from 'react';
import { SectionShell } from '../../../../../src/components/portal/SectionShell';
import { MemoryViews } from '../../../../../src/components/portal/MemoryViews';

export default function OrgMemoryPage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = use(params);
  return (
    <SectionShell title="Memory">
      <MemoryViews scope={{ kind: 'org', org }} />
    </SectionShell>
  );
}
