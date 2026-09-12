'use client';
// MEMORY — spec 398 §6.1: three stores, never one label. The person's own view: personal facts (theirs), the workspace
// view of their own vault's Library, and what their agent's runs left behind.
import { SectionShell } from '../../../src/components/portal/SectionShell';
import { MemoryViews } from '../../../src/components/portal/MemoryViews';

export default function MemoryPage() {
  return (
    <SectionShell title="Memory">
      <p className="manage-card-blurb" style={{ marginBottom: '0.8rem' }}>
        Three stores, never one label: what your agent remembers about <b>you</b>, what a <b>workspace</b> holds as shared knowledge, and what a <b>run</b> leaves behind — each in its own vault, each with what you may do about it.
      </p>
      <MemoryViews scope={{ kind: 'person' }} />
    </SectionShell>
  );
}
