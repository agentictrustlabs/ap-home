'use client';
// "You" — the person agent (default context). Identity card + facts + your personal treasury.
// Organizations live at /organizations, all treasuries at /treasuries (dedicated portal areas).
import { useEffect, useState } from 'react';
import { useSession } from '../../../src/context/session';
import {
  loadImpactProfile, PROFILE_FIELDS, VaultKeyUnauthorizedError,
  type ImpactContactProfile,
} from '../../../src/profile-store';
import { PersonalTreasurySection } from '../../../src/components/portal/ManagedAgents';
import { DelegationsList } from '../../../src/components/portal/DelegationsList';
import { HomeManifestCard } from '../../../src/components/portal/HomeManifestCard';
import { rotateGoogleHome } from '../../../src/server-client';
import { continueWithGoogle } from '../../../src/home/onboarding';
import { whitelabel } from '../../../src/whitelabel/config';
import { SectionShell } from '../../../src/components/portal/SectionShell';
import { AgentIdentityCard } from '../../../src/components/portal/AgentIdentityCard';
import { AddressChip } from '../../../src/components/shared/AddressChip';
import { UserIcon } from '../../../src/components/shared/Icons';

const EXPLORER = 'https://sepolia.basescan.org/address/';

export default function YouPage() {
  const { session, agentName, agentAddress, profile } = useSession();
  return (
    <SectionShell
      title="You"
      description={`This is you in the ${whitelabel.brand.community}. Your name is how others find and trust you; your address is your permanent identity.`}
    >
      <AgentIdentityCard
        size="hero"
        name={agentName ?? '—'}
        address={agentAddress ?? undefined}
        label={whitelabel.copy.portalYouLabel}
        explorerUrl={agentAddress ? EXPLORER + agentAddress : undefined}
      />

      <div className="dash-section" style={{ marginTop: '1.5rem' }}>
        <h2>Your identity</h2>
        <dl className="identity-facts">
          <div><dt>Name</dt><dd>{agentName ?? '—'}</dd></div>
          <div><dt>Address</dt><dd>{agentAddress ? <AddressChip address={agentAddress} size="sm" /> : '—'}</dd></div>
          <div><dt>Community</dt><dd>{whitelabel.brand.community}</dd></div>
          <div><dt>Access</dt><dd>{profile?.access === 'standard' ? 'Standard' : 'Full access'}</dd></div>
        </dl>
      </div>

      <PersonalTreasurySection token={session?.token ?? null} person={agentAddress ?? null} via={session?.via ?? ''} />

      <DelegationsList token={session?.token ?? null} />

      <HomeManifestCard />

      <GoogleHomeSection />

      <div className="dash-section" style={{ marginTop: '1.5rem' }}>
        <h2>Your profile</h2>
        <ContactDetails />
        <div className="manage-grid">
          <a className="manage-card link" href="/wea-sign">
            <div className="manage-card-head">
              <span className="manage-card-label">📜 WEA Statement of Faith</span>
              <span className="manage-card-badge live">✓ Live</span>
            </div>
            <p className="manage-card-blurb">
              Affirm the WEA Statement of Faith once at your home — every faith-aligned community app that needs it gets the attestation receipt automatically.
            </p>
          </a>
        </div>
      </div>
    </SectionShell>
  );
}

/** The member's community contact details, loaded from their PER-PERSON ENCRYPTED vault (spec 278 —
 *  `vault:impact-profile`, sealed under their own KEK, read over the /mcp-bind proxy). Shows the
 *  decrypted fields with an edit link; prompts to activate the vault key if it isn't bound yet. */
function ContactDetails(): React.JSX.Element {
  const { agentAddress } = useSession();
  const [contact, setContact] = useState<ImpactContactProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [needsVaultKey, setNeedsVaultKey] = useState(false);

  useEffect(() => {
    if (!agentAddress) return;
    let cancelled = false;
    setLoading(true);
    setNeedsVaultKey(false);
    loadImpactProfile(agentAddress)
      .then((p) => { if (!cancelled) setContact(p.contact ?? {}); })
      .catch((err) => { if (!cancelled && err instanceof VaultKeyUnauthorizedError) setNeedsVaultKey(true); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [agentAddress]);

  if (loading) return <p className="onboarding-sub" style={{ margin: '.25rem 0 1rem' }}>Loading your details from your encrypted vault…</p>;

  if (needsVaultKey) {
    return (
      <div className="manage-card" style={{ marginBottom: '1rem' }}>
        <div className="manage-card-head">
          <span className="manage-card-label"><UserIcon size={16} /> Contact details</span>
          <span className="manage-card-badge">🔒 Vault locked</span>
        </div>
        <p className="manage-card-blurb">
          Your details live in your private, end-to-end encrypted vault. Activate your vault key once to view and edit them.
        </p>
        <a className="btn-primary" href="/vault-key" style={{ display: 'inline-block', marginTop: '.5rem', textDecoration: 'none' }}>Activate vault key →</a>
      </div>
    );
  }

  const filled = PROFILE_FIELDS.filter((f) => (contact?.[f.key] ?? '').trim().length > 0);
  return (
    <div className="manage-card" style={{ marginBottom: '1rem' }}>
      <div className="manage-card-head">
        <span className="manage-card-label"><UserIcon size={16} /> Contact details</span>
        <span className="manage-card-badge live">🔐 Encrypted</span>
      </div>
      {filled.length === 0 ? (
        <p className="manage-card-blurb">No details yet. They&apos;re sealed in your vault under your own key and re-used across every community app you trust.</p>
      ) : (
        <dl className="identity-facts" style={{ marginTop: '.25rem' }}>
          {filled.map((f) => (
            <div key={f.key}><dt>{f.label}</dt><dd>{contact?.[f.key]}</dd></div>
          ))}
        </dl>
      )}
      <a href="/profile" style={{ display: 'inline-block', marginTop: '.6rem', fontSize: '.85rem', textDecoration: 'underline' }}>
        {filled.length === 0 ? 'Add your details →' : 'Edit profile →'}
      </a>
    </div>
  );
}

/** For a Google-custodied home: "use Google for a new home" (spec 235 §5b rotation). Bumps the
 *  per-subject rotation, then re-runs Google sign-in → a fresh home; this one is left as-is. */
function GoogleHomeSection() {
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
      continueWithGoogle(); // redirect to Google → returns at the new rotation → name the new home
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'could not start a new home');
      setBusy(false);
    }
  }

  return (
    <div className="dash-section" style={{ marginTop: '1.5rem' }}>
      <h2>Sign-in method</h2>
      <p className="onboarding-sub">This home opens with Google.</p>
      <button className="btn-ghost onboarding-secondary" disabled={busy} onClick={newHome}>
        {busy ? 'Starting…' : 'Use Google for a new home'}
      </button>
      <p className="onboarding-note">
        Creates a separate home from this same Google account — this home stays as it is. (To keep
        this home without Google, add a passkey or wallet on the Security page.)
      </p>
      {err && <p className="onboarding-hint taken">{err}</p>}
    </div>
  );
}
