'use client';
// "You" — the person agent (default context). Identity card + facts + your personal treasury.
// Organizations live at /organizations, all treasuries at /treasuries (dedicated portal areas).
import { useState } from 'react';
import { useSession } from '../../../src/context/session';
import { PersonalTreasurySection } from '../../../src/components/portal/ManagedAgents';
import { DelegationsList } from '../../../src/components/portal/DelegationsList';
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

      <GoogleHomeSection />

      <div className="dash-section" style={{ marginTop: '1.5rem' }}>
        <h2>Your profile</h2>
        <div className="manage-grid">
          <a className="manage-card link" href="/profile">
            <div className="manage-card-head">
              <span className="manage-card-label"><UserIcon size={16} /> Contact details</span>
              <span className="manage-card-badge live">✓ Live</span>
            </div>
            <p className="manage-card-blurb">
              Name, email, phone, country, organization. Stored at your home, re-used across every community app you trust.
            </p>
          </a>
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
