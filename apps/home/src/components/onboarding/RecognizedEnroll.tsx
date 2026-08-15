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
import { givePermission, createOrganization, collectDueSubscriptions, authorizeContentSigningForOwner,
  authorizeServiceAgentWire, activateVaultIfNeeded, isKmsVia, resolveVia, publishSocialConnectionKindIfNeeded, type Via, type Auth } from '../../home/onboarding';
import type { Home } from '../../home/types';
import { whitelabel, fmt } from '../../whitelabel/config';
import { fetchProfile, listManagedAgents, resolveTreasuryByConvention } from '../../connect-client';
import { readSsoCookie, setSsoCookie, clearSsoCookie } from '../../lib/sso-cookie';
import { nameLabel, subdomainHandle, personalAuthOrigin } from '../../lib/domain';
import { recordConnectedApp } from '../../lib/connected-apps';
import { provisionCommunityMessaging } from '../../lib/messaging-ceremony';
import { setFedcmLoginStatus } from '../../context/session';
import { beginEnrollmentGrant, hostOf, submitEnrollGrant, deliverEnrollCode, deliverCollectResult, type EnrollApi, isCeremonyTemplate } from './useEnrollReq';
import { BrandShield } from '../shared/BrandShield';
import { ReceiptCard } from '../shared/ReceiptCard';
import { ConsentSheet } from '../shared/ConsentSheet';
import { OrgChooser, type OrgChoice } from './OrgChooser';

type Phase = 'resolving' | 'choose-org' | 'consent' | 'granting' | 'connected' | 'error';

/** The CAIP-10 tail (`eip155:<chain>:0x…` → `0x…`), or null. Mirrors context/session. */
function addressOf(caip10: string | undefined): Address | null {
  if (!caip10) return null;
  const tail = caip10.split(':').pop();
  return tail && /^0x[0-9a-fA-F]{40}$/.test(tail) ? (tail as Address) : null;
}

/** The `sub` claim of a JWT, by client-side payload decode. Used ONLY to BIND an owner-op to the owner the
 *  relying app authenticated (the real authz is the owner-signed leaf + the a2a calls' server-side
 *  verifyIdToken). Returns undefined when the token is absent or unparseable. */
function idTokenSub(jwt: string | undefined): string | undefined {
  if (!jwt) return undefined;
  try {
    const payload = jwt.split('.')[1];
    if (!payload) return undefined;
    const claims = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as { sub?: unknown };
    return typeof claims.sub === 'string' ? claims.sub : undefined;
  } catch {
    return undefined;
  }
}

