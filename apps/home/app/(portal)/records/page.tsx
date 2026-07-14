'use client';
// Personal vault-records page (spec 315 Manage) — the person's own analog of the org Records page
// (`app/(portal)/org/[org]/records`). Reads the person's OWN self-readable capability records.
import { SectionShell } from '../../../src/components/portal/SectionShell';
import { PersonVaultReader } from '../../../src/components/portal/PersonVaultReader';

export default function RecordsPage() {
  return (
    <SectionShell title="Records">
      <PersonVaultReader />
    </SectionShell>
  );
}
