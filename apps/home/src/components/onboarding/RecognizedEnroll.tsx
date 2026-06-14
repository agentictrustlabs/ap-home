'use client';
// Recognized-member fast-path for a relying-app site-login enroll (extends the ADR-0032 custody
// boundary to the redirect path). An ALREADY-AUTHENTICATED member arriving at a connect request is
// recognized from the cross-subdomain `ap_sso` cookie — no "Welcome / sign in or get started". We
// authorize in ONE step, routing by custody:
//
//   • Google/KMS or wallet — signing is origin-agnostic (server-side KMS, or MetaMask personalSign)
//     → authorize HERE, on whatever Connect origin the enroll landed on.
//   • passkey — the credential's rpId IS the home subdomain (`lib/passkey.ts`: rpId = hostname, and
//     that rpId is even mixed into the SA's CREATE2 salt), so it can ONLY sign on `<label>.<domain>`.
//     If we're not already there, hop to the home subdomain carrying the enroll params; the passkey
//     then signs locally. One tap, no re-login.
//
// On authorize we run the SAME grant pipeline as GoogleEnrollResume:
//   beginEnrollmentGrant → givePermission(via) → submitEnrollGrant → deliverEnrollCode.
//
// Recognition is best-effort: a missing/stale cookie (no session, undeployed SA, fetch fail) calls
// `onUnrecognized()` and the caller falls back to the credential-first entry (ADR-0013 — one explicit
// fallback, never a silent second mechanism).
import { useEffect, useRef, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { givePermission, createOrganization, collectDueSubscriptions, isKmsVia, type Via, type Auth } from '../../home/onboarding';
import type { Home } from '../../home/types';
import { whitelabel, fmt } from '../../whitelabel/config';
import { fetchProfile, listManagedAgents } from '../../connect-client';
import { readSsoCookie, setSsoCookie } from '../../lib/sso-cookie';
import { nameLabel, subdomainHandle, personalAuthOrigin } from '../../lib/domain';
import { recordConnectedApp } from '../../lib/connected-apps';
import { setFedcmLoginStatus } from '../../context/session';
import { beginEnrollmentGrant, hostOf, submitEnrollGrant, deliverEnrollCode, deliverCollectResult, type EnrollApi } from './useEnrollReq';
import { BrandShield } from '../shared/BrandShield';
import { ReceiptCard } from '../shared/ReceiptCard';
import { ConsentSheet } from '../shared/ConsentSheet';

type Phase = 'resolving' | 'consent' | 'granting' | 'connected' | 'error';

/** The CAIP-10 tail (`eip155:<chain>:0x…` → `0x…`), or null. Mirrors context/session. */
function addressOf(caip10: string | undefined): Address | null {
  if (!caip10) return null;
  const tail = caip10.split(':').pop();
  return tail && /^0x[0-9a-fA-F]{40}$/.test(tail) ? (tail as Address) : null;
}

/** Pick the signing credential from how the session ACTUALLY authenticated
 *  (`profile.credential` = session.principal.kind: `siwe-eoa` | `passkey` | `google` | `youversion`),
 *  NOT a stale/generic cookie `via` — which defaulted to passkey and forced passkey signing even for a
 *  wallet home. Falls back to the cookie hint, then passkey, only when the kind is unrecognized. */
function viaFromCredential(credential: string | undefined, cookieVia: string | undefined): Via {
  const c = (credential || '').toLowerCase();
  if (c.includes('passkey')) return 'passkey';
  if (c.includes('siwe') || c.includes('eoa') || c.includes('wallet')) return 'wallet';
  if (c.includes('youversion')) return 'youversion';
  if (c.includes('google')) return 'google';
  const v = (cookieVia || '').toLowerCase();
  return v === 'wallet' || v === 'google' || v === 'youversion' || v === 'passkey' ? (v as Via) : 'passkey';
}

export function RecognizedEnroll({ api, onUnrecognized }: { api: EnrollApi; onUnrecognized: () => void }) {
  const c = whitelabel.copy;
  const ran = useRef(false);
  const [phase, setPhase] = useState<Phase>('resolving');
  const [home, setHome] = useState<Home | null>(null);
  const [viaLower, setViaLower] = useState<Via>('passkey');
  const [token, setToken] = useState('');
  const [error, setError] = useState('');

  const enroll = api.enroll;
  const relyingApp = enroll ? whitelabel.relyingApps.find((a) => a.client_id === enroll.aud) : undefined;
  const appHost = enroll ? hostOf(enroll.redirectUri) : '';
  const appName = relyingApp?.name ?? appHost;

  const fail = (e: unknown) => {
    setError(e instanceof Error ? e.message : typeof e === 'string' ? e : 'Something went wrong');
    setPhase('error');
  };

  // Recover the session from the cross-subdomain cookie, resolve the member, and route by custody.
  useEffect(() => {
    if (ran.current || !enroll) return;
    ran.current = true;
    void (async () => {
      const sso = readSsoCookie();
      if (!sso?.token) return onUnrecognized(); // not signed in → credential-first entry
      const profile = await fetchProfile(sso.token).catch(() => null);
      const addr = addressOf(profile?.agent);
      // A valid, DEPLOYED member is required to authorize a delegation; anything else → sign in fresh.
      if (!profile || !addr || profile.deployed === false) return onUnrecognized();
      // Sign with the credential that actually authenticated this session (wallet/passkey/KMS), not the
      // cookie's defaulted via — which sent a wallet member to passkey at authorize time.
      const v = viaFromCredential(profile.credential, sso.via);

      // passkey is rpId-bound to the home subdomain — hop there if we're not already on it (the passkey
      // can't assert at the apex). Google/KMS + wallet sign on any origin, so they authorize in place.
      const label = nameLabel(profile.name ?? '');
      if (v === 'passkey') {
        if (!label) return onUnrecognized(); // passkey with no resolvable home — can't route, sign fresh
        if (subdomainHandle() !== label) {
          // Carry the enroll params across the hop so the subdomain re-enters enroll mode + recognizes us.
          window.location.href = personalAuthOrigin(label) + '/' + window.location.search;
          return;
        }
      }
      setHome({ address: addr, name: profile.name ?? '' });
      setViaLower(v);
      setToken(sso.token);
      setPhase('consent');
    })();
  }, [enroll, onUnrecognized]);

  async function onAuthorize() {
    if (!enroll || !home) return;
    setPhase('granting');
    try {
      // spec 272 recurring — OWNER subscription collection. No grant/delegation: the owner signs the
      // redemption of every DUE subscriber's standing pull mandate AS the collection treasury they custody,
      // then we deliver the result back to the owner app. Reuses the recognized-owner auth resolved above.
      if (enroll.template === 'subscription-collect') {
        const cfg = relyingApp?.collectionConfig;
        if (!cfg) return fail('this app is not configured for subscription collection');
        if (!enroll.collectToken) return fail('missing owner token for collection');
        const collectAuth: Auth | undefined = isKmsVia(viaLower) ? { token } : undefined;
        const res = await collectDueSubscriptions(
          cfg.treasury as Address, viaLower, collectAuth,
          { asset: cfg.asset as Address, edition: cfg.edition, a2aBase: cfg.a2aBase, idToken: enroll.collectToken },
        );
        if (!res.ok) return fail(res.error);
        setSsoCookie(token, viaLower);
        setPhase('connected');
        setTimeout(() => deliverCollectResult(enroll, api.popupMode, { collected: res.collected, attempted: res.attempted }), 900);
        return;
      }
      // SEC-001: server-mint the grant FIRST; use the registry-derived delegate (anti-spoof).
      const { grant_id, delegate } = await beginEnrollmentGrant(enroll, home.name);
      const auth: Auth | undefined = isKmsVia(viaLower) ? { token } : undefined;

      let code: string;
      if (enroll.orgBase) {
        // ORG-CREATE for a RECOGNIZED member (e.g. a facilitator org for demo-jp). This component is
        // reached for a NAMELESS enroll (spec 257 §11) — including org-create — but previously ran ONLY
        // the site-login pipeline below, submitting `org=undefined`. The relying app's /token then
        // returned no org → demo-jp threw "no organization returned from your home" even though the
        // request WAS an org-create (no org was ever deployed). Deploy the org custodied by this member
        // and submit the grant WITH the org payload (KMS → bootstrap-org; the descriptor build is
        // non-fatal per #295). One mechanism, no fallback (ADR-0013).
        const created = await createOrganization(
          home,
          enroll.orgBase,
          delegate,
          viaLower,
          auth,
          { purpose: enroll.purpose, requestedBy: enroll.aud, grantOrg: enroll.grantOrg },
        );
        if (!created.ok) return fail(created.error);
        code = await submitEnrollGrant(grant_id, created.grant, created.org, undefined);
      } else {
        // SITE-LOGIN — spec 270 v4 W2: sign + carry the DEL-001 leaf for the relying app's session key.
        // spec 272/243 — x402-pay: a recognized member already has a home session `token` in hand, so
        // resolve their PRE-CREATED person-treasury (approach A) and authorize a capped `treasury →
        // lbsb-treasury` payment delegation in the SAME ceremony. No treasury → connect without payment.
        let payment:
          | { treasury: Address; payee: Address; asset: Address; maxAmountPerCharge: bigint; maxAggregate: bigint; maxRedemptionsPerWindow?: number; windowSeconds?: number; mode?: 'push' | 'pull'; chargeNow?: boolean; chargeAmount?: bigint; edition?: string; subscription?: { periodSeconds: number; periods?: number } }
          | undefined;
        const pc = relyingApp?.paymentConfig;
        // Resolve the member's PRE-CREATED person-treasury ONCE for any connect (a recognized member has
        // a home session `token` in hand). Surfaced to the relying app as `treasury` so it can gate ALL
        // financial ops up front — a member with no treasury is told to create one, not shown a Buy-access
        // flow that silently no-ops. A social member with no treasury yet resolves to null here.
        let treasuryAddr: Address | null = null;
        try {
          treasuryAddr = ((await listManagedAgents(token)).find((a) => a.kind === 'person-treasury')?.agent as Address) ?? null;
        } catch {
          treasuryAddr = null;
        }
        // ALL custodians (wallet / passkey / social-KMS) — the charge is signed via signHashFor, which
        // handles every credential. With no treasury we connect without payment and the app surfaces
        // "create a treasury" rather than attempting a charge.
        if (enroll.template === 'x402-pay' && pc && treasuryAddr) {
          // spec 272 — charge the tier amount the relying app requested (enroll.payAmount), CAPPED by the
          // client's registered per-charge max. Defaults to the max (≈ pay-as-you-go) when unspecified.
          const cap = BigInt(pc.maxAmountPerCharge);
          const req = enroll.payAmount ? BigInt(enroll.payAmount) : cap;
          const amt = req < cap ? req : cap;
          payment = {
            treasury: treasuryAddr,
            payee: pc.payee,
            asset: pc.asset,
            maxAmountPerCharge: BigInt(pc.maxAmountPerCharge),
            maxAggregate: BigInt(pc.maxAggregate),
            maxRedemptionsPerWindow: pc.maxRedemptionsPerWindow,
            windowSeconds: pc.windowSeconds,
            mode: pc.mode,
            // CHARGE the first payment in this ceremony (all-custodian) → settlementHash → app mints a pass.
            chargeNow: true,
            chargeAmount: amt,
            edition: 'lbsb',
            // spec 272 recurring — a SUBSCRIPTION connect (sub_period set): also mint a standing pull mandate.
            subscription: enroll.subPeriod ? { periodSeconds: enroll.subPeriod } : undefined,
          };
        }
        const granted = await givePermission(home, delegate, viaLower, auth, enroll.sessionKey, payment);
        if (!granted.ok) return fail(granted.error);
        code = await submitEnrollGrant(grant_id, granted.grant, undefined, granted.sessionDelegation, granted.paymentDelegation, granted.settlementHash, treasuryAddr, granted.pullDelegation);
      }
      // Refresh the cross-subdomain session + FedCM signal (the member is still signed in here).
      setSsoCookie(token, viaLower);
      setFedcmLoginStatus('logged-in');
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
      setTimeout(() => deliverEnrollCode(enroll, api.popupMode, code), 1100);
    } catch (e) {
      fail(e);
    }
  }

  function onDecline() {
    if (enroll) deliverEnrollCode(enroll, api.popupMode, ''); // empty code → relying app treats as cancel
  }

  if (!enroll) return null;

  if (phase === 'resolving') {
    return (
      <Shell>
        <div className="onboarding-busy">
          <span className="spinner spinner-lg" role="status" aria-label="Recognizing you" />
          <p className="onboarding-busy-msg">Welcome back — getting your home…</p>
        </div>
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

  // consent — recognized; one tap to authorize as yourself (no re-login).
  const tpl =
    whitelabel.delegationTemplates[enroll.template] ?? {
      canDo: [],
      cannotDo: ['Move your funds', 'Add sign-in methods', 'Change your recovery'],
    };
  return (
    <div className="onboarding-screen">
      <div className="onboarding-card wide">
        <p className="onboarding-sub">Signed in as <strong>{home?.name || 'your home'}</strong>.</p>
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
        <button className="btn-ghost onboarding-secondary" onClick={onUnrecognized}>
          Not {home?.name || 'you'}? Use a different account
        </button>
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
