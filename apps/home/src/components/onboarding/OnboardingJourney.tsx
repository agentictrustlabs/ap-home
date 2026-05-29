'use client';
// The onboarding first-run journey, composed from the home ACTIVITIES (src/home/onboarding):
// secure → register → permit. Three understandable activities backed by the fewest device
// prompts: createHomeKey (your device becomes your key) + secureHome (found your home AND
// register your name — one tap, two outcomes) + givePermission (the one separate consent).
import { useRef, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { createHomeKey, secureHome, openHome, givePermission, type Via } from '../../home/onboarding';
import { hasWallet } from '../../lib/wallet';
import type { DemoPasskey } from '../../lib/passkey';
import { homeLabel, type Home } from '../../home/types';
import { recordConnectedApp } from '../../lib/connected-apps';
import { whitelabel, fmt } from '../../whitelabel/config';
import { useSession } from '../../context/session';
import type { EnrollApi } from './useEnrollReq';
import { BrandShield } from '../shared/BrandShield';
import { ValueStepList, type ValueStep } from '../shared/ValueStepList';
import { OnboardingProgress } from '../shared/OnboardingProgress';
import { ReceiptCard } from '../shared/ReceiptCard';
import { ConsentSheet } from '../shared/ConsentSheet';

export type JourneyVariant = 'enroll-new' | 'enroll-existing' | 'self-serve';

type Screen = 'arrival' | 'overview' | 'key-ready' | 'securing' | 'receipts' | 'grant' | 'connected' | 'error';

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
  const [securingMsg, setSecuringMsg] = useState<string>('');
  const [key, setKey] = useState<DemoPasskey | null>(null);
  const [via, setVia] = useState<Via>('passkey'); // the credential the member secures/opens with
  const [home, setHome] = useState<Home | null>(existingAgent ? { address: existingAgent, name } : null);
  // Credential methods offered for securing a home: config-enabled ∩ device capability.
  const methods = whitelabel.onboarding.credentialMethods.filter((m) => (m === 'wallet' ? hasWallet() : m === 'passkey'));
  const [error, setError] = useState<string>('');
  const failBack = useRef<Screen>('overview');

  // Surface the real reason — secureHome/etc. return error STRINGS, not Error objects.
  const fail = (e: unknown, back: Screen) => {
    setBusy(null);
    setError(e instanceof Error ? e.message : typeof e === 'string' ? e : 'Something went wrong');
    failBack.current = back;
    setScreen('error');
  };

  // Securing your home is two confirmations (the subregistry registers your name from YOUR
  // Smart Agent — one-name-per-caller — so a relayer can't do it for you). Gesture 1 mints
  // your key; gesture 2 founds your home + claims your name in one userOp.

  // Passkey, gesture 1 — create your key (a user gesture for WebAuthn create).
  async function onCreateKey() {
    setVia('passkey');
    setBusy('Confirm with your device…');
    try {
      setKey(await createHomeKey(name));
      setBusy(null);
      setScreen('key-ready');
    } catch (e) {
      fail(e, 'overview');
    }
  }

  // Passkey, gesture 2 — found your home + register your name in one signed userOp (rich wait).
  async function onSecureHome() {
    if (!key) return;
    setSecuringMsg(`Founding ${base} as your home and registering your name in the ${community}…`);
    setScreen('securing');
    try {
      const res = await secureHome(key, name, 'passkey');
      if (!res.ok) return fail(res.error, 'key-ready');
      setHome(res.home);
      setScreen('receipts');
    } catch (e) {
      fail(e, 'key-ready');
    }
  }

  // Wallet — no key-create step; the wallet prompts (SIWE + deploy/claim) ARE the gestures.
  async function onSecureWithWallet() {
    setVia('wallet');
    setSecuringMsg(`Securing ${base} as your home with your wallet…`);
    setScreen('securing');
    try {
      const res = await secureHome(null, name, 'wallet');
      if (!res.ok) return fail(res.error, 'overview');
      setHome(res.home);
      setScreen('receipts');
    } catch (e) {
      fail(e, 'overview');
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
      const out = await openHome(home.name, via === 'wallet' ? 'wallet' : 'passkey');
      if (!out.ok) return fail(out.error, 'receipts');
      await openSession(out.token, via, true);
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
      const granted = await givePermission(home, api.enroll.delegate, via);
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
          <span className="name-chip-full">{whitelabel.brand.name} Community</span>
          <span className="name-chip-label">{base} home</span>
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
        <p className="onboarding-note">Choose how to secure your home — only you will be able to open it.</p>
        <div className="method-choice">
          {methods.includes('passkey') && (
            <button className="btn-primary" onClick={onCreateKey}>Secure with a passkey</button>
          )}
          {methods.includes('wallet') && (
            <button className="btn-ghost onboarding-secondary" onClick={onSecureWithWallet}>Secure with a wallet</button>
          )}
        </div>
      </Frame>
    );
  }

  if (screen === 'key-ready') {
    return (
      <Frame>
        <OnboardingProgress total={hasApp ? 3 : 2} current={1} label={c.portalStepTitle} />
        <ReceiptCard title="Now only you can sign in or approve" body="Just this device confirms it's you — no password to lose." />
        <h1 className="onboarding-h1">{c.portalStepTitle}</h1>
        <p className="onboarding-sub">
          One more confirmation brings <strong>{base}</strong> to life as your home and claims your name so the {community} can find you.
        </p>
        <button className="btn-primary" onClick={onSecureHome}>{c.portalStepCta}</button>
      </Frame>
    );
  }

  if (screen === 'securing') {
    return (
      <Frame>
        <OnboardingProgress total={hasApp ? 3 : 2} current={1} label={c.portalStepTitle} />
        <div className="onboarding-busy">
          <span className="spinner spinner-lg" role="status" aria-label="Securing your home" />
          <p className="onboarding-busy-msg">{securingMsg}</p>
        </div>
        <div className="securing-explainer">
          <div className="securing-explainer-title">While we set this up</div>
          <p>
            We&apos;re founding <strong>{base}</strong> as your home in the {community} and registering your name —
            permanently yours, on a public record no company controls.
          </p>
          <ul className="securing-points">
            <li><span aria-hidden="true">✓</span> Yours alone — only your device can open it</li>
            <li><span aria-hidden="true">✓</span> A name others in the {community} can find and trust</li>
            <li><span aria-hidden="true">✓</span> No password, nothing to lose — just this device confirms it's you</li>
          </ul>
          <p className="securing-wait">This usually takes about 15 seconds — you can stay on this page.</p>
        </div>
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
