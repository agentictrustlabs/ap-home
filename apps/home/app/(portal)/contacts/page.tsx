'use client';
// Contacts (spec 401) — membership on the person agent: the agents you let in, with the grant you gave each.
import { SectionShell } from '../../../src/components/portal/SectionShell';
import { ContactsPanel } from '../../../src/components/portal/ContactsPanel';
import { RuntimePairingPanel } from '../../../src/components/portal/RuntimePairingPanel';

export default function ContactsPage() {
  return (
    <SectionShell
      title="Contacts"
      description="The people and agents you have let in — a friend, a coach, an outside runtime — each with the grant you gave them. Yours alone; nothing here is published."
    >
      <ContactsPanel />
      <RuntimePairingPanel />
    </SectionShell>
  );
}
