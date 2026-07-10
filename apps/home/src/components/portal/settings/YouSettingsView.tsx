'use client';
// My Profile — the person's identity home. Personal info + Identity, STACKED (no horizontal tabs — the
// LEFT NAV is the tabs now, spec 315). Everything else that used to be a tab here moved to its own
// Manage/Activity route, losing no capability: Security → /security, Connected → /apps,
// Treasury → /treasuries, Attestations → /attestations.
import { useEffect, useMemo, useState } from 'react';
import { useSession } from '../../../context/session';
import { whitelabel } from '../../../whitelabel/config';
import { loadImpactProfile, type ImpactContactProfile } from '../../../profile-store';
import { SettingsGroup, SettingsRow } from './SettingsLayout';
import { ProfileHeader } from './ProfileHeader';
import { PersonalInfoPanel } from './PersonalInfoPanel';
import { SectionShell } from '../SectionShell';

const EXPLORER = 'https://sepolia.basescan.org/address/';

export function YouSettingsView() {
  const { agentName, agentAddress, profile } = useSession();
  const [contact, setContact] = useState<ImpactContactProfile | null>(null);

  useEffect(() => {
    if (!agentAddress) return;
    let cancelled = false;
    loadImpactProfile(agentAddress)
      .then((p) => { if (!cancelled) setContact(p.contact ?? {}); })
      .catch(() => { /* header falls back to agentName */ });
    return () => { cancelled = true; };
  }, [agentAddress]);

  const displayName = useMemo(() => {
    const first = contact?.firstName?.trim();
    const last = contact?.lastName?.trim();
    if (first || last) return [first, last].filter(Boolean).join(' ');
    return agentName ?? 'Your profile';
  }, [contact, agentName]);

  return (
    <SectionShell
      title="My Profile"
      header={
        <ProfileHeader
          name={displayName}
          handle={agentName ? `@${agentName}` : undefined}
          address={agentAddress ?? undefined}
          editable
        />
      }
    >
      <div style={{ marginTop: '0.25rem' }}>
        <PersonalInfoPanel agentAddress={agentAddress ?? null} onSaved={setContact} />
      </div>

      <div style={{ marginTop: '1.5rem' }}>
        <h3 className="subhead">Identity</h3>
        <SettingsGroup>
          <SettingsRow label="Handle" value={agentName ?? '—'} chevron={false} />
          <SettingsRow label="Smart Agent address" value={agentAddress ? `${agentAddress.slice(0, 10)}…` : '—'} chevron={false} />
          <SettingsRow label="Community" value={whitelabel.brand.community} chevron={false} />
          <SettingsRow label="Access level" value={profile?.access === 'standard' ? 'Standard' : 'Full access'} chevron={false} />
          {agentAddress && <SettingsRow label="View on explorer" value="Base Sepolia" href={EXPLORER + agentAddress} />}
        </SettingsGroup>
      </div>
    </SectionShell>
  );
}
