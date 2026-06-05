'use client';
// Post-Google secure-home step. A Google member returns from the OIDC redirect ALREADY in a
// custody-grade session (sub = their deterministic KMS-custodied SA) but with NO home yet —
// the SA is counterfactual + unnamed. This screen claims their name: demo-a2a derives their
// per-subject custodian and deploys + claims in ONE server-signed userOp (their only gesture
// was signing in with Google — no device prompt here). On success the profile gains a name and
// the portal gate switches to the PortalShell.
import { useState } from 'react';
import { secureHome } from '../../home/onboarding';
import { whitelabel } from '../../whitelabel/config';
import { useSession } from '../../context/session';
import { nameLabel, toAgentName } from '../../lib/domain';
import { BrandShield } from '../shared/BrandShield';
import { HomeResolvedView } from './HomeResolvedView';

export function GoogleSecureHome() {
  const { session, refreshProfile } = useSession();
  const community = whitelabel.brand.community;
  const c = whitelabel.copy;
  const [value, setValue] = useState(() => {
    try {
      return nameLabel(sessionStorage.getItem('pendingHomeName') ?? '') || '';
    } catch {
      return '';
    }
  });
  const [phase, setPhase] = useState<'name' | 'securing' | 'done' | 'error'>('name');
  const [securedName, setSecuredName] = useState('');
  const [err, setErr] = useState('');
  const label = nameLabel(value);

  async function secure() {
    if (!label || !session) return;
    setPhase('securing');
    setErr('');
    try {
      const res = await secureHome(null, toAgentName(label), 'google', { token: session.token });
      if (!res.ok) {
        setErr(res.error);
        setPhase('error');
        return;
      }
      try {
        sessionStorage.removeItem('pendingHomeName');
      } catch {
        /* ignore */
      }
      setSecuredName(res.home.name);
      setPhase('done');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'could not secure your home');
      setPhase('error');
    }
  }

  if (phase === 'securing') {
    return (
      <Shell>
        <div className="onboarding-busy">
          <span className="spinner spinner-lg" role="status" aria-label="Securing your home" />
          <p className="onboarding-busy-msg">Securing {toAgentName(label)} as your home in the {community}…</p>
        </div>
        <div className="securing-explainer">
          <p>
            We&apos;re founding <strong>{toAgentName(label)}</strong> as your home and registering your name —
            permanently yours, on a public record no company controls. Signed in with Google, nothing else to do.
          </p>
          <p className="securing-wait">This usually takes about 15 seconds — you can stay on this page.</p>
        </div>
      </Shell>
    );
  }

  if (phase === 'done') {
    // spec 257 W3 — the "You're in." reward beat (greenfield 06) for a freshly-bootstrapped home.
    // Mark the gate's welcome-back beat as already-shown before refreshing in (a new home is its
    // own reward; we must not also fire the returning-member beat once the profile gains a name).
    return (
      <HomeResolvedView
        fresh
        knownName={securedName}
        token={session?.token ?? null}
        autoAdvanceMs={0}
        onContinue={() => {
          try { sessionStorage.setItem('homeWelcomeShown', '1'); } catch { /* ignore */ }
          void refreshProfile();
        }}
      />
    );
  }

  if (phase === 'error') {
    return (
      <Shell>
        <h1 className="onboarding-h1">Something went wrong</h1>
        <div className="onboarding-error">{err}</div>
        <p className="onboarding-sub">Nothing was changed. You can try again.</p>
        <button className="btn-primary" onClick={() => setPhase('name')}>Try again</button>
      </Shell>
    );
  }

  return (
    <Shell>
      <BrandShield size={56} />
      <h1 className="onboarding-h1">{c.portalStepTitle}</h1>
      <p className="onboarding-sub">
        You&apos;re signed in with Google. Choose your name in the {community} — your home is secured with no extra step.
      </p>
      <input
        className="onboarding-input"
        value={value}
        onChange={(e) => setValue(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
        placeholder="e.g. alice"
        aria-label="Your name"
        autoCapitalize="none"
        spellCheck={false}
      />
      {label && <div className="onboarding-name-preview">{toAgentName(label)}</div>}
      <button className="btn-primary" disabled={!label} onClick={secure}>{c.portalStepCta}</button>
      {/* G-4 informed consent: Google-alone = full control by design (spec 235 §3). */}
      <p className="onboarding-note">
        Signing in with Google will fully control this home. Keep your Google account secure — you can add a
        passkey later for extra protection.
      </p>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="onboarding-screen">
      <div className="onboarding-card">{children}</div>
    </div>
  );
}
