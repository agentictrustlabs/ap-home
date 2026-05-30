'use client';
// Resume a relying-app enrollment AFTER a Google redirect (spec 235 + spec 230). The Google OAuth
// is a full-page redirect, so the enroll request can't survive in the URL — OnboardingJourney
// stashed it in sessionStorage before redirecting. On return the member is in a custody-grade
// Google session; here we (1) secure their home if it's brand new (server-signed, no gesture),
// (2) take the app-permission consent, (3) sign the delegation with the Google custodian, and
// (4) deliver the authorization code back to the relying app — popup postMessage or redirect,
// exactly as the in-page flow would. This is what lets "Continue with Google" return to demo-org.
import { useEffect, useRef, useState } from 'react';
import { secureHome, givePermission } from '../../home/onboarding';
import { whitelabel, fmt } from '../../whitelabel/config';
import { useSession } from '../../context/session';
import { nameLabel } from '../../lib/domain';
import { homeLabel, type Home } from '../../home/types';
import { recordConnectedApp } from '../../lib/connected-apps';
import { beginEnrollmentGrant, hostOf, submitEnrollGrant, deliverEnrollCode, type EnrollReq } from './useEnrollReq';
import { BrandShield } from '../shared/BrandShield';
import { ReceiptCard } from '../shared/ReceiptCard';
import { ConsentSheet } from '../shared/ConsentSheet';

const STASH_KEY = 'pendingEnroll';

interface PendingEnroll {
  enroll: EnrollReq;
  popupMode: boolean;
  name: string;
}

