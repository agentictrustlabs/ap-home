'use client';
// /choose-treasury — the FOCUSED money-account ceremony an app sends a member to.
//
// THE PROBLEM IT REPLACES. An app that needs the member to have a personal treasury before it can
// touch money could only deep-link to `/treasuries`, the full stewardship dashboard — trust graph,
// attestations, organizations, org treasuries — to press one button. A person who has never done
// this before does not press the button; they read four sections they were not asked about and
// leave. So the ceremony gets its own screen, scoped to exactly one decision, and lives OUTSIDE the
// `(portal)` route group for the same reason `/handoff` and `/link` do: the portal gate would
// render the dashboard around it.
//
// THE REQUEST, in the shape the authorize flow already uses:
//
//   /choose-treasury?client_id=…&redirect_uri=…&state=…[&label=…]
//
//   client_id     WHO is asking. Resolved through the SAME registry every other gate uses —
//                 curated white-label entries first, then member registrations
//                 (`primeRelyingClient` → `/connect/client-info` → `server/_lib/oidc-registry`).
//   redirect_uri  WHERE the answer goes. EXACT match against that client's registered
//                 redirect_uris (CN-1) — the identical predicate `clientAllowsRedirect` applies at
//                 `/oidc/authorize-grant` and `/token`. Not an origin check: an origin check is the
//                 looser thing this convention exists to refuse.
//   state         Opaque to us, echoed back unchanged.
//   label         OPTIONAL. A name the app suggests for a NEW account. A prefill and nothing more —
//                 nameless is legitimate and is the default (the address is the canonical id).
//
// FAIL CLOSED, AND BEFORE ANYTHING IS SHOWN. Both checks run before the screen renders anything
// about the app or the member. A failure names the check that failed and STOPS — it does not
// redirect, not even to the URI it just refused, because a redirect to an unverified `redirect_uri`
// is precisely the open redirect CN-1 exists to prevent. There is nowhere safe to send them, so we
// send them nowhere and say so.
//
// THE ANSWER GOES BACK the way the authorize flow returns its own: a full-page redirect to the
// registered `redirect_uri` carrying the result plus `state` unchanged.
//
//   success   ?treasury=0x…&treasury_status=chosen|created&state=…
//   declined  ?treasury_error=denied&state=…            (mirrors the enroll deny's `enroll_error`)
//
// No `postMessage` half, unlike `deliverEnrollCode`: the app opens this ceremony with
// `window.open(…, 'noopener')`, which severs the opener by design, so a redirect is the only
// channel that actually exists. And no `ac_iss` — nothing here is exchanged for a token, so there
// is no issuer for the app to pin.
//
// WHAT THIS CEREMONY IS NOT. It grants the app nothing. It answers "which account is yours", and
// the app must still ask the member — separately, by name and by amount — before anything moves.
// That is why this screen never says "allow": the sign-in screen a moment earlier said "Allow
// <app>?", and two screens in a row asking the same question are two screens a person cannot tell
// apart.
import { useEffect, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { SessionProvider, useSession } from '../../src/context/session';
import { EntryExperience } from '../../src/components/onboarding/EntryExperience';
import { TreasuryChooser, type TreasuryChoice } from '../../src/components/onboarding/TreasuryChooser';
import { BrandShield } from '../../src/components/shared/BrandShield';
import type { OidcClient } from '../../src/lib/oidc-clients';
import { knownRelyingClient, primeRelyingClient } from '../../src/lib/relying-clients';
// The two decisions this ceremony makes — may it proceed, and where does the member leave — are
// pure, so they live in `lib/treasury-ceremony.ts` with their tests rather than inside this tree.
import {
  parseTreasuryRequest,
  refusalFor,
  treasuryReturnUrl,
  type TreasuryRefusal,
  type TreasuryRequest,
} from '../../src/lib/treasury-ceremony';
import { whitelabel } from '../../src/whitelabel/config';

type Check =
  | { k: 'checking' }
  | { k: 'ok'; req: TreasuryRequest; client: OidcClient }
  | { k: 'refused'; refusal: TreasuryRefusal };

/** The one card every state of this ceremony renders inside — same shell as `/link` and `/handoff`. */
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="onboarding-screen">
      <div className="onboarding-card">
        <div style={{ display: 'flex', alignItems: 'center', gap: '.5rem', alignSelf: 'flex-start' }}>
          <BrandShield size={28} />
          <strong style={{ fontWeight: 800, color: 'var(--color-text-primary)' }}>{whitelabel.brand.name}</strong>
        </div>
        {children}
      </div>
    </div>
  );
}

/**
 * The refusal. It names the check, and it goes nowhere.
 *
 * Saying WHICH check failed is not a leak — the person arrived carrying both values in their own
 * URL bar — and it is the only version of this screen a developer can act on. What it must never
 * do is offer a way onward: there is no verified destination, and "go back to the app" here would
 * mean trusting the `redirect_uri` that just failed to verify.
 */
