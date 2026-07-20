'use client';
// Org workspace — Work / New request (spec 334 §5): the goal-first composer,
// defaulting to this org as the target (a member raising work); the picker
// still allows an external principal (the org requesting coordination elsewhere).
import { use } from 'react';
import { SectionShell } from '../../../../../../src/components/portal/SectionShell';
import { NewRequestComposer } from '../../../../../../src/components/portal/work/NewRequestComposer';

export default function OrgWorkNewRequestPage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = use(params);
  return (
    <SectionShell
      title="New request"
      actions={<a href={`/org/${org.toLowerCase()}/work`} className="ghost" style={{ textDecoration: 'none', fontSize: '0.8rem' }}>← Work</a>}
    >
      <NewRequestComposer defaultTarget={org} defaultTargetName="this organization" />
    </SectionShell>
  );
}
