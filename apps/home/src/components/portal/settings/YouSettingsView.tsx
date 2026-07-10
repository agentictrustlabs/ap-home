'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSession } from '../../../context/session';
import { whitelabel } from '../../../whitelabel/config';
import {
  loadImpactProfile,
  type ImpactContactProfile,
} from '../../../profile-store';
import { PersonalTreasurySection } from '../ManagedAgents';
import { DelegationsList } from '../DelegationsList';
import { HomeManifestCard } from '../HomeManifestCard';
import { DirectoryListingCard } from '../DirectoryListingCard';
import { continueWithGoogle } from '../../../home/onboarding';
import { rotateGoogleHome } from '../../../server-client';
import { SettingsLayout, SettingsGroup, SettingsRow } from './SettingsLayout';
import { ProfileHeader } from './ProfileHeader';
import { PersonalInfoPanel } from './PersonalInfoPanel';
import { SectionShell } from '../SectionShell';

const EXPLORER = 'https://sepolia.basescan.org/address/';

// No "Overview" tab: the left rail IS the overview — the first click lands on real
// content (personal info), never on a second list of links (nav-pointing-at-nav).
const TABS = [
  { id: 'personal', label: 'Personal info', group: 'My profile' },
  { id: 'identity', label: 'Identity', group: 'My profile' },
  { id: 'security', label: 'Security', group: 'Account' },
  { id: 'connected', label: 'Connected', group: 'Account' },
  { id: 'treasury', label: 'Treasury', group: 'Account' },
  { id: 'attestations', label: 'Attestations', group: 'Account' },
] as const;

type TabId = (typeof TABS)[number]['id'];

const TAB_META: Record<TabId, { title: string; description: string }> = {
  personal: {
    title: 'Personal info',
    description: 'Contact details sealed in your encrypted vault and re-used across community apps.',
  },
  identity: {
    title: 'Identity',
    description: 'Your permanent Smart Agent identity — how others find and trust you on-chain.',
  },
  security: {
    title: 'Security & access',
    description: 'Delegations you granted, vault encryption, and how you sign in.',
  },
  connected: {
    title: 'Connected services',
    description: 'Directory listings and your published home manifest for other agents.',
  },
  treasury: {
    title: 'Personal treasury',
    description: 'Your funds agent — separate from identity, custodied by you.',
  },
  attestations: {
    title: 'Attestations',
    description: 'Community-wide statements you signed once at your home.',
  },
};

function parseTab(): TabId {
  if (typeof window === 'undefined') return 'personal';
  const t = new URLSearchParams(window.location.search).get('tab');
  return (TABS.find((x) => x.id === t)?.id ?? 'personal') as TabId;
}

