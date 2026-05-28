'use client';
// The portal gate: wraps every (portal)/* route. Decides what `/` and the sections render —
// the onboarding/sign-in EntryExperience when not authed (or mid relying-app enrollment),
// the PortalShell when authed. Mirrors the old App.tsx `if (enrollReq){…}` early-return:
// an enrollment takes precedence over any stale session.
import { useEffect, useState, type ReactNode } from 'react';
import { SessionProvider, useSession } from '../../src/context/session';
import { PortalShell } from '../../src/components/portal/PortalShell';
import { EntryExperience } from '../../src/components/onboarding/EntryExperience';
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
  const { phase } = useSession();
  const [mounted, setMounted] = useState(false);
  const [enroll, setEnroll] = useState(false);
  useEffect(() => {
    setEnroll(hasEnrollParams());
    setMounted(true);
  }, []);

  if (!mounted) return <FullBleedSpinner />; // stable SSR/first-paint (no authed content server-side)
  if (enroll) return <EntryExperience mode="enroll" />;
  if (phase === 'restoring') return <FullBleedSpinner />;
  if (phase === 'anon') return <EntryExperience mode="entry" />;
  return <PortalShell>{children}</PortalShell>;
}

export default function PortalLayout({ children }: { children: ReactNode }) {
  return (
    <SessionProvider>
      <Gate>{children}</Gate>
    </SessionProvider>
  );
}
