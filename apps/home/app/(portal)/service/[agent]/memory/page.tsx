'use client';
// A service agent's memory (spec 398 §6.1): its vault's knowledge and what its runs left behind.
import { use } from 'react';
import { SectionShell } from '../../../../../src/components/portal/SectionShell';
import { MemoryViews } from '../../../../../src/components/portal/MemoryViews';

export default function ServiceMemoryPage({ params }: { params: Promise<{ agent: string }> }) {
  const { agent } = use(params);
  return (
    <SectionShell title="Memory">
      <MemoryViews scope={{ kind: 'service', agent }} />
    </SectionShell>
  );
}