export function readPendingEnroll(): PendingEnroll | null {
  try {
    const raw = sessionStorage.getItem(STASH_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as PendingEnroll;
    return p?.enroll?.aud && p.enroll.redirectUri && p.enroll.delegate ? p : null;
  } catch {
    return null;
  }
}

type Phase = 'securing' | 'mismatch' | 'consent' | 'granting' | 'connected' | 'error';

export function GoogleEnrollResume() {
  const { session, agentAddress, agentName } = useSession();
  const c = whitelabel.copy;
  const community = whitelabel.brand.community;
  const ran = useRef(false);
  const [pending] = useState<PendingEnroll | null>(() => readPendingEnroll());
  const [phase, setPhase] = useState<Phase>('securing');
  const [home, setHome] = useState<Home | null>(null);
  const [error, setError] = useState('');

  const enroll = pending?.enroll;
  const relyingApp = enroll ? whitelabel.relyingApps.find((a) => a.client_id === enroll.aud) : undefined;
  const appHost = enroll ? hostOf(enroll.redirectUri) : '';
  const appName = relyingApp?.name ?? appHost;
  const token = session?.token ?? '';

  const fail = (e: unknown) => {
    setError(e instanceof Error ? e.message : typeof e === 'string' ? e : 'Something went wrong');
    setPhase('error');
  };
  const clearStash = () => {
    try {
      sessionStorage.removeItem(STASH_KEY);
    } catch {
      /* ignore */
    }
  };

  // Secure the home if it's brand new (Google custody → no gesture), else use the existing one.
  useEffect(() => {
    if (ran.current || !pending || !token) return;
    ran.current = true;
    void (async () => {
      if (agentName && agentAddress) {
        // Existing Google home. If it differs from the name the app asked to connect as, STOP and
        // explain (one Google account = one home) before granting — don't silently connect the
        // wrong home.
        setHome({ address: agentAddress, name: agentName });
        const requested = nameLabel(pending.enroll.name);
        setPhase(requested && nameLabel(agentName) !== requested ? 'mismatch' : 'consent');
        return;
      }
      const res = await secureHome(null, pending.name, 'google', { token });
      if (!res.ok) return fail(res.error);
      setHome(res.home);
      setPhase('consent');
    })();
  }, [pending, token, agentName, agentAddress]);

  async function onAuthorize() {
    if (!enroll || !home) return;
    setPhase('granting');
    try {
      // SEC-001: server-mint the enrollment grant FIRST; use the registry-derived delegate.
      const { grant_id, delegate } = await beginEnrollmentGrant(enroll, home.name);
      const granted = await givePermission(home, delegate, 'google', { token });
      if (!granted.ok) return fail(granted.error);
      const code = await submitEnrollGrant(grant_id, granted.grant);
      const tpl = whitelabel.delegationTemplates[enroll.template];
      recordConnectedApp(home.address, {
        clientId: enroll.aud,
        appName,
        appDomain: appHost,
        logo: relyingApp?.logo,
        canDo: tpl?.canDo ?? [],
        cannotDo: tpl?.cannotDo ?? [],
        grantedAt: Date.now(),
        expiresAt: tpl?.expiryDays ? Date.now() + tpl.expiryDays * 86_400_000 : undefined,
      });
      setPhase('connected');
      clearStash();
      setTimeout(() => deliverEnrollCode(enroll, pending!.popupMode, code), 1100);
    } catch (e) {
      fail(e);
    }
  }

  function onDecline() {
    clearStash();
    if (enroll) deliverEnrollCode(enroll, pending!.popupMode, ''); // empty code → relying app treats as cancel
  }

  if (!pending || !enroll) return null;

  if (phase === 'securing') {
    return (
      <Shell>
        <div className="onboarding-busy">
          <span className="spinner spinner-lg" role="status" aria-label="Securing your home" />
          <p className="onboarding-busy-msg">Securing your home in the {community}…</p>
        </div>
        <p className="onboarding-sub">Signed in with Google — no extra step. This takes a few seconds.</p>
      </Shell>
    );
  }

  if (phase === 'mismatch' && home) {
    const requested = nameLabel(enroll.name);
    return (
      <Shell>
        <BrandShield size={52} />
        <h1 className="onboarding-h1">You already have a home</h1>
        <p className="onboarding-sub">
          This Google account already opens <strong>{home.name}</strong>. You started connecting as{' '}
          <strong>{requested}</strong> — but signing in with Google always brings you to the home it first created
          (one Google account, one home). It can&apos;t be used to make a second.
        </p>
        <button className="btn-primary" onClick={() => setPhase('consent')}>
          Connect {appName} to {home.name}
        </button>
        <button className="btn-ghost onboarding-secondary" onClick={onDecline}>Cancel</button>
        <p className="onboarding-note">
          To use the name “{requested}”, go back to {appName} and secure it with a passkey or wallet instead.
        </p>
      </Shell>
    );
  }

  if (phase === 'granting') {
    return (
      <Shell>
        <div className="onboarding-busy">
          <span className="spinner spinner-lg" role="status" aria-label="Granting permission" />
          <p className="onboarding-busy-msg">{fmt(c.authorizeStepBusy, { app: appName })}</p>
        </div>
      </Shell>
    );
  }

  if (phase === 'connected') {
    return (
      <Shell>
        <div className="celebrate">
          <BrandShield size={56} />
          <h1 className="onboarding-h1">Permission granted</h1>
        </div>
        <ReceiptCard title={fmt(c.authorizeStepReceipt, { app: appName })} />
        <p className="onboarding-sub">Returning you to {appName}…</p>
      </Shell>
    );
  }

  if (phase === 'error') {
    return (
      <Shell>
        <h1 className="onboarding-h1">Couldn&apos;t finish</h1>
        <div className="onboarding-error">{error}</div>
        <button className="btn-primary" onClick={onDecline}>Return to {appName}</button>
      </Shell>
    );
  }

  // consent
  const tpl =
    whitelabel.delegationTemplates[enroll.template] ?? {
      canDo: [],
      cannotDo: ['Move your funds', 'Add sign-in methods', 'Change your recovery'],
    };
  return (
    <div className="onboarding-screen">
      <div className="onboarding-card wide">
        <ConsentSheet
          title={fmt(c.authorizeStepTitle, { app: appName })}
          appName={appName}
          appDomain={appHost}
          appLogo={relyingApp?.logo}
          template={tpl}
          authorizeLabel={fmt(c.authorizeStepCta, { app: appName })}
          onAuthorize={onAuthorize}
          onDecline={onDecline}
        />
      </div>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="onboarding-screen">
      <div className="onboarding-card">{children}</div>
    </div>
  );
}
