'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSession } from '../../../context/session';
import { whitelabel } from '../../../whitelabel/config';
import {
  loadImpactProfile,
  VaultKeyUnauthorizedError,
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

const EXPLORER = 'https://sepolia.basescan.org/address/';

const TABS = [
  { id: 'overview', label: 'Overview', group: 'My profile' },
  { id: 'personal', label: 'Personal info', group: 'My profile' },
  { id: 'identity', label: 'Identity', group: 'My profile' },
  { id: 'security', label: 'Security', group: 'Account' },
  { id: 'connected', label: 'Connected', group: 'Account' },
  { id: 'treasury', label: 'Treasury', group: 'Account' },
  { id: 'attestations', label: 'Attestations', group: 'Account' },
] as const;

type TabId = (typeof TABS)[number]['id'];

const TAB_META: Record<TabId, { title: string; description: string }> = {
  overview: {
    title: 'Overview',
    description: 'Your profile at a glance — tap any row to manage that area.',
  },
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
  if (typeof window === 'undefined') return 'overview';
  const t = new URLSearchParams(window.location.search).get('tab');
  return (TABS.find((x) => x.id === t)?.id ?? 'overview') as TabId;
}

export function YouSettingsView() {
  const { session, agentName, agentAddress, profile } = useSession();
  const [tab, setTab] = useState<TabId>('overview');
  const [contact, setContact] = useState<ImpactContactProfile | null>(null);
  const [contactLoading, setContactLoading] = useState(true);
  const [vaultLocked, setVaultLocked] = useState(false);

  useEffect(() => {
    setTab(parseTab());
  }, []);

  const selectTab = useCallback((id: string) => {
    const next = id as TabId;
    setTab(next);
    const url = new URL(window.location.href);
    if (next === 'overview') url.searchParams.delete('tab');
    else url.searchParams.set('tab', next);
    window.history.replaceState({}, '', url.pathname + url.search);
  }, []);

  useEffect(() => {
    if (!agentAddress) return;
    let cancelled = false;
    setContactLoading(true);
    loadImpactProfile(agentAddress)
      .then((p) => { if (!cancelled) setContact(p.contact ?? {}); })
      .catch((err) => { if (!cancelled && err instanceof VaultKeyUnauthorizedError) setVaultLocked(true); })
      .finally(() => { if (!cancelled) setContactLoading(false); });
  }, [agentAddress]);

  const displayName = useMemo(() => {
    const first = contact?.firstName?.trim();
    const last = contact?.lastName?.trim();
    if (first || last) return [first, last].filter(Boolean).join(' ');
    return agentName ?? 'Your profile';
  }, [contact, agentName]);

  const contactSummary = useMemo(() => {
    if (vaultLocked) return 'Vault locked — activate key';
    if (contactLoading) return 'Loading…';
    const email = contact?.email?.trim();
    if (email) return email;
    const filled = [contact?.firstName, contact?.lastName].filter((x) => x?.trim()).length;
    return filled > 0 ? 'Details saved' : 'Not set up yet';
  }, [contact, contactLoading, vaultLocked]);

  const meta = TAB_META[tab];

  return (
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
      {tab === 'overview' && (
        <>
          <SettingsGroup label="Profile">
            <SettingsRow icon="👤" label="Personal info" value={contactSummary} onClick={() => selectTab('personal')} />
            <SettingsRow icon="🪪" label="Identity" value={agentName ?? '—'} onClick={() => selectTab('identity')} />
            <SettingsRow icon="📷" label="Profile photo" value="Tap avatar above to change" onClick={() => selectTab('personal')} />
          </SettingsGroup>
          <SettingsGroup label="Account">
            <SettingsRow icon="🔐" label="Security & delegations" value="Manage access you granted" onClick={() => selectTab('security')} />
            <SettingsRow icon="🔗" label="Connected services" value="Directory & manifest" onClick={() => selectTab('connected')} />
            <SettingsRow icon="💰" label="Personal treasury" value="Funds agent" onClick={() => selectTab('treasury')} />
          </SettingsGroup>
          <SettingsGroup label="Community">
            <SettingsRow icon="📜" label="Attestations" value="WEA Statement of Faith" onClick={() => selectTab('attestations')} />
            <SettingsRow icon="💬" label="Messages" value="Direct messages & requests" href="/messages" />
          </SettingsGroup>
        </>
      )}

      {tab === 'personal' && (
        <PersonalInfoPanel
          agentAddress={agentAddress ?? null}
          onSaved={setContact}
          onNeedsVaultKey={() => setVaultLocked(true)}
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
          <button type="button" className="ghost" disabled={busy} onClick={() => void newHome()}>
            {busy ? 'Starting…' : 'Use Google for a new home'}
          </button>
          {err && <p style={{ color: 'var(--color-danger)', fontSize: '0.78rem', margin: '0.35rem 0 0' }}>{err}</p>}
        </div>
      </div>
    </SettingsGroup>
  );
}
