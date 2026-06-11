'use client';
// Full-bleed entry experience shown by the portal gate when NOT authed (or mid relying-app
// enrollment). Routes: relying-app enroll (new / existing / org-create) and self-serve
// (onboarding / sign-in). The onboarding journey itself lives in <OnboardingJourney/>.
import { useEffect, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { openHome, createOrganization, continueWithGoogle, continueWithYouVersion, type Via, type Auth } from '../../home/onboarding';
import { passkeyLogin, fetchProfile, siweLogin } from '../../connect-client';
import { hasWallet } from '../../lib/wallet';
import { whitelabel } from '../../whitelabel/config';
import { useSession } from '../../context/session';
import { readSsoCookie } from '../../lib/sso-cookie';
import { CENTRAL_AUTH_DOMAIN, nameLabel, personalAuthOrigin, toAgentName, parseAgentSubdomain } from '../../lib/domain';

const googleEnabled = whitelabel.onboarding.credentialMethods.includes('google');
const youversionEnabled = whitelabel.onboarding.credentialMethods.includes('youversion');
const walletEnabled = whitelabel.onboarding.credentialMethods.includes('wallet');
import { useEnrollReq, type EnrollApi } from './useEnrollReq';
import { OnboardingJourney } from './OnboardingJourney';
import { RecognizedEnroll } from './RecognizedEnroll';
import { BrandShield } from '../shared/BrandShield';
import { ConsentSheet } from '../shared/ConsentSheet';
import { ReceiptCard } from '../shared/ReceiptCard';
import { HomeResolvedView } from './HomeResolvedView';

interface NameInfo { exists?: boolean; agent?: Address; deployed?: boolean; hasEoa?: boolean; hasPasskey?: boolean }
async function nameInfo(name: string): Promise<NameInfo> {
  try {
    return (await (await fetch(`/connect/name-info?name=${encodeURIComponent(name)}`)).json()) as NameInfo;
  } catch {
    return {};
  }
}

/** CAIP-10 tail (`eip155:<chain>:0x…`) → `0x…`, or null. Mirrors RecognizedEnroll / context/session. */
function addressOf(caip10: string | undefined): Address | null {
  if (!caip10) return null;
  const tail = caip10.split(':').pop();
  return tail && /^0x[0-9a-fA-F]{40}$/.test(tail) ? (tail as Address) : null;
}

/** The credential an EXISTING home actually signs with, from its on-chain credentials (name-info) — so
 *  a wallet-only home is opened/granted with the WALLET, not the passkey default. (KMS/Google homes
 *  don't reach the name path; they're recognized via the session cookie.) */
function viaForHome(info: NameInfo): Via {
  return info.hasPasskey ? 'passkey' : info.hasEoa ? 'wallet' : 'passkey';
}

// Subdomain-isolated passkeys (spec 229 P5): the ROOT passkey must be created/used at the
// person's OWN subdomain (RP ID = <label>.impact-agent.me). If we're not there yet, redirect;
// the subdomain auto-resumes via ?start / ?signin. Dev hosts (localhost/pages.dev) skip this.
function redirectForPasskey(intent: 'start' | 'signin', name: string): boolean {
  if (typeof window === 'undefined') return false;
  const label = nameLabel(name);
  if (!label) return false;
  const host = window.location.hostname;
  const onCentral = host === CENTRAL_AUTH_DOMAIN || host.endsWith('.' + CENTRAL_AUTH_DOMAIN);
  if (!onCentral) return false; // dev — RP is the dev host; no isolation hop
  if (host === `${label}.${CENTRAL_AUTH_DOMAIN}`) return false; // already home
  const u = new URL(personalAuthOrigin(label) + '/');
  u.searchParams.set(intent, label);
  window.location.href = u.toString();
  return true;
}

type View =
  | { k: 'checking' }
  | { k: 'blocked' }
  // `incomplete` = the requested name resolves to an SA that has no code on-chain
  // (orphan registry entry — historic relayer-paid /session/register-name from an
  // attempt whose deploy later failed). Surface this clearly instead of routing the
  // user into a flow that will revert with AA20 several steps later.
  | { k: 'incomplete'; name: string }
  | { k: 'credential' } // spec 257 W1 — the credential-first front door (default; name demoted)
  | { k: 'enroll-entry' } // spec 257 §11 — credential-first entry for a NAME-DEFERRED relying-app enroll
  | { k: 'enroll-recognized' } // already-authenticated member (ap_sso cookie) → one-tap authorize (ADR-0032)
  | { k: 'enroll-name'; reason?: 'passkey' | 'wallet' } // "Use my Impact name" within a name-deferred enroll → the named journey
  | { k: 'name'; reason?: 'passkey' | 'wallet' }
  | { k: 'journey'; variant: 'enroll-new' | 'self-serve'; name: string }
  | { k: 'enroll-existing'; name: string; agent: Address; via?: Via }
  | { k: 'org'; name: string; agent: Address }
  | { k: 'signin'; name: string };

export function EntryExperience({ mode }: { mode: 'entry' | 'enroll' }) {
  const api = useEnrollReq();
  const { openSession } = useSession();

  const [view, setView] = useState<View>(() => {
    if (mode === 'enroll') return { k: 'checking' };
    if (typeof window !== 'undefined') {
      const p = new URL(window.location.href).searchParams;
      const start = p.get('start');
      const signin = p.get('signin');
      if (start) return { k: 'journey', variant: 'self-serve', name: start };
      if (signin) return { k: 'signin', name: signin };
      // A per-handle home subdomain (<label>.impact-agent.me) IS that member's home — recognize
      // them from the host and go straight to "welcome back, sign in", pre-filled (not a generic
      // create screen). www/apex fall through to the name chooser.
      const subLabel = parseAgentSubdomain(window.location.hostname);
      if (subLabel) return { k: 'signin', name: toAgentName(subLabel) };
    }
    // spec 257 W1 — the www/apex self-serve default is CREDENTIAL-FIRST, not name-first. The name
    // is a public handle, not a login key; social/passkey resolve the home without it.
    return { k: 'credential' };
  });

  // Enroll mode: resolve the requested name → new vs existing vs org-create.
  useEffect(() => {
    if (mode !== 'enroll' || !api.enroll) return;
    if (!api.allowed) {
      setView({ k: 'blocked' });
      return;
    }
    void (async () => {
      // spec 257 §11: a name-deferred enroll arrives with an EMPTY `agent_name`. Show the
      // CREDENTIAL-FIRST entry (Continue with Google PRIMARY) — NOT the passkey-first journey
      // (whose "Get started" / empty-name "home" chip is wrong here). Google deploys a NAMELESS SA
      // (resumed post-redirect in GoogleEnrollResume); passkey/"use my name" fall to the named
      // journey (a new passkey home is subdomain-bound, so it needs a name). Don't call nameInfo('').
      if (!api.enroll!.name) {
        // An ALREADY-authenticated member (cross-subdomain `ap_sso` cookie) is RECOGNIZED → one-tap
        // authorize as themselves (RecognizedEnroll, custody-routed; ADR-0032). No cookie → the
        // credential-first entry. (`?delegate` makes `shouldRestore` skip restore, so `useSession()` is
        // null here — recognition reads the cookie directly, the same recovery org-create already does.)
        setView({ k: readSsoCookie() ? 'enroll-recognized' : 'enroll-entry' });
        return;
      }
      const info = await nameInfo(api.enroll!.name);
      // Orphan-registry guard: the name resolves to an SA but that SA has no
      // code on-chain. Refuse to use it — every downstream `executeCall` would
      // revert with AA20. Route to a dedicated 'incomplete' view that tells the
      // user to pick a different name. (Older `name-info` responses without the
      // `deployed` field fall through to legacy routing — undefined !== false.)
      if (info.exists && info.agent && info.deployed === false) {
        setView({ k: 'incomplete', name: api.enroll!.name });
        return;
      }
      if (api.enroll!.orgBase) {
        // org-create assumes an existing member; resolve their person agent.
        if (info.agent) setView({ k: 'org', name: api.enroll!.name, agent: info.agent });
        else setView({ k: 'blocked' });
        return;
      }
      if (info.exists && info.agent) setView({ k: 'enroll-existing', name: api.enroll!.name, agent: info.agent, via: viaForHome(info) });
      else setView({ k: 'journey', variant: 'enroll-new', name: api.enroll!.name });
    })();
  }, [mode, api.enroll, api.allowed]);

  if (view.k === 'checking') {
    return <Shell><div className="onboarding-busy"><span className="spinner spinner-lg" /><p className="onboarding-busy-msg">One moment…</p></div></Shell>;
  }
  if (view.k === 'blocked') {
    return (
      <Shell>
        <h1 className="onboarding-h1">Request blocked</h1>
        <p className="onboarding-sub">For your safety this request was blocked. Only start setup from a site you trust.</p>
      </Shell>
    );
  }
  if (view.k === 'incomplete') {
    return (
      <Shell>
        <h1 className="onboarding-h1">This name was set up partway, then stopped.</h1>
        <p className="onboarding-sub">
          The name <strong>{view.name}</strong> was reserved before, but its setup didn't finish, so it can't be used. Please pick a fresh name to start clean.
        </p>
        <button
          type="button"
          className="onboarding-primary"
          onClick={() => {
            if (typeof window !== 'undefined') {
              window.location.href = '/';
            }
          }}
        >
          Pick a different name
        </button>
      </Shell>
    );
  }
  if (view.k === 'journey') {
    return <OnboardingJourney variant={view.variant} name={view.name} api={mode === 'enroll' ? api : undefined} />;
  }
  if (view.k === 'enroll-existing') {
    return <OnboardingJourney variant="enroll-existing" name={view.name} api={api} existingAgent={view.agent} initialVia={view.via} />;
  }
  if (view.k === 'org') {
    return <OrgConsent personAgent={view.agent} api={api} />;
  }
  if (view.k === 'signin') {
    return <SignInView name={view.name} onSession={async (t, via) => { await openSession(t, via, false); }} />;
  }
  // spec 257 W1 — credential-first front door (the self-serve default). Social/passkey resolve the
  // home with no name; "Use my Impact name" demotes to the name-first fallback.
  if (view.k === 'credential') {
    return (
      <CredentialFirstStart
        onUseName={(reason) => setView({ k: 'name', reason })}
        onSession={async (t, via) => { await openSession(t, via, false); }}
      />
    );
  }
  // spec 257 §11 — credential-first entry for a NAME-DEFERRED relying-app enroll. Same front door,
  // but `enrollApi` makes the Google button STASH the enroll so GoogleEnrollResume resumes the
  // grant + delivers the code back to the relying app (and deploys a nameless SA).
  if (view.k === 'enroll-recognized') {
    // Recognized returning member → authorize in one tap. Stale/absent session falls back to the entry.
    return <RecognizedEnroll api={api} onUnrecognized={() => setView({ k: 'enroll-entry' })} />;
  }
  if (view.k === 'enroll-entry') {
    return (
      <CredentialFirstStart
        enrollApi={api}
        onUseName={(reason) => setView({ k: 'enroll-name', reason })}
        onSession={async (t, via) => { await openSession(t, via, false); }}
      />
    );
  }
  // "Use my Impact name" within a name-deferred enroll → collect a name, then route to the named
  // enroll path (existing home → sign in + grant; new → the named journey which handles passkey).
  if (view.k === 'enroll-name') {
    return <NameStart enrollApi={api} reason={view.reason} onStart={async (name) => {
      const info = await nameInfo(name);
      if (info.exists && info.agent && info.deployed === false) { setView({ k: 'incomplete', name }); return; }
      if (info.exists && info.agent) setView({ k: 'enroll-existing', name, agent: info.agent, via: viaForHome(info) });
      else setView({ k: 'journey', variant: 'enroll-new', name });
    }} />;
  }
  // Name-first fallback (reached via "Use my Impact name").
  return <NameStart reason={view.k === 'name' ? view.reason : undefined} onStart={(name, exists) => {
    if (exists) {
      if (!redirectForPasskey('signin', name)) setView({ k: 'signin', name });
    } else {
      if (!redirectForPasskey('start', name)) setView({ k: 'journey', variant: 'self-serve', name });
    }
  }} />;
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="onboarding-screen"><div className="onboarding-card">{children}</div></div>;
}

// ── Self-serve: choose your name in the community ─────────────────────────────
// `enrollApi` (relying-app enroll only): the "Continue with Google" button must STASH the enroll so
// the post-redirect GoogleEnrollResume finishes the grant + delivers the code back to the app.
// The name screen does TWO jobs — sign in to an EXISTING home, or create a NEW one — so it stays
// NEUTRAL ("Find your home") until `nameInfo()` resolves whether the typed name exists, then commits to
// "Continue to <name>" (taken → sign in) or "Create <name>" (available). No "join" before the system
// confirms availability. `reason` (passkey/wallet) explains WHY we routed here from a credential click.
function NameStart({ onStart, enrollApi, reason }: { onStart: (name: string, exists: boolean) => void; enrollApi?: EnrollApi; reason?: 'passkey' | 'wallet' }) {
  const [value, setValue] = useState('');
  const [avail, setAvail] = useState<'idle' | 'checking' | 'available' | 'taken'>('idle');
  const [busy, setBusy] = useState(false);
  const label = nameLabel(value);
  const brand = whitelabel.brand.name;
  const fullName = label ? toAgentName(label) : '';                 // <label>.impact (the public handle)
  const homeHost = label ? `${label}.${CENTRAL_AUTH_DOMAIN}` : '';  // <label>.impact-agent.me (the home)
  const onGoogle = () => {
    const stash = enrollApi?.enroll
      ? JSON.stringify({ enroll: enrollApi.enroll, popupMode: enrollApi.popupMode, name: label ? toAgentName(label) : '' })
      : undefined;
    // Heading to Google — warn a popup opener (COOP severs it) so it waits for the relay, not close.
    enrollApi?.postToOpener({ type: 'AC_PROGRESS', msg: 'Continuing with Google…', idp: true });
    continueWithGoogle(label ? toAgentName(label) : undefined, stash);
  };
  const onYouVersion = () => {
    const stash = enrollApi?.enroll
      ? JSON.stringify({ enroll: enrollApi.enroll, popupMode: enrollApi.popupMode, name: label ? toAgentName(label) : '' })
      : undefined;
    enrollApi?.postToOpener({ type: 'AC_PROGRESS', msg: 'Continuing with YouVersion…', idp: true });
    continueWithYouVersion(label ? toAgentName(label) : undefined, stash);
  };

  useEffect(() => {
    if (!label) { setAvail('idle'); return; }
    setAvail('checking');
    const t = setTimeout(async () => {
      const info = await nameInfo(toAgentName(label));
      setAvail(info.exists ? 'taken' : 'available');
    }, 400);
    return () => clearTimeout(t);
  }, [label]);

  // CTA commits ONLY once the name is resolved: neutral "Continue" while idle/checking, then the
  // sign-in vs create verb once we know if it exists.
  const cta = busy ? 'One moment…'
    : avail === 'checking' ? 'Checking…'
    : avail === 'taken' ? `Continue to ${fullName}`
    : avail === 'available' ? `Create ${fullName}`
    : 'Continue';

  return (
    <Shell>
      <BrandShield size={56} />
      <h1 className="onboarding-h1">Find your {brand} home</h1>
      <p className="onboarding-sub">
        Use your {brand} name if you know it. Your name is your public handle; Google, passkeys, and
        wallets are how you prove it&apos;s yours.
      </p>
      {reason && (
        <p className="onboarding-note">
          {reason === 'passkey'
            ? `Passkeys are tied to your ${brand} home address. Enter your ${brand} name so we can open the right home.`
            : `We need your ${brand} name to open the right home for this wallet.`}
        </p>
      )}
      <input
        className="onboarding-input"
        value={value}
        onChange={(e) => setValue(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
        placeholder="e.g. alice"
        aria-label={`Your ${brand} name`}
        autoCapitalize="none"
        spellCheck={false}
      />
      {label && (
        <div className="onboarding-name-preview">
          {fullName} <span className="onboarding-name-host">· home at {homeHost}</span>
        </div>
      )}
      {avail === 'taken' && (
        <p className="onboarding-hint taken">That name already exists. Sign in if it&apos;s yours, or choose another name.</p>
      )}
      {avail === 'available' && <p className="onboarding-hint ok">✓ {fullName} is available</p>}
      <button
        className="btn-primary"
        disabled={!label || busy || avail === 'checking'}
        onClick={() => { setBusy(true); onStart(toAgentName(label), avail === 'taken'); }}
      >
        {cta}
      </button>
      {(googleEnabled || youversionEnabled) && (
        <>
          <div className="method-or">Other ways to continue</div>
          {googleEnabled && (
            <button className="btn-ghost onboarding-secondary" onClick={onGoogle}>
              Continue with Google
            </button>
          )}
          {youversionEnabled && (
            <button className="btn-ghost onboarding-secondary" onClick={onYouVersion}>
              Continue with YouVersion
            </button>
          )}
        </>
      )}
    </Shell>
  );
}

// ── spec 257 W1: credential-first front door ──────────────────────────────────
// Social/passkey is the way in; the Impact name is a public handle, not a login key. Google
// resolves the home server-side with NO name (spec 235); passkeys are subdomain-isolated (RP =
// <label>.impact-agent.me) so a discoverable assertion here only succeeds for a home reachable
// from this origin — otherwise we route to the name path (which hops to the right subdomain).
function CredentialFirstStart({ onUseName, onSession, enrollApi }: {
  onUseName: (reason?: 'passkey' | 'wallet') => void;
  onSession: (token: string, via: string) => Promise<void>;
  // spec 257 §11 — when set, this is a NAME-DEFERRED relying-app enroll: Google stashes the enroll
  // (resumed in GoogleEnrollResume → nameless SA + grant), and passkey routes to the name path
  // (a new passkey home is subdomain-bound, so it needs a name) rather than a discoverable login.
  enrollApi?: EnrollApi;
}) {
  const [busy, setBusy] = useState<'passkey' | 'wallet' | null>(null);
  const [err, setErr] = useState('');
  // Only offer the wallet button when an injected provider is actually present (client-only check,
  // set after mount to avoid an SSR/first-paint mismatch).
  const [walletAvail, setWalletAvail] = useState(false);
  useEffect(() => { setWalletAvail(walletEnabled && hasWallet()); }, []);
  const onGoogle = () => {
    const stash = enrollApi?.enroll
      ? JSON.stringify({ enroll: enrollApi.enroll, popupMode: enrollApi.popupMode, name: '' })
      : undefined;
    // Tell a popup opener we're leaving for Google BEFORE we navigate (COOP will sever the opener):
    // it must stop trusting `popup.closed` and wait for the relay channel instead. No-op otherwise.
    enrollApi?.postToOpener({ type: 'AC_PROGRESS', msg: 'Continuing with Google…', idp: true });
    continueWithGoogle(undefined, stash);
  };
  const onYouVersion = () => {
    const stash = enrollApi?.enroll
      ? JSON.stringify({ enroll: enrollApi.enroll, popupMode: enrollApi.popupMode, name: '' })
      : undefined;
    enrollApi?.postToOpener({ type: 'AC_PROGRESS', msg: 'Continuing with YouVersion…', idp: true });
    continueWithYouVersion(undefined, stash);
  };
  // spec 257 W3 — when a passkey resolves an EXISTING home, show the "We found your Impact home"
  // confirmation beat before issuing the session (display only; the token is already minted).
  const [resolved, setResolved] = useState<{ token: string; name: string | null; address: Address | null; via: string } | null>(null);

  async function withPasskey() {
    setBusy('passkey');
    setErr('');
    try {
      // registerIfMissing=false: never silently mint a key here — a fresh user takes the named/
      // bootstrap path. A discoverable assertion that resolves an existing home → straight in.
      const out = await passkeyLogin(false);
      if (out.status === 'issued' && out.token) {
        // Best-effort handle for the beat — never gates the session: on any failure we fall
        // straight through to onSession with what (if anything) we have.
        let name: string | null = null;
        let address: Address | null = null;
        try {
          const p = await fetchProfile(out.token);
          name = p?.name ?? null;
          address = p?.agent ? ((p.agent.split(':').pop() ?? null) as Address | null) : null;
        } catch { /* show the beat without a handle */ }
        setResolved({ token: out.token, name, address, via: 'passkey' });
        return;
      }
      // No discoverable home at this origin (subdomain isolation / new user) → name path.
      onUseName('passkey');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'passkey sign-in failed');
    } finally {
      setBusy(null);
    }
  }

  // Wallet (SIWE/EOA) — parallel to passkey. Connect the wallet + sign SIWE: an EXISTING
  // wallet-custodied home resolves straight in (the beat → session); a NEW wallet (no home yet)
  // takes the name path, where the journey deploys a named wallet home. Wallet is NOT
  // subdomain-bound, so no origin hop is needed (unlike passkey).
  async function withWallet() {
    setBusy('wallet');
    setErr('');
    try {
      const out = await siweLogin();
      if (out.status === 'issued' && out.token) {
        let name: string | null = null;
        let address: Address | null = (out.agent ?? null) as Address | null;
        try {
          const p = await fetchProfile(out.token);
          name = p?.name ?? null;
          if (p?.agent) address = (p.agent.split(':').pop() ?? address) as Address | null;
        } catch { /* show the beat without a handle */ }
        setResolved({ token: out.token, name, address, via: 'wallet' });
        return;
      }
      if (out.status === 'bootstrap') {
        // New wallet — no home for this EOA yet. Name path → the journey deploys the wallet home.
        onUseName('wallet');
        return;
      }
      setErr(('reason' in out && out.reason) || 'wallet sign-in failed');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'wallet sign-in failed');
    } finally {
      setBusy(null);
    }
  }

  // Resolved-home confirmation beat (greenfield 10): "Welcome back" + handle + role/org chips,
  // then auto-advance into the session. A returning passkey member is never `fresh`.
  if (resolved) {
    return (
      <HomeResolvedView
        fresh={false}
        knownName={resolved.name}
        address={resolved.address}
        token={resolved.token}
        onContinue={() => { void onSession(resolved.token, resolved.via); }}
      />
    );
  }

  return (
    <Shell>
      <BrandShield size={56} />
      <h1 className="onboarding-h1">{whitelabel.copy.arrivalTitle}</h1>
      <p className="onboarding-sub">
        Sign in or get started. Your {whitelabel.brand.name} name is how others find your agent —
        not something you need to remember to get back in.
      </p>
      {googleEnabled && (
        <button className="btn-primary" onClick={onGoogle}>
          Continue with Google
        </button>
      )}
      {youversionEnabled && (
        <button className={googleEnabled ? 'btn-ghost onboarding-secondary' : 'btn-primary'} onClick={onYouVersion}>
          Continue with YouVersion
        </button>
      )}
      {enrollApi ? (
        // Relying-app popup enroll (spec 257 §11 / spec 259): passkey + wallet BOTH lead to name entry
        // here — a new passkey home is subdomain-bound (its WebAuthn RP ID is the handle's home origin),
        // so a handle is needed and is collected on the NEXT screen (NameStart), inside this home popup,
        // never on the relying app. One accurate button instead of two that both route to the name path
        // plus a redundant "use my name" link.
        <button
          className={googleEnabled ? 'btn-ghost onboarding-secondary' : 'btn-primary'}
          onClick={() => onUseName('passkey')}
        >
          Continue with a passkey or wallet
        </button>
      ) : (
        <>
          {/* Self-serve: real device login. A discoverable passkey / existing wallet home resolves
              straight in; a brand-new credential falls through to the name path. */}
          <button
            className={googleEnabled ? 'btn-ghost onboarding-secondary' : 'btn-primary'}
            onClick={withPasskey}
            disabled={busy !== null}
          >
            {busy === 'passkey' ? 'Checking your device…' : 'Continue with a passkey'}
          </button>
          {walletAvail && (
            <button
              className="btn-ghost onboarding-secondary"
              onClick={withWallet}
              disabled={busy !== null}
            >
              {busy === 'wallet' ? 'Confirm in your wallet…' : 'Continue with a wallet'}
            </button>
          )}
          <div className="method-or">or</div>
          <button className="btn-ghost onboarding-secondary" onClick={() => onUseName()}>
            Use my {whitelabel.brand.name} name
          </button>
        </>
      )}
      {err && <p className="onboarding-hint taken">{err}</p>}
    </Shell>
  );
}

// ── Returning member sign-in ──────────────────────────────────────────────────
function SignInView({ name, onSession }: { name: string; onSession: (token: string, via: string) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [info, setInfo] = useState<NameInfo | null>(null);
  // Recognize an existing cross-subdomain `ap_sso` session that resolves to THIS home → offer a one-tap
  // "Continue as <name>" without a fresh credential assertion (mirrors the relying-app RecognizedEnroll
  // path). Fixes the dead-end where a direct visit to a passkey-only home on a device WITHOUT the passkey
  // forced "Continue with passkey" and failed, even though the member was already signed in. `null` =
  // not recognized → fall through to credential sign-in; set → show the one-tap continue.
  const [recognized, setRecognized] = useState<{ token: string; via: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const ni = await nameInfo(name).catch(() => ({}) as NameInfo);
      if (cancelled) return;
      setInfo(ni);
      const sso = readSsoCookie();
      if (!sso?.token || !ni.agent) return;
      const profile = await fetchProfile(sso.token).catch(() => null);
      const addr = addressOf(profile?.agent);
      // Only recognize when the live session resolves to THIS exact home (a different signed-in home,
      // or a stale/undeployed one, falls through to credential sign-in — one mechanism, ADR-0013).
      if (!cancelled && addr && profile?.deployed !== false && addr.toLowerCase() === ni.agent.toLowerCase()) {
        setRecognized({ token: sso.token, via: sso.via || 'sso' });
      }
    })();
    return () => { cancelled = true; };
  }, [name]);

  async function go(via: 'passkey' | 'wallet') {
    if (via === 'passkey' && redirectForPasskey('signin', name)) return;
    setBusy(true);
    setErr('');
    try {
      const out = await openHome(name, via);
      if (out.ok) await onSession(out.token, via);
      else setErr(out.error);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'sign-in failed');
    } finally {
      setBusy(false);
    }
  }

  // Show the credentials this home ACTUALLY has (until name-info loads, show passkey+wallet).
  // Google stays available (a Google-custodied home re-derives via Google).
  const showPasskey = info ? !!info.hasPasskey : true;
  const showWallet = info ? !!info.hasEoa : true;
  const onlyWallet = info ? !!info.hasEoa && !info.hasPasskey : false;
  const notFound = info ? info.exists === false : false;

  // Recognized: the member already has a live session for THIS home → one tap, no fresh credential.
  if (recognized) {
    return (
      <Shell>
        <BrandShield size={56} />
        <h1 className="onboarding-h1">Welcome back</h1>
        <p className="onboarding-sub">You&apos;re already signed in — continue as <strong>{nameLabel(name)}</strong>.</p>
        {busy ? (
          <div className="onboarding-busy"><span className="spinner spinner-lg" /><p className="onboarding-busy-msg">Confirming…</p></div>
        ) : (
          <>
            <button
              className="btn-primary"
              onClick={async () => {
                setBusy(true);
                setErr('');
                try {
                  await onSession(recognized.token, recognized.via);
                } catch (e) {
                  setErr(e instanceof Error ? e.message : 'sign-in failed');
                  setBusy(false);
                }
              }}
            >
              Continue as {nameLabel(name)}
            </button>
            <button className="btn-ghost onboarding-secondary" onClick={() => setRecognized(null)}>
              Sign in a different way
            </button>
          </>
        )}
        {err && <p className="onboarding-hint taken">{err}</p>}
      </Shell>
    );
  }

  return (
    <Shell>
      <BrandShield size={56} />
      <h1 className="onboarding-h1">Welcome back</h1>
      <p className="onboarding-sub">Sign in to <strong>{name}</strong> — your home in the {whitelabel.brand.community}.</p>
      {busy || !info ? (
        // Wait for name-info before rendering credential buttons. Otherwise the pre-load defaults
        // (showPasskey=true) flash "Continue with passkey" as the primary even for a WALLET-only home,
        // so the member is taken to passkey when they should get wallet. Show only this home's ACTUAL
        // credential(s) once resolved.
        <div className="onboarding-busy"><span className="spinner spinner-lg" /><p className="onboarding-busy-msg">{busy ? 'Confirming…' : 'Opening your home…'}</p></div>
      ) : notFound ? (
        <>
          <p className="onboarding-hint taken">No home named <strong>{nameLabel(name)}</strong> yet.</p>
          <button className="btn-primary" onClick={() => continueWithGoogle(name)}>Create it with Google</button>
        </>
      ) : (
        // A named-home sign-in uses THIS home's own credential(s). Google is NOT shown — it
        // resolves the member's separate Google home, not this named one.
        <>
          {showPasskey && (
            <button className="btn-primary" onClick={() => go('passkey')}>Continue with passkey</button>
          )}
          {showWallet && (
            <button className={onlyWallet ? 'btn-primary' : 'btn-ghost onboarding-secondary'} onClick={() => go('wallet')}>
              Continue with wallet
            </button>
          )}
        </>
      )}
      {err && <p className="onboarding-hint taken">{err}</p>}
    </Shell>
  );
}

