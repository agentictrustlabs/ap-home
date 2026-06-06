'use client';
// The portal gate: wraps every (portal)/* route. Decides what `/` and the sections render —
// the onboarding/sign-in EntryExperience when not authed (or mid relying-app enrollment),
// the PortalShell when authed. Mirrors the old App.tsx `if (enrollReq){…}` early-return:
// an enrollment takes precedence over any stale session.
import { useEffect, useState, type ReactNode } from 'react';
import { SessionProvider, useSession } from '../../src/context/session';
import { PortalShell } from '../../src/components/portal/PortalShell';
import { EntryExperience } from '../../src/components/onboarding/EntryExperience';
import { GoogleSecureHome } from '../../src/components/onboarding/GoogleSecureHome';
import { GoogleEnrollResume, readPendingEnroll } from '../../src/components/onboarding/GoogleEnrollResume';
import { HomeResolvedView } from '../../src/components/onboarding/HomeResolvedView';
import { parseEnrollReq } from '../../src/components/onboarding/useEnrollReq';

function FullBleedSpinner() {
  return (
    <div className="fullbleed-spinner" role="status" aria-label="Loading">
      <span className="spinner spinner-lg" />
    </div>
  );
}

// A relying app redirected here for enrollment/consent (spec 230) — takes precedence over
// any stale session, mirroring the old App.tsx `if (enrollReq){…}` early return.
function hasEnrollParams(): boolean {
  return !!parseEnrollReq();
}

function Gate({ children }: { children: ReactNode }) {
  const { phase, session, agentName, agentAddress, agentDeployed, notice, clearNotice } = useSession();
  const [mounted, setMounted] = useState(false);
  const [enroll, setEnroll] = useState(false);
  const [pendingEnroll, setPendingEnroll] = useState(false);
  // spec 257 W3 — a one-shot "Welcome back" beat shown the first time a fresh Google sign-in
  // resolves to an EXISTING home, before the portal. Dismisses to the portal on continue; never
  // re-shows for restored sessions (only `session.fresh`).
  const [welcomedBack, setWelcomedBack] = useState(false);
  useEffect(() => {
    setEnroll(hasEnrollParams());
    setPendingEnroll(!!readPendingEnroll());
    setMounted(true);
  }, []);

  // A brand-new Google home already showed its own "You're in." reward in GoogleSecureHome (which
  // sets this flag just before refreshing in) — suppress the gate's returning-member beat so it
  // doesn't double-fire once the profile gains a name. Read at render: the flag may be set after
  // mount, in the same Gate instance, when GoogleSecureHome transitions us to an authed profile.
  let bootstrapReward = false;
  try { bootstrapReward = !!sessionStorage.getItem('homeWelcomeShown'); } catch { /* ignore */ }
  // Consume it once we're past the freshness window (restored / non-fresh) so a later sign-out →
  // sign-in cycle gets a fresh "Welcome back" beat.
  useEffect(() => {
    if (bootstrapReward && (!session?.fresh || phase !== 'authed')) {
      try { sessionStorage.removeItem('homeWelcomeShown'); } catch { /* ignore */ }
    }
  }, [bootstrapReward, session?.fresh, phase]);

  // KMS-custodied OIDC homes (Google + YouVersion) share the server-side secure-home / enroll-resume /
  // welcome-back beats — the demo-a2a bridge derives the custodian from the session (iss, sub) for both.
  const isOidcHome = session?.via === 'Google' || session?.via === 'YouVersion';

  // A fresh OIDC return that already has a home (no secure-home step, no enroll) → show the welcome-back
  // beat once. (Passkey/wallet/name surface their own beat in EntryExperience.)
  const showGoogleWelcomeBack =
    mounted && phase === 'authed' && isOidcHome && session?.fresh &&
    !!agentName && !enroll && !pendingEnroll && !welcomedBack && !bootstrapReward;

  let content: ReactNode;
  if (!mounted) content = <FullBleedSpinner />; // stable SSR/first-paint (no authed content server-side)
  else if (enroll) content = <EntryExperience mode="enroll" />;
  else if (phase === 'restoring') content = <FullBleedSpinner />;
  else if (phase === 'anon') content = <EntryExperience mode="entry" />;
  // A Google member returned mid relying-app enrollment — finish securing + granting + deliver the
  // code back to the app (the enroll request was stashed before the Google redirect; spec 235).
  else if (isOidcHome && pendingEnroll) content = <GoogleEnrollResume />;
  // A Google member returns ALREADY in a custody session but with no home DEPLOYED yet (their
  // `sub` is a counterfactual SA) — secure it before entering the portal (spec 235 P2.4). spec 257
  // Phase 1.5: gate on DEPLOYMENT, not name — a deployed-but-nameless home (true name-deferral)
  // must fall through to the portal, where it claims a public name by choice (ClaimPublicNameCard).
  else if (isOidcHome && !agentDeployed) content = <GoogleSecureHome />;
  // spec 257 W3 — "Welcome back, <handle>" beat for a returning Google member (existing home).
  else if (showGoogleWelcomeBack) {
    content = (
      <HomeResolvedView
        fresh={false}
        knownName={agentName}
        address={agentAddress}
        token={session?.token ?? null}
        onContinue={() => setWelcomedBack(true)}
      />
    );
  } else content = <PortalShell>{children}</PortalShell>;

  return (
    <>
      {notice && (
        <div className="notice-banner" role="status" aria-live="polite">
          <span className="notice-banner-text">{notice}</span>
          <button className="notice-banner-close" onClick={clearNotice} aria-label="Dismiss">×</button>
        </div>
      )}
      {content}
    </>
  );
}

export default function PortalLayout({ children }: { children: ReactNode }) {
  return (
    <SessionProvider>
      <Gate>{children}</Gate>
    </SessionProvider>
  );
}
