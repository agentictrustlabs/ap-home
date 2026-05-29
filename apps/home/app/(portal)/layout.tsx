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
  const { phase, session, agentName, notice, clearNotice } = useSession();
  const [mounted, setMounted] = useState(false);
  const [enroll, setEnroll] = useState(false);
  const [pendingEnroll, setPendingEnroll] = useState(false);
  useEffect(() => {
    setEnroll(hasEnrollParams());
    setPendingEnroll(!!readPendingEnroll());
    setMounted(true);
  }, []);

  let content: ReactNode;
  if (!mounted) content = <FullBleedSpinner />; // stable SSR/first-paint (no authed content server-side)
  else if (enroll) content = <EntryExperience mode="enroll" />;
  else if (phase === 'restoring') content = <FullBleedSpinner />;
  else if (phase === 'anon') content = <EntryExperience mode="entry" />;
  // A Google member returned mid relying-app enrollment — finish securing + granting + deliver the
  // code back to the app (the enroll request was stashed before the Google redirect; spec 235).
  else if (session?.via === 'Google' && pendingEnroll) content = <GoogleEnrollResume />;
  // A Google member returns ALREADY in a custody session but with no home yet (counterfactual,
  // unnamed SA) — claim their name before entering the portal (spec 235 P2.4).
  else if (session?.via === 'Google' && !agentName) content = <GoogleSecureHome />;
  else content = <PortalShell>{children}</PortalShell>;

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