// ── Org-create consent (existing member creates an org via a relying app) ──────
function OrgConsent({ personAgent, api }: { personAgent: Address; api: ReturnType<typeof useEnrollReq> }) {
  const [phase, setPhase] = useState<'consent' | 'busy' | 'connected' | 'error'>('consent');
  const [err, setErr] = useState('');
  const { session } = useSession();
  const tpl = whitelabel.delegationTemplates['org-create'] ?? { canDo: [], cannotDo: ['Move funds', 'Add members', 'Act outside this permission'] };
  const orgBase = api.enroll?.orgBase ?? '';
  // spec 256 — the org inherits the member's ACTUAL custody. A Google member's org is deployed by
  // their KMS C_sub server-side (zero device prompts); passkey/wallet members sign on device. The
  // credential is the one they're signed in with (via is 'passkey' | 'wallet' | 'Google').
  //
  // BUT org-create arrives with `?delegate`, which makes `shouldRestore()` SKIP session restoration, so
  // `useSession()` is null here for a Google/wallet member. Their custody token still lives in the
  // cross-subdomain SSO cookie (set at Google sign-in — GoogleEnrollResume / openSession). Recover it as
  // a fallback so we route to the Google KMS path instead of erroring "your passkey isn't on this device."
  // A passkey member has no reusable token; they fall through to `via='passkey'` and the ambient passkey,
  // which is correct.
  const cred = session ?? readSsoCookie();
  const credVia = (cred?.via ?? 'passkey').toLowerCase();
  const via: Via = credVia === 'google' ? 'google' : credVia === 'wallet' ? 'wallet' : 'passkey';
  const auth: Auth | undefined = cred?.token ? { token: cred.token } : undefined;

  async function authorize() {
    if (!api.enroll) return;
    setPhase('busy');
    try {
      // SEC-001: registry-derived delegate FROM the server-minted grant (the URL's
      // `api.enroll.delegate` is treated as untrusted hint — the server's binding wins).
      const { grant_id, delegate } = await api.beginGrant(api.enroll.name);
      const created = await createOrganization({ address: personAgent, name: api.enroll.name }, orgBase, delegate, via, auth, {
        purpose: api.enroll.purpose,
        requestedBy: api.enroll.aud,
        grantOrg: api.enroll.grantOrg,
      });
      if (!created.ok) { setErr(created.error); setPhase('error'); return; }
      const code = await api.submitGrant(grant_id, created.grant, created.org);
      setPhase('connected');
      setTimeout(() => api.deliverCode(code), 1100);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'org creation failed');
      setPhase('error');
    }
  }

  if (phase === 'busy') return <Shell><div className="onboarding-busy"><span className="spinner spinner-lg" /><p className="onboarding-busy-msg">Creating your organization…</p></div></Shell>;
  // Spec 255 W4.1 — the org-create "connected" receipt: what the single approval accomplished.
  if (phase === 'connected') return <Shell><BrandShield size={56} /><h1 className="onboarding-h1">{orgBase} is ready</h1><ReceiptCard title={`${orgBase} is ready`} body={`Its home is started, its name is claimed, and ${api.host} can now read what it posts.`} /><p className="onboarding-sub">Returning you to {api.host}…</p></Shell>;
  if (phase === 'error') return <Shell><h1 className="onboarding-h1">Couldn&apos;t finish</h1><p className="onboarding-hint taken">{err}</p><button className="btn-primary" onClick={() => setPhase('consent')}>Try again</button></Shell>;
  return (
    <Shell>
      {/* Spec 255 W3.3 — pre-org-create explainer ABOVE the consent sheet. Consent-level copy (NOT
          passkey-specific — never says "passkey"), so it's correct for ALL org-create credentials
          including Google. */}
      <div className="securing-explainer pre-prompt-explainer">
        <div className="securing-explainer-title">One tap — approve creating {orgBase}</div>
        <p>
          This single approval starts the org, claims its name, and gives {api.host} scoped read access to
          its posted needs. Nothing beyond that.
        </p>
        <p className="securing-wait">You can revoke {api.host}&apos;s access at any time from your Impact home.</p>
      </div>
      <ConsentSheet
        title={`Create ${orgBase} in the ${whitelabel.brand.community}`}
        appName={api.host}
        appDomain={api.host}
        template={tpl}
        authorizeLabel="Approve & connect"
        onAuthorize={authorize}
        onDecline={api.denyEnroll}
      />
    </Shell>
  );
}
