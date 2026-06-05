'use client';
// spec 257 Phase 1 W3 — the "home resolved" confirmation beat (greenfield 06 / 10). The moment a
// credential resolves to (or bootstraps) an Impact home, show a clean, on-brand confirmation —
// "We found your Impact home" (returning) or "You're in." (new) — with the handle rendered
// prominently and best-effort connected role/org chips, BEFORE the session is issued / popup
// closes. Display only: it never resolves or signs; it just presents what the flow already knows
// and then auto-advances (or waits for a tap). The chip lookup is non-blocking — if it's slow or
// empty we show the handle alone; the session is NEVER gated on it.
import { useEffect, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { listMyOrgs, type MyOrg } from '../../connect-client';
import { reverseAgentName } from '../../lib/reverse-name';
import { nameLabel } from '../../lib/domain';
import { purposeLabel } from '../portal/OrgList';
import { BrandShield } from '../shared/BrandShield';

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="onboarding-screen"><div className="onboarding-card">{children}</div></div>;
}

/** Best-effort connected role/org chips for the resolved home. Returns [] on any error/empty —
 *  the caller shows the handle alone; the session is never gated on this read. */
function useHomeChips(token: string | null): MyOrg[] {
  const [orgs, setOrgs] = useState<MyOrg[]>([]);
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    void listMyOrgs(token)
      .then((o) => { if (!cancelled) setOrgs(o); })
      .catch(() => { /* non-blocking — handle alone is fine */ });
    return () => { cancelled = true; };
  }, [token]);
  return orgs;
}

/** The handle to render: the name the flow already knows, refined by an on-chain reverse lookup
 *  if `address` is given (and reverse has an answer). Falls back to the known name. */
function useHandle(knownName: string | null, address: Address | null): string | null {
  const [handle, setHandle] = useState<string | null>(knownName);
  useEffect(() => {
    if (!address) return;
    let cancelled = false;
    void reverseAgentName(address)
      .then((n) => { if (!cancelled && n) setHandle(n); })
      .catch(() => { /* keep the known name */ });
    return () => { cancelled = true; };
  }, [address]);
  return handle ?? knownName;
}

export function HomeResolvedView({
  fresh,
  knownName = null,
  address = null,
  token = null,
  appName = null,
  onContinue,
  autoAdvanceMs = 1300,
}: {
  /** true = freshly-created home ("You're in."); false = resolved existing home ("Welcome back"). */
  fresh: boolean;
  /** The handle the flow already knows (e.g. profile.name), shown immediately. */
  knownName?: string | null;
  /** Optional SA address to reverse-resolve a fresher handle (best-effort). */
  address?: Address | null;
  /** Optional session token to read connected role/org chips (best-effort, non-blocking). */
  token?: string | null;
  /** Optional relying-app name for the "connected to <app>" line (greenfield 06). */
  appName?: string | null;
  /** Proceed (issue the session / enter the portal). Tapping "Continue" calls this too. */
  onContinue: () => void;
  /** Auto-advance delay in ms; 0 disables (Continue-only). */
  autoAdvanceMs?: number;
}) {
  const handle = useHandle(knownName, address);
  const orgs = useHomeChips(token);

  useEffect(() => {
    if (autoAdvanceMs <= 0) return;
    const t = setTimeout(onContinue, autoAdvanceMs);
    return () => clearTimeout(t);
    // Fixed-timer auto-advance; callers pass a stable onContinue.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoAdvanceMs]);

  const label = handle ? nameLabel(handle) : '';

  return (
    <Shell>
      <div className="celebrate">
        <BrandShield size={56} />
        <h1 className="onboarding-h1">{fresh ? "You're in." : 'Welcome back'}</h1>
      </div>
      {fresh ? (
        <p className="onboarding-sub">
          Your Impact home is ready{appName ? <> and connected to <strong>{appName}</strong></> : null}.
        </p>
      ) : (
        <p className="onboarding-sub">We found your Impact home.</p>
      )}
      {handle && (
        <div className="name-chip">
          {label && <span className="name-chip-label">{label}</span>}
          <span className="name-chip-full">{handle}</span>
        </div>
      )}
      {orgs.length > 0 && (
        <div className="reward-row">
          {orgs.slice(0, 3).map((o) => (
            <span className="reward-chip" key={o.orgAgent}>
              <span className="reward-chip-icon" aria-hidden="true">✓</span>
              {o.orgName ? `${purposeLabel(o.purpose)} · ${o.orgName}` : purposeLabel(o.purpose)}
            </span>
          ))}
        </div>
      )}
      <button className="btn-primary" onClick={onContinue}>
        {appName ? `Continue to ${appName}` : 'Continue'}
      </button>
    </Shell>
  );
}
