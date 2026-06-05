'use client';
// Full-bleed entry experience shown by the portal gate when NOT authed (or mid relying-app
// enrollment). Routes: relying-app enroll (new / existing / org-create) and self-serve
// (onboarding / sign-in). The onboarding journey itself lives in <OnboardingJourney/>.
import { useEffect, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { openHome, createOrganization, continueWithGoogle, type Via, type Auth } from '../../home/onboarding';
import { passkeyLogin, fetchProfile } from '../../connect-client';
import { whitelabel } from '../../whitelabel/config';
import { useSession } from '../../context/session';
import { CENTRAL_AUTH_DOMAIN, nameLabel, personalAuthOrigin, toAgentName, parseAgentSubdomain } from '../../lib/domain';

const googleEnabled = whitelabel.onboarding.credentialMethods.includes('google');
import { useEnrollReq, type EnrollApi } from './useEnrollReq';
import { OnboardingJourney } from './OnboardingJourney';
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
  | { k: 'enroll-name' } // "Use my Impact name" within a name-deferred enroll → the named journey
  | { k: 'name' }
  | { k: 'journey'; variant: 'enroll-new' | 'self-serve'; name: string }
  | { k: 'enroll-existing'; name: string; agent: Address }
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
        setView({ k: 'enroll-entry' });
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
      if (info.exists && info.agent) setView({ k: 'enroll-existing', name: api.enroll!.name, agent: info.agent });
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
    return <OnboardingJourney variant="enroll-existing" name={view.name} api={api} existingAgent={view.agent} />;
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
        onUseName={() => setView({ k: 'name' })}
        onSession={async (t, via) => { await openSession(t, via, false); }}
      />
    );
  }
  // spec 257 §11 — credential-first entry for a NAME-DEFERRED relying-app enroll. Same front door,
  // but `enrollApi` makes the Google button STASH the enroll so GoogleEnrollResume resumes the
  // grant + delivers the code back to the relying app (and deploys a nameless SA).
  if (view.k === 'enroll-entry') {
    return (
      <CredentialFirstStart
        enrollApi={api}
        onUseName={() => setView({ k: 'enroll-name' })}
        onSession={async (t, via) => { await openSession(t, via, false); }}
      />
    );
  }
  // "Use my Impact name" within a name-deferred enroll → collect a name, then route to the named
  // enroll path (existing home → sign in + grant; new → the named journey which handles passkey).
  if (view.k === 'enroll-name') {
    return <NameStart enrollApi={api} onStart={async (name) => {
      const info = await nameInfo(name);
      if (info.exists && info.agent && info.deployed === false) { setView({ k: 'incomplete', name }); return; }
      if (info.exists && info.agent) setView({ k: 'enroll-existing', name, agent: info.agent });
      else setView({ k: 'journey', variant: 'enroll-new', name });
    }} />;
  }
  // Name-first fallback (reached via "Use my Impact name").
  return <NameStart onStart={(name, exists) => {
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
function NameStart({ onStart, enrollApi }: { onStart: (name: string, exists: boolean) => void; enrollApi?: EnrollApi }) {
  const [value, setValue] = useState('');
  const [avail, setAvail] = useState<'idle' | 'checking' | 'available' | 'taken'>('idle');
  const [busy, setBusy] = useState(false);
  const label = nameLabel(value);
  const onGoogle = () => {
    const stash = enrollApi?.enroll
      ? JSON.stringify({ enroll: enrollApi.enroll, popupMode: enrollApi.popupMode, name: label ? toAgentName(label) : '' })
      : undefined;
    continueWithGoogle(label ? toAgentName(label) : undefined, stash);
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

  return (
    <Shell>
      <BrandShield size={56} />
      <h1 className="onboarding-h1">{whitelabel.copy.arrivalTitle}</h1>
      <p className="onboarding-sub">Choose your name in the {whitelabel.brand.community}.</p>
      <input
        className="onboarding-input"
        value={value}
        onChange={(e) => setValue(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
        placeholder="e.g. alice"
        aria-label="Your name"
        autoCapitalize="none"
        spellCheck={false}
      />
      {label && <div className="onboarding-name-preview">{toAgentName(label)}</div>}
      {avail === 'taken' && <p className="onboarding-hint taken">That name is taken — try another, or sign in if it&apos;s yours.</p>}
      {avail === 'available' && <p className="onboarding-hint ok">✓ Available</p>}
      <button
        className="btn-primary"
        disabled={!label || busy || avail === 'checking'}
        onClick={() => { setBusy(true); onStart(toAgentName(label), avail === 'taken'); }}
      >
        {avail === 'taken'
          ? `Sign in to the ${whitelabel.brand.community}`
          : `Join the ${whitelabel.brand.community} as '${label || '…'}'`}
      </button>
      {googleEnabled && (
        <>
          <div className="method-or">or</div>
          <button className="btn-ghost onboarding-secondary" onClick={onGoogle}>
            Continue with Google
          </button>
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
  onUseName: () => void;
  onSession: (token: string, via: string) => Promise<void>;
  // spec 257 §11 — when set, this is a NAME-DEFERRED relying-app enroll: Google stashes the enroll
  // (resumed in GoogleEnrollResume → nameless SA + grant), and passkey routes to the name path
  // (a new passkey home is subdomain-bound, so it needs a name) rather than a discoverable login.
  enrollApi?: EnrollApi;
}) {
  const [busy, setBusy] = useState<'passkey' | null>(null);
  const [err, setErr] = useState('');
  const onGoogle = () => {
    const stash = enrollApi?.enroll
      ? JSON.stringify({ enroll: enrollApi.enroll, popupMode: enrollApi.popupMode, name: '' })
      : undefined;
    continueWithGoogle(undefined, stash);
  };
  // spec 257 W3 — when a passkey resolves an EXISTING home, show the "We found your Impact home"
  // confirmation beat before issuing the session (display only; the token is already minted).
  const [resolved, setResolved] = useState<{ token: string; name: string | null; address: Address | null } | null>(null);

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
        setResolved({ token: out.token, name, address });
        return;
      }
      // No discoverable home at this origin (subdomain isolation / new user) → name path.
      onUseName();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'passkey sign-in failed');
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
        onContinue={() => { void onSession(resolved.token, 'passkey'); }}
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
      <button
        className={googleEnabled ? 'btn-ghost onboarding-secondary' : 'btn-primary'}
        onClick={enrollApi ? onUseName : withPasskey}
        disabled={busy !== null}
      >
        {busy === 'passkey' ? 'Checking your device…' : 'Continue with a passkey'}
      </button>
      <div className="method-or">or</div>
      <button className="btn-ghost onboarding-secondary" onClick={onUseName}>
        Use my {whitelabel.brand.name} name
      </button>
      {err && <p className="onboarding-hint taken">{err}</p>}
    </Shell>
  );
}

// ── Returning member sign-in ──────────────────────────────────────────────────
function SignInView({ name, onSession }: { name: string; onSession: (token: string, via: string) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [info, setInfo] = useState<NameInfo | null>(null);
  useEffect(() => {
    nameInfo(name).then(setInfo).catch(() => setInfo({}));
  }, []);

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

  return (
    <Shell>
      <BrandShield size={56} />
      <h1 className="onboarding-h1">Welcome back</h1>
      <p className="onboarding-sub">Sign in to <strong>{name}</strong> — your home in the {whitelabel.brand.community}.</p>
      {busy ? (
        <div className="onboarding-busy"><span className="spinner spinner-lg" /><p className="onboarding-busy-msg">Confirming…</p></div>
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
  // credential is the one they're signed in with (session.via is 'passkey' | 'wallet' | 'Google').
  const via: Via = (session?.via ?? 'passkey').toLowerCase() === 'google'
    ? 'google'
    : session?.via === 'wallet' ? 'wallet' : 'passkey';
  const auth: Auth | undefined = session?.token ? { token: session.token } : undefined;

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
