'use client';
// Post-Google secure-home step. A Google member returns from the OIDC redirect ALREADY in a
// custody-grade session (sub = their deterministic KMS-custodied SA) but with NO home yet —
// the SA is counterfactual + unnamed. This screen claims their name: demo-a2a derives their
// per-subject custodian and deploys + claims in ONE server-signed userOp (their only gesture
// was signing in with Google — no device prompt here). On success the profile gains a name and
// the portal gate switches to the PortalShell.
//
// spec 257 Phase 1.5 (TRUE name-deferral): a first-time Google member does NOT type, see, OR get
// assigned a name on the happy path. We SILENTLY secure a NAMELESS home — the server deploys their
// KMS-custodied SA with empty callData, leaving their single subregistry slot FREE — and go
// straight to the "You're in." beat. Their public name is claimed LATER, by their own choice, via
// the optional "Claim your public name" card in the portal (greenfield 08, ClaimPublicNameCard) —
// which now genuinely works (the slot wasn't consumed). A "choose a name now" affordance stays
// reachable for power users (the named bootstrap-and-claim path), but it is NOT the default.
// ADR-0010: the name is a FACET pointing AT the SA, never part of the SA salt — the address is
// identical whether the member stays nameless or later claims a custom one. ADR-0013: ONE
// mechanism — deploy nameless, claim on demand; no silent auto-name fallback.
import { useEffect, useRef, useState } from 'react';
import { secureHome, secureHomeNoName } from '../../home/onboarding';
import { whitelabel } from '../../whitelabel/config';
import { useSession } from '../../context/session';
import { nameLabel, toAgentName } from '../../lib/domain';
import { BrandShield } from '../shared/BrandShield';
import { HomeResolvedView } from './HomeResolvedView';

export function GoogleSecureHome() {
  const { session, refreshProfile } = useSession();
  const community = whitelabel.brand.community;
  const c = whitelabel.copy;
  // 'auto' = the happy path (no name → silently secure a NAMELESS home). 'name' = the reachable
  // power-user "choose a name now" affordance. We START in 'auto' and secure immediately on mount.
  const [value, setValue] = useState(() => {
    try {
      return nameLabel(sessionStorage.getItem('pendingHomeName') ?? '') || '';
    } catch {
      return '';
    }
  });
  const [phase, setPhase] = useState<'auto' | 'name' | 'securing' | 'done' | 'error'>('auto');
  const [securedName, setSecuredName] = useState('');
  const [err, setErr] = useState('');
  const label = nameLabel(value);
  const autoFired = useRef(false);

  // Happy path: as soon as we land here with a Google custody session, silently secure a NAMELESS
  // home — no name input, no extra device gesture (Google already custodies). The public name is
  // claimed later, by choice, via the portal's ClaimPublicNameCard.
  useEffect(() => {
    if (phase !== 'auto' || autoFired.current || !session) return;
    autoFired.current = true;
    void autoSecure();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, session]);

  function clearPendingName() {
    try {
      sessionStorage.removeItem('pendingHomeName');
    } catch {
      /* ignore */
    }
  }

  async function autoSecure() {
    if (!session) return;
    setPhase('securing');
    setErr('');
    try {
      const res = await secureHomeNoName({ token: session.token });
      if (!res.ok) {
        setErr(res.error);
        setPhase('error');
        return;
      }
      clearPendingName();
      setSecuredName(''); // nameless — the "You're in." beat shows no handle
      setPhase('done');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'could not secure your home');
      setPhase('error');
    }
  }

  async function secureCustom() {
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
      clearPendingName();
      setSecuredName(res.home.name);
      setPhase('done');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'could not secure your home');
      setPhase('error');
    }
  }

  if (phase === 'auto') {
    // Transient: the auto-secure effect fires immediately; show the securing shell so there's no
    // flash of the name input on the happy path.
    return (
      <Shell>
        <div className="onboarding-busy">
          <span className="spinner spinner-lg" role="status" aria-label="Securing your home" />
          <p className="onboarding-busy-msg">Securing your home in the {community}…</p>
        </div>
      </Shell>
    );
  }

  if (phase === 'securing') {
    const securingLabel = label ? toAgentName(label) : 'your home';
    return (
      <Shell>
        <div className="onboarding-busy">
          <span className="spinner spinner-lg" role="status" aria-label="Securing your home" />
          <p className="onboarding-busy-msg">Securing {securingLabel} in the {community}…</p>
        </div>
        <div className="securing-explainer">
          <p>
            We&apos;re founding your home on a public record no company controls. Signed in with Google,
            nothing else to do — you can claim a public name whenever you like.
          </p>
          <p className="securing-wait">This usually takes about 15 seconds — you can stay on this page.</p>
        </div>
      </Shell>
    );
  }

  if (phase === 'done') {
    // spec 257 W3 — the "You're in." reward beat (greenfield 06) for a freshly-bootstrapped home.
    // Mark the gate's welcome-back beat as already-shown before refreshing in (a new home is its
    // own reward; we must not also fire the returning-member beat once the profile resolves).
    // On the happy path the home is NAMELESS (securedName === ''), so the beat shows no handle;
    // the public name is offered LATER (greenfield 08) via the portal's ClaimPublicNameCard.
    return (
      <HomeResolvedView
        fresh
        knownName={securedName || null}
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
        <button className="btn-primary" onClick={() => { autoFired.current = false; setPhase('auto'); }}>Try again</button>
        <button className="btn-ghost onboarding-secondary" onClick={() => setPhase('name')}>Choose a name instead</button>
      </Shell>
    );
  }

  // Reachable power-user affordance (NOT the default): choose a custom name to secure with.
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
      <button className="btn-primary" disabled={!label} onClick={secureCustom}>{c.portalStepCta}</button>
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
