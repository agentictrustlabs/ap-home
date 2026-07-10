'use client';
// Attestations — community-wide statements you signed once at your home (spec 315 Activity band).
// Moved out of the old /you Attestations tab; no capability lost.
import { SectionShell } from '../../../src/components/portal/SectionShell';
import { SettingsGroup, SettingsRow } from '../../../src/components/portal/settings/SettingsLayout';

export default function AttestationsPage() {
  return (
    <SectionShell title="Attestations">
      <p style={{ fontSize: '.85rem', opacity: 0.75, margin: '0 0 .8rem' }}>
        Statements you signed once at your home — shared with aligned apps, never re-signed per app.
      </p>
      <SettingsGroup>
        <SettingsRow
          icon="📜"
          label="WEA Statement of Faith"
          value="Sign once — shared with faith-aligned apps"
          href="/wea-sign"
        />
      </SettingsGroup>
    </SectionShell>
  );
}