function Refused({ refusal }: { refusal: TreasuryRefusal }) {
  const said =
    refusal.check === 'params'
      ? 'The request was missing something it needs.'
      : refusal.check === 'client_id'
        ? `${whitelabel.brand.name} does not recognise the app that sent you here.`
        : 'That app is registered, but not for the address it asked us to send you back to.';
  return (
    <Shell>
      <h1 className="onboarding-h1">We didn&apos;t open this</h1>
      <p className="onboarding-sub">{said}</p>
      <p className="onboarding-sub">
        Nothing has happened to your money or your home, and we have not sent you anywhere. If you
        were setting something up, go back to the app you started from and try again from there.
      </p>
      <p className="onboarding-hint" data-testid="refusal-detail">
        Refused at: <strong>{refusal.check}</strong> — {refusal.detail}
      </p>
    </Shell>
  );
}

function Body() {
  const { phase, session, agentAddress } = useSession();
  const [check, setCheck] = useState<Check>({ k: 'checking' });
  const [leaving, setLeaving] = useState(false);

  // VALIDATE FIRST, RENDER SECOND. Nothing about the app or the member reaches the screen until
  // both gates have passed — a screen that shows "Poker Night is asking…" while it is still
  // deciding whether Poker Night is real has already told the person the wrong thing.
  useEffect(() => {
    const req = parseTreasuryRequest(window.location.href);
    if (!req) {
      setCheck({ k: 'refused', refusal: refusalFor(null, null)! });
      return;
    }
    let live = true;
    // Curated entries answer synchronously; a member-registered client needs the lookup. Resolve
    // BEFORE deciding — refusing a perfectly well registered app because a fetch had not returned
    // yet is an accusation the person cannot act on (the same rule `useEnrollReq` follows).
    void primeRelyingClient(req.clientId).then(() => {
      if (!live) return;
      const client = knownRelyingClient(req.clientId);
      const refusal = refusalFor(req, client);
      if (refusal) setCheck({ k: 'refused', refusal });
      // `refusalFor` returning null already established the client resolved — the assertion states
      // that, rather than adding a second `!client` branch that could disagree with the gate.
      else setCheck({ k: 'ok', req, client: client! });
    });
    return () => { live = false; };
  }, []);

  function leave(href: string) {
    setLeaving(true);
    window.location.href = href;
  }

  if (check.k === 'checking') {
    return (
      <Shell>
        <div className="onboarding-busy">
          <span className="spinner spinner-lg" role="status" aria-label="Checking the request" />
          <p className="onboarding-busy-msg">Checking who sent you…</p>
        </div>
      </Shell>
    );
  }
  if (check.k === 'refused') return <Refused refusal={check.refusal} />;

  // The member's own home session, exactly as the other ceremony pages require it. Absent is not an
  // error — it means they have not signed in on this device yet, so run the sign-in ceremony the
  // Home already has, in place, and this screen renders itself the moment a session exists.
  //
  // KNOWN EDGE, stated rather than papered over: a PASSKEY member signing in from the apex is sent
  // to their own `<label>` home subdomain by that ceremony (the passkey RP ID is per-member), and
  // lands in their home rather than back here. Their session is shared across the zone, so
  // re-following the app's link finishes in one tap. Every other credential family — wallet,
  // Google, YouVersion, email, phone — resolves in place and returns to this screen.
  if (phase === 'restoring') {
    return (
      <Shell>
        <div className="onboarding-busy">
          <span className="spinner spinner-lg" role="status" aria-label="Opening your home" />
          <p className="onboarding-busy-msg">Opening your home…</p>
        </div>
      </Shell>
    );
  }
  if (phase !== 'authed' || !session?.token || !agentAddress) return <EntryExperience mode="entry" />;

  if (leaving) {
    return (
      <Shell>
        <div className="onboarding-busy">
          <span className="spinner spinner-lg" role="status" aria-label="Returning to the app" />
          <p className="onboarding-busy-msg">Taking you back…</p>
        </div>
      </Shell>
    );
  }

  const { req, client } = check;
  let appDomain = '';
  try { appDomain = new URL(req.redirectUri).host; } catch { appDomain = ''; }

  return (
    <Shell>
      <TreasuryChooser
        token={session.token}
        person={agentAddress as Address}
        via={session.via}
        appName={client.name ?? ''}
        appDomain={appDomain}
        appLogo={client.logo}
        defaultLabel={req.label}
        onChoose={(c: TreasuryChoice) =>
          leave(treasuryReturnUrl(req.redirectUri, req.state, { treasury: c.treasury, origin: c.origin }))}
        onDecline={() => leave(treasuryReturnUrl(req.redirectUri, req.state, { error: 'denied' }))}
      />
    </Shell>
  );
}

export default function ChooseTreasuryPage() {
  return (
    <SessionProvider>
      <Body />
    </SessionProvider>
  );
}
