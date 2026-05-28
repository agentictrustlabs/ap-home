'use client';
// The onboarding first-run journey. Three understandable VALUE steps backed by the FEWEST
// device prompts (value-steps ≠ signatures): the WebAuthn create + the deploy/claim are each
// button-gated (a fresh user gesture per prompt — never two back-to-back); the deploy/claim is
// ONE batched userOp that yields TWO receipts (Portal live + community name). App-grant is the
// one separate consent. Wraps the preserved primitives (createSecureHomePasskey →
// deployAndClaimAgent → issueSiteDelegation → submitGrant → deliverCode).
import { useRef, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { createSecureHomePasskey, deployAndClaimAgent, connectWithName, passkeySignHash } from '../../connect-client';
import { issueSiteDelegation, toWire } from '../../lib/delegation';
import { recordConnectedApp } from '../../lib/connected-apps';
import { whitelabel, fmt } from '../../whitelabel/config';
import { useSession } from '../../context/session';
import type { DemoPasskey } from '../../lib/passkey';
import type { EnrollApi, EnrollReq } from './useEnrollReq';
import { BrandShield } from '../shared/BrandShield';
import { ValueStepList, type ValueStep } from '../shared/ValueStepList';
import { OnboardingProgress } from '../shared/OnboardingProgress';
import { ReceiptCard } from '../shared/ReceiptCard';
import { ConsentSheet } from '../shared/ConsentSheet';

const EXPLORER = 'https://sepolia.basescan.org/address/';

export type JourneyVariant = 'enroll-new' | 'enroll-existing' | 'self-serve';

type Screen = 'arrival' | 'overview' | 'key-ready' | 'receipts' | 'grant' | 'connected' | 'error';

export function OnboardingJourney({
  variant,
  name,
  api,
  existingAgent,
}: {
  variant: JourneyVariant;
  name: string; // full or label form
  api?: EnrollApi; // present for enroll-* variants
  existingAgent?: Address; // present for enroll-existing (skip setup → grant)
}) {
  const { openSession } = useSession();
  const c = whitelabel.copy;
  const community = whitelabel.brand.community;
  const appHost = api?.host ?? '';
  const hasApp = variant !== 'self-serve';
  const base = name.replace(/\.demo\.agent$/, '');

  const [screen, setScreen] = useState<Screen>(variant === 'enroll-existing' ? 'grant' : 'arrival');
  const [busy, setBusy] = useState<string | null>(null);
  const [passkey, setPasskey] = useState<DemoPasskey | null>(null);
  const [agent, setAgent] = useState<Address | null>(existingAgent ?? null);
  const [claimedName, setClaimedName] = useState<string>(name);
  const [error, setError] = useState<string>('');
  const failBack = useRef<Screen>('overview');

  const fail = (e: unknown, back: Screen) => {
    setBusy(null);
    setError(e instanceof Error ? e.message : 'Something went wrong');
    failBack.current = back;
    setScreen('error');
  };

  // ① create the secure key (prompt 1) — gated behind the Overview CTA (user gesture).
  async function onCreateKey() {
    setBusy('Creating your secure key…');
    try {
      const pk = await createSecureHomePasskey(name);
      setPasskey(pk);
      setBusy(null);
      setScreen('key-ready');
    } catch (e) {
      fail(e, 'overview');
    }
  }

  // ① + ② deploy the Portal + claim the community name in ONE userOp (prompt 2).
  async function onCreatePortal() {
    if (!passkey) return;
    setBusy(c.portalStepBusy);
    try {
      const res = await deployAndClaimAgent(passkey, base);
      if (!res.ok) return fail(res.error, 'key-ready');
      setAgent(res.agent);
      setClaimedName(res.name);
      setBusy(null);
      setScreen('receipts');
    } catch (e) {
      fail(e, 'key-ready');
    }
  }

  // After the receipts: relying-app → grant consent; self-serve → sign in + land in portal.
  async function onContinueFromReceipts() {
    if (hasApp) {
      setScreen('grant');
      return;
    }
    // self-serve: prove control → open a portal session (the gate swaps to the PortalShell).
    setBusy('Signing you in…');
    try {
      const out = await connectWithName(claimedName, 'passkey'); // prompt 3 (self-serve)
      if (!out.ok) return fail(out.error, 'receipts');
      await openSession(out.token, 'passkey', true);
    } catch (e) {
      fail(e, 'receipts');
    }
  }

  // ③ authorize the relying app: sign the scoped delegation (prompt 3) → grant → deliver code.
  async function onAuthorize() {
    if (!api?.enroll || !agent) return;
    setBusy(fmt(c.authorizeStepBusy, { app: appHost }));
    api.postToOpener?.({ type: 'AC_PROGRESS', msg: 'Connecting the app…' });
    try {
      const delegation = await issueSiteDelegation(agent, api.enroll.delegate, passkeySignHash);
      const code = await api.submitGrant(claimedName, toWire(delegation));
      // Mirror the grant locally so Connected Apps can show it (canonical record is on-chain).
      const tpl = whitelabel.delegationTemplates[api.enroll.template];
      recordConnectedApp(agent, {
        clientId: api.enroll.aud,
        appName: appHost,
        appDomain: appHost,
        logo: whitelabel.relyingApps.find((a) => a.client_id === api.enroll!.aud)?.logo,
        canDo: tpl?.canDo ?? [],
        cannotDo: tpl?.cannotDo ?? [],
        grantedAt: Date.now(),
        expiresAt: tpl?.expiryDays ? Date.now() + tpl.expiryDays * 86_400_000 : undefined,
      });
      setBusy(null);
      setScreen('connected');
      setTimeout(() => api.deliverCode(code), 1100); // hold the receipt, then hand back
    } catch (e) {
      fail(e, 'grant');
    }
  }

  // ── Busy overlay (a device prompt / on-chain op in flight) ──
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
          <span className="name-chip-full">{whitelabel.domains.nameParent ? `${base}.${whitelabel.domains.nameParent}` : base}</span>
        </div>
        <button className="btn-primary" onClick={() => setScreen('overview')}>Get started</button>
      </Frame>
    );
  }

  if (screen === 'overview') {
    const steps: ValueStep[] = [
      { id: 'portal', title: c.portalStepTitle, body: c.portalStepValue, status: 'active' },
      { id: 'community', title: c.communityStepTitle, body: c.communityStepValue, status: 'pending' },
      ...(hasApp
        ? [{ id: 'authorize', title: fmt(c.authorizeStepTitle, { app: appHost }), body: fmt(c.authorizeStepValue, { app: appHost }), status: 'pending' as const }]
        : [{ id: 'later', title: 'Apps you authorize later', body: `Connect apps to your portal anytime from Connected Apps.`, status: 'pending' as const }]),
    ];
    return (
      <Frame>
        <h1 className="onboarding-h1">{c.overviewTitle}</h1>
        <ValueStepList steps={steps} />
        <p className="onboarding-note">Steps ① and ② happen together — one confirmation, two milestones.</p>
        <button className="btn-primary" onClick={onCreateKey}>{c.portalStepCta}</button>
      </Frame>
    );
  }

  if (screen === 'key-ready') {
    return (
      <Frame>
        <OnboardingProgress total={hasApp ? 3 : 2} current={1} label={c.portalStepTitle} />
        <ReceiptCard title="Secure key created on this device" />
        <h1 className="onboarding-h1">{c.portalStepTitle}</h1>
        <p className="onboarding-sub">
          {c.portalStepValue} One confirmation brings <strong>{base}</strong> to life and claims your place in the {community}.
        </p>
        <button className="btn-primary" onClick={onCreatePortal}>Create my Portal</button>
      </Frame>
    );
  }

  if (screen === 'receipts') {
    return (
      <Frame>
        <OnboardingProgress total={hasApp ? 3 : 2} current={2} label={c.communityStepTitle} />
        <div className="celebrate">
          <BrandShield size={52} />
          <h1 className="onboarding-h1">Your portal is ready</h1>
        </div>
        <ReceiptCard
          title={c.portalStepReceipt}
          body="Deployed on Base Sepolia"
          detail={agent ?? undefined}
          explorerUrl={agent ? EXPLORER + agent : undefined}
        />
        <ReceiptCard title={fmt(c.communityStepReceipt, { name: claimedName })} body={claimedName} />
        <button className="btn-primary" onClick={onContinueFromReceipts}>Continue</button>
      </Frame>
    );
  }

  if (screen === 'grant' && api?.enroll) {
    const tpl = whitelabel.delegationTemplates?.[api.enroll.template] ?? { canDo: [], cannotDo: ['Move your funds', 'Add sign-in methods', 'Change your recovery'] };
    return (
      <Frame wide>
        <OnboardingProgress total={3} current={3} label="Authorize the app" />
        <ConsentSheet
          title={fmt(c.authorizeStepTitle, { app: appHost })}
          appName={appHost}
          appDomain={appHost}
          appLogo={whitelabel.relyingApps.find((a) => a.client_id === api.enroll!.aud)?.logo}
          template={tpl}
          authorizeLabel={fmt(c.authorizeStepCta, { app: appHost })}
          onAuthorize={onAuthorize}
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
          <h1 className="onboarding-h1">Connected</h1>
        </div>
        <ReceiptCard title={fmt(c.authorizeStepReceipt, { app: appHost })} />
        <p className="onboarding-sub">Returning you to {appHost}…</p>
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