export function YouSettingsView() {
  const { session, agentName, agentAddress, profile } = useSession();
  const [tab, setTab] = useState<TabId>('personal');
  const [contact, setContact] = useState<ImpactContactProfile | null>(null);

  useEffect(() => {
    setTab(parseTab());
  }, []);

  const selectTab = useCallback((id: string) => {
    const next = id as TabId;
    setTab(next);
    const url = new URL(window.location.href);
    if (next === 'personal') url.searchParams.delete('tab');
    else url.searchParams.set('tab', next);
    window.history.replaceState({}, '', url.pathname + url.search);
  }, []);

  // Load the vault name once for the header (PersonalInfoPanel owns the editing state).
  useEffect(() => {
    if (!agentAddress) return;
    let cancelled = false;
    loadImpactProfile(agentAddress)
      .then((p) => { if (!cancelled) setContact(p.contact ?? {}); })
      .catch(() => { /* header falls back to agentName; the panel shows the vault banner */ });
  }, [agentAddress]);

  const displayName = useMemo(() => {
    const first = contact?.firstName?.trim();
    const last = contact?.lastName?.trim();
    if (first || last) return [first, last].filter(Boolean).join(' ');
    return agentName ?? 'Your profile';
  }, [contact, agentName]);

  const meta = TAB_META[tab];

  // Same page scaffold as every other portal page (SectionShell h1 + description),
  // with the settings hub as the page's single content block — no orphaned card.
  return (
    <SectionShell
      title="My Profile"
      description="Who you are here — your contact details, identity, security, and what you've connected."
    >
    <SettingsLayout
      tabs={[...TABS]}
      active={tab}
      onSelect={selectTab}
      title={meta.title}
      description={meta.description}
      header={
        <ProfileHeader
          name={displayName}
          handle={agentName ? `@${agentName}` : undefined}
          address={agentAddress ?? undefined}
          editable
        />
      }
    >
      {tab === 'personal' && (
        <PersonalInfoPanel
          agentAddress={agentAddress ?? null}
          onSaved={setContact}
        />
      )}

      {tab === 'identity' && (
        <SettingsGroup>
          <SettingsRow label="Handle" value={agentName ?? '—'} chevron={false} />
          <SettingsRow label="Smart Agent address" value={agentAddress ? `${agentAddress.slice(0, 10)}…` : '—'} chevron={false} />
          <SettingsRow label="Community" value={whitelabel.brand.community} chevron={false} />
          <SettingsRow label="Access level" value={profile?.access === 'standard' ? 'Standard' : 'Full access'} chevron={false} />
          {agentAddress && (
            <SettingsRow label="View on explorer" value="Base Sepolia" href={EXPLORER + agentAddress} />
          )}
        </SettingsGroup>
      )}

      {tab === 'security' && (
        <>
          <SettingsGroup label="Vault">
            <SettingsRow icon="🔒" label="Vault key" value="Encrypt profile & message storage" href="/vault-key" />
            <SettingsRow icon="🛡️" label="Devices & credentials" value="Passkeys, wallet, security" href="/security" />
          </SettingsGroup>
          <GoogleSignInPanel />
          <div style={{ marginTop: '1rem' }}>
            <DelegationsList token={session?.token ?? null} />
          </div>
        </>
      )}

      {tab === 'connected' && (
        <>
          <HomeManifestCard />
          <div style={{ marginTop: '1rem' }}>
            <DirectoryListingCard />
          </div>
        </>
      )}

      {tab === 'treasury' && (
        <PersonalTreasurySection token={session?.token ?? null} person={agentAddress ?? null} via={session?.via ?? ''} />
      )}

      {tab === 'attestations' && (
        <SettingsGroup>
          <SettingsRow
            icon="📜"
            label="WEA Statement of Faith"
            value="Sign once — shared with faith-aligned apps"
            href="/wea-sign"
          />
        </SettingsGroup>
      )}
    </SettingsLayout>
    </SectionShell>
  );
}

function GoogleSignInPanel() {
  const { session } = useSession();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  if (session?.via !== 'Google') return null;

  async function newHome() {
    if (!session) return;
    setBusy(true);
    setErr('');
    try {
      await rotateGoogleHome(session.token);
      continueWithGoogle();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'could not start a new home');
      setBusy(false);
    }
  }

  return (
    <SettingsGroup label="Sign-in">
      <div className="settings-banner settings-banner--warn" style={{ margin: '0.75rem 1rem 0.5rem', borderRadius: 8 }}>
        <div>
          <strong>Google sign-in</strong>
          <p style={{ margin: '0.3rem 0 0.5rem', fontSize: '0.8rem' }}>
            This home opens with Google. Add a passkey on Security to reduce reliance on Google alone.
          </p>
          <button type="button" className="btn-ghost" disabled={busy} onClick={() => void newHome()}>
            {busy ? 'Starting…' : 'Use Google for a new home'}
          </button>
          {err && <p style={{ color: 'var(--color-danger)', fontSize: '0.78rem', margin: '0.35rem 0 0' }}>{err}</p>}
        </div>
      </div>
    </SettingsGroup>
  );
}