export function RecognizedEnroll({ api, onUnrecognized }: { api: EnrollApi; onUnrecognized: () => void }) {
  const c = whitelabel.copy;
  const ran = useRef(false);
  const [phase, setPhase] = useState<Phase>('resolving');
  const [home, setHome] = useState<Home | null>(null);
  const [viaLower, setViaLower] = useState<Via>('passkey');
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  // Chooser-mode org-create (spec 246 select-existing): the enroll carries NO org_base/existing_org —
  // the member picks a stewarded org (grant-only) or names a new one HERE before consenting.
  const [orgSel, setOrgSel] = useState<OrgChoice | null>(null);

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
      // Force the custodian chooser ONCE (clear the active session → credential-first entry) instead of
      // silently reusing whatever session this browser already holds. Critical for multi-custodian admin
      // (each identity has its own SIWE/social/passkey custodian): authorizing demo-validator.impact must
      // never default to the lbsb/deployer custodian's leftover session. Triggers:
      //   • OIDC prompt=select_account/login — the relying app explicitly asked to re-choose.
      //   • a NAMELESS connect-type enroll (`agent_name` omitted on site-login / x402-pay) — the request
      //     pins NO specific home, so we must NOT assume the active session's identity. A PINNED connect
      //     (agent_name set) still one-taps. OWNER-operation templates (org-create / subscription-collect /
      //     content-signer / service-agent-wire) deliberately reuse the recognized owner session, so
      //     they're exempt. MISSING ONE HERE IS SILENT: an owner-op sent with no `agent_name` (which the
      //     nameless connect shape uses) forces the chooser, drops out to `onUnrecognized`, and the request
      //     completes down the ordinary site-login pipeline — one signature, a bare `?code`, and the
      //     ceremony's own branch below never runs. That is what happened to service-agent-wire.
      const ownerOp = enroll.template === 'org-create' || isCeremonyTemplate(enroll.template);
      const forceChooser =
        enroll.prompt === 'select_account' || enroll.prompt === 'login' || (!enroll.name && !ownerOp);
      if (forceChooser) {
        const k = `ap_chooser:${enroll.state || enroll.codeChallenge}`; // per-attempt (state may be empty)
        if (!sessionStorage.getItem(k)) {
          sessionStorage.setItem(k, '1'); // one-time: after the chooser + re-sign-in, proceed normally (no loop)
          clearSsoCookie();
          return onUnrecognized(); // → EntryExperience: wallet/SIWE · Google · YouVersion · passkey
        }
      }
      const sso = readSsoCookie();
      // OWNER ops (content-signer / subscription-collect, spec 266/272) MUST run on a genuine HOME SESSION:
      // it is the authoritative carrier of (a) the SA, (b) the real credential kind (principal.kind → how to
      // sign), and (c) a token that authorizes SERVER-SIDE (social/KMS) leaf signing — uniformly across
      // passkey / social / SIWE. The relying-app `collectToken` is only a BINDING HINT + the downstream a2a
      // bearer, never the identity source (an id_token has no credential kind and can't authorize KMS).
      // No cookie → onUnrecognized → credential-first entry; after sign-in, EntryExperience re-enters the
      // recognized path (Step 3) and we run the ceremony on that fresh home session.
      if (!sso?.token) return onUnrecognized(); // not signed in → credential-first entry
      const profile = await fetchProfile(sso.token).catch(() => null);
      const addr = addressOf(profile?.agent);
      // A valid, DEPLOYED member is required to authorize a delegation; anything else → sign in fresh.
      if (!profile || !addr || profile.deployed === false) return onUnrecognized();
      // ENFORCE the pin: a PINNED connect (agent_name set) is exempt from the forced chooser precisely
      // BECAUSE it names its identity — so the active session MUST actually be that identity. A different
      // leftover session (e.g. a wallet owner-identity from a signer ceremony) must never silently
      // authorize — or sign — for the pinned home (it would flip the relying app's identity AND route
      // signing to the wrong custodian, e.g. MetaMask for a Google home). Mismatch → re-choose credentials.
      const pinned = nameLabel(enroll.name ?? '');
      if (pinned && nameLabel(profile.name ?? '') !== pinned) {
        console.warn('[connect] pinned identity ≠ active session — re-choosing credentials', { pinned, session: profile.name });
        clearSsoCookie();
        return onUnrecognized();
      }
      // BIND the owner-op to the owner the relying app authenticated: the home session's SA MUST equal the
      // `collectToken` subject. Otherwise a relying app could start an owner-op for a DIFFERENT owner than
      // the one it authenticated. Mismatch → reject (the user must sign in as the named owner / decline).
      if (isCeremonyTemplate(enroll.template)) {
        const want = addressOf(idTokenSub(enroll.collectToken));
        if (!want) return fail('This authorization request is missing its owner token.');
        if (want.toLowerCase() !== addr.toLowerCase()) {
          return fail(
            `This authorization is for a different owner than your current session. Sign out and sign back in as the owner of ${want}.`,
          );
        }
      }
      // Sign with the credential that actually authenticated this session (wallet/passkey/KMS), not the
      // cookie's defaulted via — which sent a wallet member to passkey at authorize time.
      const v = resolveVia(profile.credential, sso.via);

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
      // Chooser-mode org-create → ask WHICH org first; everything else goes straight to consent.
      setPhase(enroll.template === 'org-create' && !enroll.orgBase && !enroll.existingOrg ? 'choose-org' : 'consent');
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
        // Same reason as the grant path: the demo-custody probe needs the token on the wallet via.
        const collectAuth: Auth | undefined = token ? { token } : undefined;
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
      // spec 266 delegated content trust — OWNER authorizes each content issuer's Cloud-KMS signing key.
      // No grant: the owner signs, per issuer they custody, the issuer SA → KMS-key delegation; the content
      // service stores it. Reuses the recognized-owner auth + the relying app's collectionConfig.a2aBase.
      if (enroll.template === 'content-signer') {
        const cfg = relyingApp?.collectionConfig;
        if (!cfg) return fail('this app is not configured for content-signer authorization');
        if (!enroll.collectToken) return fail('missing owner token for content-signer authorization');
        // Same reason as the grant path: the demo-custody probe needs the token on the wallet via.
        const csAuth: Auth | undefined = token ? { token } : undefined;
        const res = await authorizeContentSigningForOwner(viaLower, csAuth, { a2aBase: cfg.a2aBase, idToken: enroll.collectToken, targetSigner: enroll.contentSignerTarget });
        if (!res.ok) return fail(res.error);
        setSsoCookie(token, viaLower);
        setPhase('connected');
        setTimeout(() => deliverCollectResult(enroll, api.popupMode, { collected: res.authorized, attempted: res.attempted }, 'content-signer'), 900);
        return;
      }
      // agent-rule `service-agent-signing.md` — the custodian of a named agent authorizes a relying
      // service's KMS key to sign AS it. No grant is minted here: what the ceremony produces is a
      // WIRE the service stores, so the service holds a revocable delegate and never the identity.
      if (enroll.template === 'service-agent-wire') {
        const cfg = relyingApp?.serviceAgentConfig;
        if (!cfg) return fail('this app is not configured for service-agent authorization');
        if (!enroll.collectToken) return fail('missing owner token for service-agent authorization');
        // Same reason as the grant path: the demo-custody probe needs the token on the wallet via.
        const swAuth: Auth | undefined = token ? { token } : undefined;
        const res = await authorizeServiceAgentWire(viaLower, swAuth, { a2aBase: cfg.a2aBase, idToken: enroll.collectToken });
        if (!res.ok) return fail(res.error);
        setSsoCookie(token, viaLower);
        setPhase('connected');
        setTimeout(() => deliverCollectResult(enroll, api.popupMode, { collected: 1, attempted: 1 }, 'service-agent-wire'), 900);
        return;
      }
      // SEC-001: server-mint the grant FIRST; use the registry-derived delegate (anti-spoof).
      const { grant_id, delegate } = await beginEnrollmentGrant(enroll, home.name);
      /*
        PASS THE SESSION TOKEN FOR EVERY CREDENTIAL, not only the KMS ones.

        `signHashFor` uses it two ways, and gating on `isKmsVia` served only the first:
          KMS   — the token IS the signer.
          WALLET — the token runs the DEMO-CUSTODY probe. A seeded demo person has a wallet
            CREDENTIAL whose key this Home holds and a browser with no wallet, so
            `isDemoCustodyHome(token)` is what routes them to a prompt-free server-side signature.

        Withholding it left `auth?.token` undefined, the probe never ran, and the wallet branch fell
        through to the injected provider — "No Ethereum wallet found" at the last click of a ceremony
        for an account whose key cannot be in that browser.

        Real wallet homes are unaffected: the probe answers false once per session and falls through.
      */
      const auth: Auth | undefined = token ? { token } : undefined;

      let code: string;
      if (enroll.template === 'org-create') {
        // ORG-CREATE for a RECOGNIZED member (e.g. a facilitator org for demo-jp). This component is
        // reached for a NAMELESS enroll (spec 257 §11) — including org-create — but previously ran ONLY
        // the site-login pipeline below, submitting `org=undefined`. The relying app's /token then
        // returned no org → demo-jp threw "no organization returned from your home" even though the
        // request WAS an org-create (no org was ever deployed). Deploy the org custodied by this member
        // and submit the grant WITH the org payload (KMS → bootstrap-org; the descriptor build is
        // non-fatal per #295). One mechanism, no fallback (ADR-0013). Gated by TEMPLATE, not org_base:
        // a chooser-mode request carries no org_base — the choose-org step above resolved `orgSel`.
        const orgBase = enroll.orgBase ?? orgSel?.orgName;
        const existingOrg = enroll.existingOrg ?? orgSel?.existingOrg;
        // SELECT-EXISTING CARRIES NO NAME. `existing_org` names the organization by ADDRESS and
        // deploys nothing — there is no name to claim, which is the whole point — so requiring
        // `orgBase` refused every select-existing request from the recognized path with "No
        // organization was chosen" while the chosen organization sat in the URL. `createOrganization`
        // handles the existing branch first and uses `base` only as the link's display name.
        if (!orgBase && !existingOrg) return fail('No organization was chosen for this request.');
        const created = await createOrganization(
          home,
          orgBase ?? '',
          delegate,
          viaLower,
          auth,
          { purpose: enroll.purpose, requestedBy: enroll.aud, grantOrg: enroll.grantOrg, existingOrg },
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
        } catch (e) {
          console.warn('[connect] listManagedAgents failed (treasury projection unavailable):', e);
          treasuryAddr = null;
        }
        // Projection miss → reconcile from the authoritative naming registry (`<label>-treasury.<tld>`).
        if (!treasuryAddr) {
          treasuryAddr = await resolveTreasuryByConvention(home.name);
          if (treasuryAddr) console.warn('[connect] person-treasury reconciled from ANS (projection was stale):', treasuryAddr);
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
      // spec 278 — bind the member's per-person vault key during connect, for EVERY custody type. A
      // relying-app-first member (connects here, never runs the full journey / the /vault-key portal) would
      // otherwise have NO binding, so their first vault read/write at the relying app fails closed with
      // vault_key_unauthorized. KMS (social) signs server-side (no gesture); wallet/passkey sign their own
      // VaultKeyAuthorization on-device — ONE extra signature at connect (the deliberate "custodian backs all
      // authority" tradeoff). Idempotent (skipped if already bound) + best-effort (a vault hiccup never blocks
      // the connect — the delegation is already minted, and /vault-key + the journey remain as a re-bind path).
      // Same reason: the vault-key ceremony signs, so a wallet-credential demo home needs the token.
      try { await activateVaultIfNeeded(home.address, viaLower, token ? { token } : undefined); }
      catch (e) { console.warn('[connect] vault-key activation failed (non-fatal — vault reads will 401 until bound):', e); }
      // Same consent as connect: storage, delivery, and a wire covering communities they
      // already belong to — so the first send from the app is not a second ceremony.
      if (token && (enroll.template === 'site-login' || enroll.aud === 'commons-app')) {
        try {
          const orgs = await listManagedAgents(token);
          for (const o of orgs.filter((a) => a.kind === 'org')) {
            await provisionCommunityMessaging({
              person: home.address,
              org: o.agent,
              via: viaLower,
              token,
            });
          }
        } catch (e) {
          console.warn('[connect] community messaging provision failed (non-fatal):', e);
        }
      }
      // spec 280 carve-out — self-heal the published connection KIND on every successful social connect
      // (idempotent, gasless, kind-only) so a named social home stops being EOA-ambiguous at re-entry.
      if (isKmsVia(viaLower)) void publishSocialConnectionKindIfNeeded(home.address, home.name, viaLower, { token });
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

  if (phase === 'choose-org') {
    return (
      <Shell>
        <OrgChooser
          token={token}
          appHost={appHost}
          onChoose={(c) => { setOrgSel(c); setPhase('consent'); }}
          onDecline={onDecline}
        />
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
        {enroll.template === 'org-create' && (enroll.orgBase ?? orgSel?.orgName) && (
          <p className="onboarding-sub">
            Organization: <strong>{enroll.orgBase ?? orgSel?.orgName}</strong>
            {(enroll.existingOrg ?? orgSel?.existingOrg) ? ' — existing; no new org is created.' : ' — new.'}
          </p>
        )}
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
        <button className="btn-ghost onboarding-secondary" onClick={() => { clearSsoCookie(); onUnrecognized(); }}>
          Not {home?.name || 'you'}? Use a different custodian
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
