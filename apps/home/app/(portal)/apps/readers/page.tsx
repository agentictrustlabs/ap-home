'use client';
// Connected → Who can read your records (spec 341 §4.3 / 422 §8). Per app, per kind of record: a read-only, time-bounded
// grant she signs, removable for one app without touching any other.
import { SectionShell } from '../../../../src/components/portal/SectionShell';
import { AppReadGrants } from '../../../../src/components/portal/AppReadGrants';
import { Note } from '../../../../src/ui';
import '../../../../src/components/portal/developer-apps.css';

export default function ConnectedReadersPage() {
  return (
    <SectionShell title="Who can read your records" description="Which apps may read which of your records — a yes you give per app and per kind of record, and take back the same way.">
      <Note>Letting an app read your records is a <b>separate</b> yes from signing into it. Each yes covers one app and one kind of record (your messages, or what you can do), is read-only, and expires. Removing one stops that app at every place its access is checked — not only here — and leaves every other app exactly as it was.</Note>
      <AppReadGrants />
    </SectionShell>
  );
}
