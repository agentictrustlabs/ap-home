'use client';
// Settings → Identity & presence → Profile (spec 348 §2.3) — the person's own profile, VAULT DATA ONLY.
//
// The identity rows that used to sit under this heading (handle, Smart Agent address, community, access
// level) have moved to the user menu's "Your profile": they are not vault data, they are not editable
// here, and the handle is owned by Naming. Keeping them under "Profile" taught that identity is profile
// data, which is the confusion ADR-0010 exists to prevent.
import { useSession } from '../../../src/context/session';
import { SectionShell } from '../../../src/components/portal/SectionShell';
import { PersonalInfoPanel } from '../../../src/components/portal/settings/PersonalInfoPanel';

export default function ProfilePage() {
  const { agentAddress } = useSession();
  return (
    <SectionShell
      title="Profile"
      description="Who you are, held in your own vault. Private by default — shared only through a delegation you issue."
    >
      <PersonalInfoPanel agentAddress={agentAddress ?? null} />
    </SectionShell>
  );
}
