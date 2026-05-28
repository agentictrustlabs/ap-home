'use client';
// The onboarding first-run journey, composed from the home ACTIVITIES (src/home/onboarding):
// secure → register → permit. Three understandable activities backed by the fewest device
// prompts: createHomeKey (your device becomes your key) + secureHome (found your home AND
// register your name — one tap, two outcomes) + givePermission (the one separate consent).
import { useRef, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { createHomeKey, secureHome, openHome, givePermission } from '../../home/onboarding';
import { homeLabel, type Home } from '../../home/types';
import { recordConnectedApp } from '../../lib/connected-apps';
import { whitelabel, fmt } from '../../whitelabel/config';
import { useSession } from '../../context/session';
import type { DemoPasskey } from '../../lib/passkey';
import type { EnrollApi } from './useEnrollReq';
import { BrandShield } from '../shared/BrandShield';
import { ValueStepList, type ValueStep } from '../shared/ValueStepList';
import { OnboardingProgress } from '../shared/OnboardingProgress';
import { ReceiptCard } from '../shared/ReceiptCard';
import { ConsentSheet } from '../shared/ConsentSheet';

export type JourneyVariant = 'enroll-new' | 'enroll-existing' | 'self-serve';

type Screen = 'arrival' | 'overview' | 'key-ready' | 'receipts' | 'grant' | 'connected' | 'error';

export function OnboardingJourney({
  variant,
  name,
  api,
  existingAgent,
}: {
  variant: JourneyVariant;
  name: string;
  api?: EnrollApi;
  existingAgent?: Address;
}) {
  const { openSession } = useSession();
  const c = whitelabel.copy;
  const community = whitelabel.brand.community;
  const appHost = api?.host ?? '';
  const relyingApp = api?.enroll ? whitelabel.relyingApps.find((a) => a.client_id === api.enroll!.aud) : undefined;
  const appName = relyingApp?.name ?? appHost; // friendly name (anti-spoof: from registered config)
  const hasApp = variant !== 'self-serve';
  const base = homeLabel(name);

  const [screen, setScreen] = useState<Screen>(variant === 'enroll-existing' ? 'grant' : 'arrival');
  const [busy, setBusy] = useState<string | null>(null);
  const [key, setKey] = useState<DemoPasskey | null>(null);
  const [home, setHome] = useState<Home | null>(existingAgent ? { address: existingAgent, name } : null);
  const [error, setError] = useState<string>('');
  const failBack = useRef<Screen>('overview');

  const fail = (e: unknown, back: Screen) => {
    setBusy(null);
    setError(e instanceof Error ? e.message : 'Something went wrong');
    failBack.current = back;
    setScreen('error');
  };

  // ①a — your device becomes your key (gated behind the Overview CTA = a user gesture).
  async function onCreateKey() {
    setBusy('Setting up your key on this device…');
    try {
      setKey(await createHomeKey(name));
      setBusy(null);
      setScreen('key-ready');
    } catch (e) {
      fail(e, 'overview');
    }
  }

  // ① + ② — secure your home + register your name (one signed step, two outcomes).
  async function onSecureHome() {
    if (!key) return;
    setBusy(c.portalStepBusy);
    try {
      const res = await secureHome(key, name);
      if (!res.ok) return fail(res.error, 'key-ready');
      setHome(res.home);
      setBusy(null);
      setScreen('receipts');
    } catch (e) {
      fail(e, 'key-ready');
    }
  }

  // After the receipts: relying-app → permission consent; self-serve → open your home.
  async function onContinue() {
    if (hasApp) {
      setScreen('grant');
      return;
    }
    if (!home) return;
    setBusy('Opening your home…');
    try {
      const out = await openHome(home.name);
      if (!out.ok) return fail(out.error, 'receipts');
      await openSession(out.token, 'passkey', true);
    } catch (e) {
      fail(e, 'receipts');
    }
  }

  // ③ — give the app permission to your resources (the one separate consent + signature).
  async function onGivePermission() {
    if (!api?.enroll || !home) return;
    setBusy(fmt(c.authorizeStepBusy, { app: appName }));
    api.postToOpener?.({ type: 'AC_PROGRESS', msg: 'Granting permission…' });
    try {
      const granted = await givePermission(home, api.enroll.delegate);
      if (!granted.ok) return fail(granted.error, 'grant');
      const code = await api.submitGrant(home.name, granted.grant);
      const tpl = whitelabel.delegationTemplates[api.enroll.template];
      recordConnectedApp(home.address, {
        clientId: api.enroll.aud,
        appName,
        appDomain: appHost,
        logo: relyingApp?.logo,
        canDo: tpl?.canDo ?? [],
        cannotDo: tpl?.cannotDo ?? [],
        grantedAt: Date.now(),
        expiresAt: tpl?.expiryDays ? Date.now() + tpl.expiryDays * 86_400_000 : undefined,
      });
      setBusy(null);
      setScreen('connected');
      setTimeout(() => api.deliverCode(code), 1100);
    } catch (e) {
      fail(e, 'grant');
    }
  }

  if (busy) {
    return (
      <Frame>
        <div className="onboarding-busy">
          <span className="spinner spinner-lg" role="status" aria-label="Working" />
          <p className="onboarding-busy-msg">{busy}</p>
          <p className="onboarding-busy-sub">Your device may ask you to confirm. This takes a few seconds.</p>
        </div>
      </Frame>
    );
  }

  if (screen === 'error') {
    return (
      <Frame>
        <h1 className="onboarding-h1">Something went wrong</h1>
        <div className="onboarding-error">{error}</div>
        <p className="onboarding-sub">Nothing was changed. You can try again.</p>
        <button className="btn-primary" onClick={() => { setError(''); setScreen(failBack.current); }}>Try again</button>
        {api && <button className="btn-ghost onboarding-secondary" onClick={api.denyEnroll}>Cancel</button>}
      </Frame>
    );
  }

  if (screen === 'arrival') {
    return (
      <Frame>
        <BrandShield size={60} />
        <h1 className="onboarding-h1">{c.arrivalTitle}</h1>
        <p className="onboarding-sub">{c.arrivalBody}</p>
        <div className="name-chip">
          <span className="name-chip-label">{base}</span>
          <span className="name-chip-full">your name in the {community}</span>
        </div>
        <button className="btn-primary" onClick={() => setScreen('overview')}>Get started</button>
      </Frame>
    );
  }

  if (screen === 'overview') {
    const steps: ValueStep[] = [
      { id: 'secure', title: c.portalStepTitle, body: c.portalStepValue, status: 'active' },
      { id: 'register', title: c.communityStepTitle, body: c.communityStepValue, status: 'pending' },
      ...(hasApp
        ? [{ id: 'permit', title: fmt(c.authorizeStepTitle, { app: appName }), body: fmt(c.authorizeStepValue, { app: appName }), status: 'pending' as const }]
        : [{ id: 'later', title: 'Give apps permission later', body: `From your home you can give missional community apps permission anytime.`, status: 'pending' as const }]),
    ];
    return (
      <Frame>
        <h1 className="onboarding-h1">{c.overviewTitle}</h1>
        <ValueStepList steps={steps} />
        <p className="onboarding-note">Securing your home registers your name too — one confirmation.</p>
        <button className="btn-primary" onClick={onCreateKey}>{c.portalStepCta}</button>
      </Frame>
    );
  }

  if (screen === 'key-ready') {
    return (
      <Frame>
        <OnboardingProgress total={hasApp ? 3 : 2} current={1} label={c.portalStepTitle} />
        <ReceiptCard title="Your key is ready on this device" body="Only your device can use it — no password." />
        <h1 className="onboarding-h1">{c.portalStepTitle}</h1>
        <p className="onboarding-sub">
          One confirmation secures <strong>{base}</strong> as your home and registers your name so the {community} can find you.
        </p>
        <button className="btn-primary" onClick={onSecureHome}>{c.portalStepCta}</button>
      </Frame>
    );
  }

  if (screen === 'receipts') {
    const registered = home ? homeLabel(home.name) : base;
    return (
      <Frame>
        <OnboardingProgress total={hasApp ? 3 : 2} current={2} label={c.communityStepTitle} />
        <div className="celebrate">
          <BrandShield size={52} />
          <h1 className="onboarding-h1">Your home is ready</h1>
        </div>
        <ReceiptCard title={c.portalStepReceipt} body="Secured ✓ · yours alone" />
        <ReceiptCard title={fmt(c.communityStepReceipt, { name: registered })} body={`You're known as ${registered}`} />
        <button className="btn-primary" onClick={onContinue}>Continue</button>
      </Frame>
    );
  }

  if (screen === 'grant' && api?.enroll) {
    const tpl = whitelabel.delegationTemplates[api.enroll.template] ?? { canDo: [], cannotDo: ['Move your funds', 'Add sign-in methods', 'Change your recovery'] };
    return (
      <Frame wide>
        <OnboardingProgress total={3} current={3} label="Give permission" />
        <ConsentSheet
          title={fmt(c.authorizeStepTitle, { app: appName })}
          appName={appName}
          appDomain={appHost}
          appLogo={relyingApp?.logo}
          template={tpl}
          authorizeLabel={fmt(c.authorizeStepCta, { app: appName })}
          onAuthorize={onGivePermission}
          onDecline={api.denyEnroll}
        />
      </Frame>
    );
  }

  if (screen === 'connected') {
    return (
      <Frame>
        <div className="celebrate">
          <BrandShield size={64} />
          <h1 className="onboarding-h1">Permission granted</h1>
        </div>
        <ReceiptCard title={fmt(c.authorizeStepReceipt, { app: appName })} />
        <p className="onboarding-sub">Returning you to {appName}…</p>
      </Frame>
    );
  }

  return null;
}

function Frame({ children, wide = false }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="onboarding-screen">
      <div className={`onboarding-card${wide ? ' wide' : ''}`}>{children}</div>
    </div>
  );
}
