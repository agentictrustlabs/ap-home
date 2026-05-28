'use client';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { Address, Hex } from '@agenticprimitives/types';
import {
  AUD,
  signupWithName,
  stepUpToAgent,
  connectWithName,
  provisionA2aAgent,
  createChildAgentForSite,
  createSecureHomePasskey,
  deployAndClaimAgent,
  addWalletCredential,
  addPasskeyCredential,
  passkeySignHash,
  fetchProfile,
  fetchSensitive,
  type BasicProfile,
} from './connect-client';
import { issueSiteDelegation, toWire } from './lib/delegation';
import { loadPasskey, type DemoPasskey } from './lib/passkey';
import { hasWallet, connectWallet, personalSign } from './lib/wallet';
import { startGoogleSignIn, exchangeCode } from './server-client';
import { CENTRAL_AUTH_DOMAIN, subdomainHandle } from './lib/host';
import { NewDevice, ApproveDevice } from './components/device-link';
import { whitelabel, fmt } from './whitelabel/config';

/** The relying app's host (its domain) — the honest identity shown in consent + {app} copy. */
function hostOf(redirectUri: string): string {
  try {
    return new URL(redirectUri).host;
  } catch {
    return redirectUri;
  }
}

interface Session {
  token: string;
  via: string; // 'wallet' | 'Google'
  fresh: boolean; // true = just created (welcome) vs reconnected (welcome back)
}

const SESSION_KEY = 'agenticprimitives:demo-sso:session';

/** True iff we should try to restore a persisted session on load — i.e. one is stored
 *  AND we're not mid Google-redirect (?code) or central-auth enrollment (?enroll_digest). */
function shouldRestore(): boolean {
  try {
    const u = new URL(window.location.href);
    if (u.searchParams.has('code') || u.searchParams.has('connect_status') || u.searchParams.has('delegate')) {
      return false;
    }
    return !!localStorage.getItem(SESSION_KEY);
  } catch {
    return false;
  }
}

// ── OIDC authorization endpoint (spec 230) ──────────────────────────
// A relying site redirects here (`/authorize`, code + S256 PKCE) to sign the person in.
// This origin is the OpenID Provider: the ROOT passkey ceremony authenticates the person,
// /oidc/grant mints the id_token + a single-use code, and the relying site exchanges the
// code at /token for { id_token, delegation }. Identity = id_token; authority = the scoped
// delegation (ADR-0019). Internal field names kept terse; param names are standard OIDC.
interface EnrollReq {
  aud: string; // = client_id
  redirectUri: string; // = redirect_uri (exact-match in the registry)
  state: string;
  name: string; // = agent_name (the person to sign in / govern)
  delegate: Address; // the relying site's delegate Smart Account (delegation recipient)
  nonce: string;
  codeChallenge: string; // PKCE S256 challenge
  template: string; // delegation_template: 'site-login' | 'org-create'
  orgBase?: string; // org_create: the org name to create
}
/** Relying sites permitted to start an authorization (demo gate — spec 230 §6 + §8). */
const ALLOWED_RELYING_ORIGINS = ['https://agenticprimitives-demo-org.pages.dev'];
function parseEnrollReq(): EnrollReq | null {
  try {
    const p = new URL(window.location.href).searchParams;
    const clientId = p.get('client_id');
    const redirectUri = p.get('redirect_uri');
    const agentName = p.get('agent_name');
    const delegate = p.get('delegate');
    const codeChallenge = p.get('code_challenge');
    const template = p.get('delegation_template');
    if (!clientId || !redirectUri || !agentName || !delegate || !codeChallenge || !template) return null;
    // Code flow + S256 PKCE only (spec 230 §4.1/§8).
    const responseType = p.get('response_type');
    if (responseType && responseType !== 'code') return null;
    const ccm = p.get('code_challenge_method');
    if (ccm && ccm !== 'S256') return null;
    return {
      aud: clientId,
      redirectUri,
      state: p.get('state') ?? '',
      name: agentName,
      delegate: delegate as Address,
      nonce: p.get('nonce') ?? '',
      codeChallenge,
      template,
      orgBase: p.get('org_base') ?? undefined,
    };
  } catch {
    return null;
  }
}
function relyingAllowed(redirectUri: string): boolean {
  try {
    return ALLOWED_RELYING_ORIGINS.includes(new URL(redirectUri).origin);
  } catch {
    return false;
  }
}

// ── Shield SVG ───────────────────────────────────────────────────────────
// Shared between topbar, popup brand, and the large ceremony hero.
const ShieldLogo = ({ size = 24, gradient = false }: { size?: number; gradient?: boolean }) => {
  const id = gradient ? 'sg' : 'sp';
  return (
    <svg
      className="brand-shield"
      width={size} height={size}
      viewBox="0 0 40 46"
      fill="none"
      aria-hidden="true"
      style={{ width: size, height: size }}
    >
      {gradient && (
        <defs>
          <linearGradient id={`${id}-fill`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#818cf8" />
            <stop offset="55%" stopColor="#4338ca" />
            <stop offset="100%" stopColor="#3730a3" />
          </linearGradient>
          <radialGradient id={`${id}-glow`} cx="50%" cy="60%" r="50%">
            <stop offset="0%" stopColor="rgba(99,102,241,.45)" />
            <stop offset="100%" stopColor="rgba(99,102,241,0)" />
          </radialGradient>
          <filter id={`${id}-blur`}>
            <feGaussianBlur stdDeviation="3" result="blur" />
          </filter>
        </defs>
      )}
      {gradient && (
        <ellipse
          cx="20" cy="38" rx="18" ry="10"
          fill={`url(#${id}-glow)`}
          filter={`url(#${id}-blur)`}
          opacity=".65"
        />
      )}
      <path
        d="M20 1L37 7.5V21C37 30.389 29.832 38.234 20 41C10.168 38.234 3 30.389 3 21V7.5L20 1Z"
        fill={gradient ? `url(#${id}-fill)` : '#4338ca'}
      />
      <path
        d="M20 5L33 10.5V21C33 28.556 27.506 35.08 20 37.5C12.494 35.08 7 28.556 7 21V10.5L20 5Z"
        fill="white" fillOpacity={gradient ? '.14' : '.18'}
      />
      <path
        d="M14.5 22.5L18.5 26.5L26 18"
        stroke="white"
        strokeWidth={gradient ? '2.8' : '2.2'}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
};

/** The label part of a name (`alice.demo.agent` → `alice`; `alice` → `alice`). */
function labelOf(name: string): string {
  return name.trim().toLowerCase().replace(/\.demo\.agent$/, '').replace(/\.+$/, '').split('.')[0] ?? '';
}

/** Is this page served on the Connect central-auth domain family (apex or a
 *  personal subdomain)? Off it (localhost dev, pages.dev preview) we do NOT
 *  redirect — the passkey binds to the serving host, which is fine for dev. */
function onCentralAuthDomain(): boolean {
  const h = window.location.hostname;
  return h === CENTRAL_AUTH_DOMAIN || h.endsWith('.' + CENTRAL_AUTH_DOMAIN);
}

/** Subdomain-isolated passkeys (spec 229 P5): a ROOT passkey must be created at
 *  the person's OWN subdomain so its WebAuthn RP ID = `<label>.impact-agent.io`.
 *  If a passkey signup/connect is triggered for `name` while we're NOT on that
 *  subdomain (but ARE on the central-auth domain), navigate there carrying the
 *  intent; the page auto-resumes the ceremony on load. Returns true if it
 *  redirected (caller should stop). */
function redirectForPasskey(intent: 'signup' | 'connect', name: string): boolean {
  const label = labelOf(name);
  if (!label || !onCentralAuthDomain()) return false;
  if (window.location.hostname === `${label}.${CENTRAL_AUTH_DOMAIN}`) return false; // already home
  const u = new URL(`https://${label}.${CENTRAL_AUTH_DOMAIN}/`);
  u.searchParams.set(intent === 'signup' ? 'passkey_signup' : 'passkey_connect', label);
  window.location.href = u.toString();
  return true;
}

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [restoring, setRestoring] = useState<boolean>(shouldRestore);
  const [profile, setProfile] = useState<BasicProfile | null>(null);
  const [signupAvail, setSignupAvail] = useState<'idle' | 'checking' | 'available' | 'taken'>('idle');
  // Live signup progress, rendered as a modal checklist.
  const [signup, setSignup] = useState<
    | { phase: 'running' | 'done'; steps: string[] }
    | { phase: 'error'; steps: string[]; error: string }
    | null
  >(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sensitive, setSensitive] = useState<{ email: string; phone: string } | null>(null);
  const [stepUpMsg, setStepUpMsg] = useState<string | null>(null);
  const [desiredName, setDesiredName] = useState('');
  const [connectName, setConnectName] = useState('');
  // Subdomain-isolated passkey resume (spec 229 P5): set when we land on a
  // personal subdomain carrying a `passkey_signup`/`passkey_connect` intent.
  const [resume, setResume] = useState<{ intent: 'signup' | 'connect'; label: string } | null>(null);
  // Cross-device passkey (spec 233 P2) inline toggles: "set up this device" on the
  // sign-in card (new device) + "add a device" in the signed-in view (original).
  const [showSetupDevice, setShowSetupDevice] = useState(false);
  const [showApproveDevice, setShowApproveDevice] = useState(false);
  // Host→handle context (spec 229 P5): the handle this page serves when on a
  // personal subdomain (<handle>.impact-agent.me) — null on the apex / pages.dev /
  // localhost. This IS that agent's home: prefill the name + hide generic signup.
  const personalHandle = subdomainHandle();

  // On a personal subdomain, prefill the sign-in + claim name with the handle so
  // the user never retypes it (the name-info / availability effects then resolve).
  useEffect(() => {
    if (!personalHandle) return;
    setConnectName((p) => p || personalHandle);
    setDesiredName((p) => p || personalHandle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [connectErr, setConnectErr] = useState<string | null>(null);
  const [nameInfo, setNameInfo] = useState<{
    status: 'idle' | 'checking' | 'none' | 'found';
    name?: string;
    hasEoa?: boolean;
    hasPasskey?: boolean;
  }>({ status: 'idle' });
  const [googleNotice, setGoogleNotice] = useState<string | null>(null);
  const [service, setService] = useState<{ step?: string; error?: string; a2aAgent?: string } | null>(null);
  const [addCred, setAddCred] = useState<{ step?: string; error?: string; done?: string } | null>(null);
  // Central-auth enrollment request (when a relying site redirects here).
  const [enrollReq] = useState<EnrollReq | null>(parseEnrollReq);
  const [enrollFlow, setEnrollFlow] = useState<{ phase: 'idle' | 'running' | 'error'; msg?: string; error?: string }>({
    phase: 'idle',
  });
  // Guided sign-in/sign-up ceremony (spec 230 part 2): one screen per step, a device prompt
  // behind each, a receipt after — never two WebAuthn prompts back-to-back.
  const [ceremony, setCeremony] = useState<{
    step: 'consent' | 'busy' | 'key-ready' | 'agent-ready' | 'connected';
    busyStep?: number;
    busyMsg?: string;
    passkey?: DemoPasskey;
    agent?: Address;
    name?: string;
  }>({ step: 'consent' });
  // Does the requested name already have an agent on-chain? null = checking.
  // New user (no agent) → create the account here first (E1); existing → enroll-only (E2).
  const [enrollExists, setEnrollExists] = useState<boolean | null>(enrollReq ? null : false);
  // Which custodians the enroll target has → which "Approve with…" buttons to show.
  const [enrollCustody, setEnrollCustody] = useState<{ hasEoa: boolean; hasPasskey: boolean }>({ hasEoa: false, hasPasskey: false });

  const openSession = useCallback(async (token: string, via: string, fresh: boolean) => {
    setSession({ token, via, fresh });
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify({ token, via })); // survive page refresh
    } catch {
      /* storage blocked (private mode) — session just won't persist */
    }
    setProfile(await fetchProfile(token));
  }, []);

  // Enrollment request → does the name already have an agent? (new user vs existing).
  useEffect(() => {
    if (!enrollReq) return;
    void (async () => {
      try {
        const r = await fetch(`/connect/name-info?name=${encodeURIComponent(enrollReq.name)}`);
        const b = (await r.json()) as { exists?: boolean; hasEoa?: boolean; hasPasskey?: boolean };
        setEnrollExists(!!b.exists);
        setEnrollCustody({ hasEoa: !!b.hasEoa, hasPasskey: !!b.hasPasskey });
      } catch {
        setEnrollExists(false); // treat as new; the on-chain claim is still forced-unique
      }
    })();
  }, [enrollReq]);

  // Restore a persisted session on load (within the token's lifetime), unless we're
  // mid Google-redirect (?code / connect_status) — that path mints its own session.
  useEffect(() => {
    if (!restoring) return;
    void (async () => {
      try {
        const raw = localStorage.getItem(SESSION_KEY);
        if (!raw) return;
        const stored = JSON.parse(raw) as { token?: string; via?: string };
        if (!stored.token || !stored.via) {
          localStorage.removeItem(SESSION_KEY);
          return;
        }
        // Validate against the broker: an expired/invalid token yields no profile → drop it.
        const p = await fetchProfile(stored.token);
        if (!p) {
          localStorage.removeItem(SESSION_KEY);
          return;
        }
        setSession({ token: stored.token, via: stored.via, fresh: false });
        setProfile(p);
      } finally {
        setRestoring(false);
      }
    })();
  }, [restoring]);

  // Real Google OIDC return: ?code → exchange → token (login-grade session).
  useEffect(() => {
    const url = new URL(window.location.href);
    // Google bootstrap (no agent linked to this subject yet) — the callback redirects
    // back here with a status instead of dead-ending on a JSON page.
    const connectStatus = url.searchParams.get('connect_status');
    if (connectStatus) {
      const email = url.searchParams.get('email');
      const reason = url.searchParams.get('reason');
      if (connectStatus === 'linked') {
        setGoogleNotice(
          `✓ Google${email ? ` (${email})` : ''} is now linked to your workspace — next time you can sign in with Google.`,
        );
      } else if (connectStatus === 'link_failed') {
        setGoogleNotice(`Couldn't link Google: ${reason ?? 'please try again'}.`);
      } else {
        setGoogleNotice(
          `We recognized your Google account${email ? ` (${email})` : ''}, but no workspace is linked to it yet. ` +
            `Create one with a wallet/passkey — or sign in with your wallet/passkey and use "Link Google".`,
        );
      }
      for (const k of ['connect_status', 'via', 'email', 'reason']) url.searchParams.delete(k);
      window.history.replaceState({}, '', url.toString());
      return;
    }
    const code = url.searchParams.get('code');
    if (!code) return;
    (async () => {
      try {
        const token = await exchangeCode(code, AUD);
        await openSession(token, 'Google', true);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Google sign-in failed');
      } finally {
        url.searchParams.delete('code');
        url.searchParams.delete('state');
        window.history.replaceState({}, '', url.toString());
      }
    })();
  }, [openSession]);

  // As the user types an agent name, check on-chain: does it exist, and which custody
  // credentials does it have? → only offer passkey / wallet that actually exist on it.
  useEffect(() => {
    const name = connectName.trim();
    if (!name) {
      setNameInfo({ status: 'idle' });
      return;
    }
    setNameInfo({ status: 'checking' });
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/connect/name-info?name=${encodeURIComponent(name)}`);
        const b = (await r.json()) as { exists?: boolean; name?: string; hasEoa?: boolean; hasPasskey?: boolean };
        setNameInfo(
          b.exists
            ? { status: 'found', name: b.name, hasEoa: b.hasEoa, hasPasskey: b.hasPasskey }
            : { status: 'none' },
        );
      } catch {
        setNameInfo({ status: 'idle' });
      }
    }, 400);
    return () => clearTimeout(t);
  }, [connectName]);

  // Signup name availability: block signing up with an EXISTING agent name.
  useEffect(() => {
    const name = desiredName.trim();
    if (!name) {
      setSignupAvail('idle');
      return;
    }
    setSignupAvail('checking');
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/connect/name-info?name=${encodeURIComponent(name)}`);
        const b = (await r.json()) as { exists?: boolean };
        setSignupAvail(b.exists ? 'taken' : 'available');
      } catch {
        setSignupAvail('idle');
      }
    }, 400);
    return () => clearTimeout(t);
  }, [desiredName]);

  // Subdomain-isolated passkey resume (spec 229 P5). We were redirected to this
  // personal subdomain to run the ROOT-passkey ceremony here (RP ID = this host).
  // Prefill the matching name input + arm the flow; the availability /
  // name-info effects + the auto-run effect below carry it to completion.
  useEffect(() => {
    const p = new URL(window.location.href).searchParams;
    const sup = p.get('passkey_signup');
    const con = p.get('passkey_connect');
    if (!sup && !con) return;
    const home = subdomainHandle();
    if (home && sup === home) {
      setDesiredName(home);
      setResume({ intent: 'signup', label: home });
    } else if (home && con === home) {
      setConnectName(home);
      setResume({ intent: 'connect', label: home });
    }
    p.delete('passkey_signup');
    p.delete('passkey_connect');
    const u = new URL(window.location.href);
    u.search = p.toString();
    window.history.replaceState({}, '', u.toString());
  }, []);

  // Fire the armed passkey flow once its supporting state is ready. Signup waits
  // for the availability check (and falls back to connect if the name now
  // exists); connect can fire immediately.
  useEffect(() => {
    if (!resume || busy) return;
    if (resume.intent === 'connect') {
      setResume(null);
      void onConnectName('passkey');
    } else if (signupAvail === 'available') {
      setResume(null);
      void onSignup('passkey');
    } else if (signupAvail === 'taken') {
      setResume(null);
      setConnectName(resume.label);
      void onConnectName('passkey');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resume, signupAvail, busy]);

  // Connect by agent-service name: resolve name → agent → prove with a custody
  // credential (the name is the identity; any custodian credential gets you in).
  async function onConnectName(via: 'wallet' | 'passkey') {
    if (!connectName.trim()) return;
    // Passkeys are bound to their subdomain — sign in at the person's own home
    // (spec 229 P5). If we're not there yet, redirect; the subdomain resumes.
    if (via === 'passkey' && redirectForPasskey('connect', connectName)) return;
    setConnectErr(null);
    setBusy(true);
    try {
      const out = await connectWithName(connectName.trim(), via);
      if (out.ok) await openSession(out.token, via, false);
      else setConnectErr(out.error);
    } catch (e) {
      setConnectErr(e instanceof Error ? e.message : 'connect failed');
    } finally {
      setBusy(false);
    }
  }

  // Sign up: create a NEW workspace with the chosen name + a fresh custody credential.
  // Blocked unless the name is available (not an existing agent name).
  async function onSignup(via: 'wallet' | 'passkey') {
    const base = desiredName.trim();
    if (!base || signupAvail !== 'available') return;
    // The ROOT passkey must be created at the person's OWN subdomain so its
    // WebAuthn RP ID = <label>.impact-agent.io (spec 229 P5). Redirect there
    // first; the subdomain auto-resumes the signup once it loads.
    if (via === 'passkey' && redirectForPasskey('signup', base)) return;
    setError(null);
    setBusy(true);
    const steps: string[] = [];
    setSignup({ phase: 'running', steps: [] });
    const onStep = (s: string) => {
      steps.push(s);
      setSignup({ phase: 'running', steps: [...steps] });
    };
    try {
      const out = await signupWithName(base, via, onStep);
      if (!out.ok) {
        setSignup({ phase: 'error', steps: [...steps], error: out.error });
        return;
      }
      // Show the finished checklist for a beat, then drop into the home page.
      setSignup({ phase: 'done', steps: [...steps] });
      await new Promise((r) => setTimeout(r, 900));
      await openSession(out.token, via, true);
      // Clear connect/signup inputs so no stale name lingers if the user signs out.
      setDesiredName('');
      setConnectName('');
      setSignupAvail('idle');
      setNameInfo({ status: 'idle' });
      setConnectErr(null);
      setSignup(null);
    } catch (e) {
      setSignup({ phase: 'error', steps: [...steps], error: e instanceof Error ? e.message : 'signup failed' });
    } finally {
      setBusy(false);
    }
  }

  async function onRevealSensitive() {
    if (!session) return;
    setStepUpMsg(null);
    // Login-grade (Google): the canonical agent is custody-controlled by a wallet/passkey,
    // so fire the wallet step-up IMMEDIATELY on this click (a gesture is required for the
    // wallet to prompt — so we can't auto-fire on render, but this is one click → MetaMask).
    if (session.via === 'Google') {
      await stepUp('wallet');
      return;
    }
    const r = await fetchSensitive(session.token);
    if (r.ok) setSensitive({ email: r.email, phone: r.phone });
    else setStepUpMsg(r.reason);
  }

  // Step a Google (login-grade) session UP to custody-grade for the SAME bound agent
  // (server enforces target = googleToken.sub). The credential must be a custodian of
  // that agent — so a Google login flows into exactly ONE workspace (ADR-0017).
  async function stepUp(via: 'wallet' | 'passkey') {
    if (!session) return;
    setStepUpMsg(`Confirming with your ${via === 'wallet' ? 'wallet' : 'device'}…`);
    try {
      const out = await stepUpToAgent(via, session.token);
      if (!out.ok) {
        setStepUpMsg(out.error);
        return;
      }
      await openSession(out.token, via, false); // custody-grade for the SAME agent
      setStepUpMsg(null);
      const r = await fetchSensitive(out.token); // auto-reveal now that we're custody-grade
      if (r.ok) setSensitive({ email: r.email, phone: r.phone });
    } catch (e) {
      setStepUpMsg(e instanceof Error ? e.message : 'step-up failed');
    }
  }

  async function onProvisionService() {
    if (!session || !profile || session.via === 'Google') return;
    const personAddr = profile.agent.split(':').pop() as Address;
    setService({ step: 'Starting…' });
    const res = await provisionA2aAgent(session.via as 'wallet' | 'passkey', personAddr, (step) =>
      setService((s) => ({ ...s, step })),
    );
    setService(res.ok ? { a2aAgent: res.result.a2aAgent } : { error: res.error });
  }

  // Add the COMPLEMENTARY custody credential to this agent: wallet→add passkey,
  // passkey→add wallet. The existing credential signs the on-chain addCustodian/
  // addPasskey; the SA address is unchanged (ADR-0011).
  async function onAddCredential() {
    if (!session || !profile || session.via === 'Google') return;
    const personAddr = profile.agent.split(':').pop() as Address;
    setAddCred({ step: 'Starting…' });
    try {
      const onStep = (s: string) => setAddCred({ step: s });
      if (session.via === 'passkey') {
        const r = await addWalletCredential(personAddr, onStep);
        setAddCred(r.ok ? { done: `Wallet ${r.added.slice(0, 6)}…${r.added.slice(-4)} added` } : { error: r.error });
      } else {
        const r = await addPasskeyCredential(personAddr, onStep);
        setAddCred(r.ok ? { done: 'Passkey added' } : { error: r.error });
      }
    } catch (e) {
      setAddCred({ error: e instanceof Error ? e.message : 'add credential failed' });
    }
  }

  function signOut() {
    setSession(null);
    setProfile(null);
    setSensitive(null);
    setStepUpMsg(null);
    setService(null);
    setAddCred(null);
    setError(null);
    try {
      localStorage.removeItem(SESSION_KEY);
    } catch {
      /* ignore */
    }
    // Reset the connect/signup screen so a just-used name doesn't linger as stale.
    setDesiredName('');
    setConnectName('');
    setSignupAvail('idle');
    setNameInfo({ status: 'idle' });
    setConnectErr(null);
  }

  // Approve the relying site's request. Two paths (spec 229 §5):
  //  · NEW user (name has no agent yet): create the home account here first — a ROOT
  //    passkey on THIS origin + deploy the agent + claim the name — THEN add the site's
  //    public key as a custodian.
  //  · EXISTING agent: just add the site's public key, signed by the primary passkey here.
  // Popup mode: opened by a relying site via window.open(?mode=popup). We post the result
  // back to the opener instead of redirecting, then self-close.
  const popupMode =
    !!enrollReq && !!window.opener && new URL(window.location.href).searchParams.get('mode') === 'popup';
  // Post to the opener ONLY at the validated relying origin (audit F3 — exact targetOrigin,
  // never '*'); refuse if the redirect_uri isn't an allowed relying origin.
  function postToOpener(msg: Record<string, unknown>) {
    if (!enrollReq || !window.opener || !relyingAllowed(enrollReq.redirectUri)) return;
    try {
      window.opener.postMessage(msg, new URL(enrollReq.redirectUri).origin);
    } catch {
      /* ignore */
    }
  }

  // Turn the verified ROOT-passkey ceremony into an OIDC authorization code (spec 230 §4.2):
  // POST the passkey proof + the client-signed delegation (+ org payload) to /oidc/grant,
  // which mints the id_token and stashes {id_token, delegation, org} under a single-use code
  // bound to the PKCE code_challenge. Returns the code; the relying site exchanges it at /token.
  async function submitGrant(resolvedName: string, delegationWire: unknown, org?: unknown): Promise<string> {
    if (!enrollReq) throw new Error('no request');
    // No separate passkey assertion: the just-signed delegation IS the proof-of-possession
    // (the grant verifies it via ERC-1271). One fewer device prompt.
    const r = await fetch('/oidc/grant', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: enrollReq.aud,
        redirect_uri: enrollReq.redirectUri,
        nonce: enrollReq.nonce,
        code_challenge: enrollReq.codeChallenge,
        agent_name: resolvedName,
        delegation_template: enrollReq.template,
        delegation: delegationWire,
        org,
      }),
    });
    const b = (await r.json().catch(() => ({}))) as { code?: string; error?: string };
    if (!r.ok || !b.code) throw new Error(b.error ?? `grant failed (HTTP ${r.status})`);
    return b.code;
  }

  // Deliver the authorization code back to the relying site (popup postMessage, exact origin;
  // or full-page redirect ?code&state). The token never travels in the URL — only the code.
  function deliverCode(code: string) {
    if (!enrollReq) return;
    if (popupMode) {
      postToOpener({ type: 'AC_SUCCESS', state: enrollReq.state, code });
      window.close();
      return;
    }
    const url = new URL(enrollReq.redirectUri);
    url.searchParams.set('code', code);
    url.searchParams.set('state', enrollReq.state);
    window.location.href = url.toString();
  }

  // ── Guided sign-in/sign-up ceremony (spec 230 part 2) ──────────────
  // Each WebAuthn prompt is its own button-gated step with a promise before + a receipt after.
  const ceremonyFail = (e: unknown) =>
    setEnrollFlow({ phase: 'error', error: e instanceof Error ? e.message : 'something went wrong' });

  // NEW USER · Step 1 — create the secure-home key (one prompt).
  async function onCreateKey() {
    if (!enrollReq) return;
    setCeremony({ step: 'busy', busyStep: 1, busyMsg: 'Creating your secure key…' });
    try {
      const passkey = await createSecureHomePasskey(enrollReq.name);
      setCeremony({ step: 'key-ready', passkey });
    } catch (e) {
      ceremonyFail(e);
    }
  }

  // NEW USER · Step 2 — deploy + claim the agent's name (one prompt).
  async function onSetupAgent() {
    if (!enrollReq || !ceremony.passkey) return;
    const passkey = ceremony.passkey;
    setCeremony((c) => ({ ...c, step: 'busy', busyStep: 2, busyMsg: whitelabel.copy.portalStepBusy }));
    try {
      const base = enrollReq.name.replace(/\.demo\.agent$/, '');
      const res = await deployAndClaimAgent(passkey, base);
      if (!res.ok) return ceremonyFail(res.error);
      setCeremony((c) => ({ ...c, step: 'agent-ready', agent: res.agent, name: res.name }));
    } catch (e) {
      ceremonyFail(e);
    }
  }

  // Final step (new + existing) — approve the app: issue the scoped grant + mint the OIDC code.
  // `via` chooses which custodian signs the site delegation: the ROOT passkey (default) or a
  // wallet (EOA) custodian — both are custodians of the person SA, so either can sign (ADR-0019).
  async function onApproveApp(via: 'passkey' | 'wallet' = 'passkey') {
    if (!enrollReq) return;
    const approvingStep = ceremony.agent ? 3 : 1;
    const authorizeBusy = fmt(whitelabel.copy.authorizeStepBusy, { app: hostOf(enrollReq.redirectUri) });
    setCeremony((c) => ({ ...c, step: 'busy', busyStep: approvingStep, busyMsg: authorizeBusy }));
    if (popupMode) postToOpener({ type: 'AC_PROGRESS', msg: authorizeBusy });
    try {
      let agent = ceremony.agent;
      let name = ceremony.name ?? enrollReq.name;
      if (!agent) {
        // Existing agent: resolve by name (long-claimed → no RPC lag).
        const info = (await (await fetch(`/connect/name-info?name=${encodeURIComponent(enrollReq.name)}`)).json()) as {
          agent?: Address;
        };
        if (!info.agent) return ceremonyFail(`could not resolve ${enrollReq.name}`);
        agent = info.agent;
        name = enrollReq.name;
      }
      let signHash = passkeySignHash;
      if (via === 'wallet') {
        const addr = await connectWallet(); // an EOA custodian of the person SA signs the delegation
        signHash = (h) => personalSign(addr, h);
      }
      const delegation = await issueSiteDelegation(agent, enrollReq.delegate, signHash);
      const code = await submitGrant(name, toWire(delegation));
      setCeremony((c) => ({ ...c, step: 'connected' }));
      setTimeout(() => deliverCode(code), 1000); // hold the "✓ Connected" receipt briefly, then hand back
    } catch (e) {
      ceremonyFail(e);
    }
  }

  // org-create (memory project_demo_org_durable_org_custody): create a child agent (org now;
  // any service agent later) custodied by the person's ROOT passkey HERE; hand the relying site
  // a scoped child→site delegation (the OIDC delegation sidecar) + the org payload. Never a custodian.
  async function approveCreateOrg() {
    if (!enrollReq?.orgBase) return;
    const onStep = (s: string) => {
      setEnrollFlow({ phase: 'running', msg: s });
      if (popupMode) postToOpener({ type: 'AC_PROGRESS', msg: s });
    };
    setEnrollFlow({ phase: 'running', msg: 'Starting…' });
    try {
      const info = (await (await fetch(`/connect/name-info?name=${encodeURIComponent(enrollReq.name)}`)).json()) as {
        agent?: Address;
      };
      if (!info.agent) {
        setEnrollFlow({ phase: 'error', error: `could not resolve ${enrollReq.name}` });
        return;
      }
      const created = await createChildAgentForSite(info.agent, enrollReq.orgBase, enrollReq.delegate, onStep);
      if (!created.ok) {
        setEnrollFlow({ phase: 'error', error: created.error });
        return;
      }
      const org = {
        orgAgent: created.result.childAgent,
        orgName: created.result.childName,
        edgeId: created.result.edgeId,
        governed: created.result.governed,
      };
      // The org→site delegation is the OIDC delegation sidecar; the org payload rides alongside.
      const code = await submitGrant(enrollReq.name, created.result.delegation, org);
      deliverCode(code);
    } catch (e) {
      setEnrollFlow({ phase: 'error', error: e instanceof Error ? e.message : 'org creation failed' });
    }
  }
  function denyEnroll() {
    if (!enrollReq) return;
    if (popupMode) {
      postToOpener({ type: 'AC_CANCEL', state: enrollReq.state });
      window.close();
      return;
    }
    const url = new URL(enrollReq.redirectUri);
    url.searchParams.set('enroll_error', 'denied');
    url.searchParams.set('state', enrollReq.state);
    window.location.href = url.toString();
  }

  // ════════════════════════════════════════════════════════════════════
  // POPUP / CONSENT SCREENS
  // Rendered when demo-sso is opened as a central auth popup or redirect.
  // ════════════════════════════════════════════════════════════════════
  if (enrollReq) {
    const host = (() => {
      try {
        return new URL(enrollReq.redirectUri).host;
      } catch {
        return enrollReq.aud;
      }
    })();
    const personalLabel = enrollReq.name.replace(/\.demo\.agent$/, '');
    const personalUrl = `${personalLabel}.${CENTRAL_AUTH_DOMAIN}`;
    const allowed = relyingAllowed(enrollReq.redirectUri);
    const isNew = enrollExists === false; // name has no agent yet → create the home account
    const running = enrollFlow.phase === 'running';
    const orgName = enrollReq.orgBase ? `${enrollReq.orgBase.replace(/\.demo\.agent$/, '')}.demo.agent` : '';

    // Shared brand topbar — names the IdP + signposts arrival at "your secure home" (the
    // distinct identity from the relying app you came from).
    const Topbar = () => (
      <div className="popup-topbar" role="banner">
        <div className="popup-brand">
          <ShieldLogo size={20} />
          <span>{whitelabel.brand.name}</span>
          <span className="popup-brand-sub">· your secure home</span>
        </div>
      </div>
    );

    // ── Not-allowed ──────────────────────────────────────────────────
    if (!allowed) {
      return (
        <div className="popup-root">
          <Topbar />
          <div className="popup-scroll">
            <div className="popup-heading">
              <h1>Request blocked</h1>
            </div>
            <div className="blocked-card">
              <div className="blocked-icon">⛔</div>
              <p style={{ fontWeight: 700, color: 'var(--c-g900)', marginBottom: '.35rem', fontSize: '.9375rem' }}>
                {host} is not a recognized site
              </p>
              <p style={{ fontSize: '.8375rem', color: 'var(--c-g500)', margin: 0 }}>
                For your safety this request was blocked. Only start account setup from a site you trust.
              </p>
            </div>
            <div className="privacy-footer">
              🔒 You're in control. Your data stays private.
            </div>
          </div>
        </div>
      );
    }

    // ── Checking ─────────────────────────────────────────────────────
    if (enrollExists === null) {
      return (
        <div className="popup-root">
          <Topbar />
          <div className="popup-scroll">
            <div className="popup-heading">
              <h1>One moment…</h1>
            </div>
            <div className="ceremony-card">
              <div className="ceremony-spinner-wrap">
                <span className="spinner spinner-lg" role="status" aria-label="Checking account" />
              </div>
              <p style={{ color: 'var(--c-g500)', fontSize: '.875rem', margin: 0, fontWeight: 500 }}>
                Checking your account…
              </p>
            </div>
            <div className="privacy-footer">
              🔒 You're in control. Your data stays private.
            </div>
          </div>
        </div>
      );
    }

    // ── Running / ceremony in progress ───────────────────────────────
    if (running) {
      return (
        <div className="popup-root">
          <Topbar />
          <div className="popup-scroll">
            <div className="popup-heading">
              <h1>Confirm with your device</h1>
            </div>
            <div className="ceremony-card">
              <div className="ceremony-spinner-wrap">
                <span className="spinner spinner-lg" role="status" aria-label="Working" />
              </div>
              <p style={{ fontWeight: 700, fontSize: '.9375rem', color: 'var(--c-g900)', marginBottom: '.3rem' }}>
                {enrollFlow.msg ?? 'Working…'}
              </p>
              <p style={{ fontSize: '.8rem', color: 'var(--c-g500)', margin: 0 }}>
                Your device may ask you to confirm. This usually takes a few seconds.
              </p>
            </div>
            <div className="privacy-footer">
              🔒 You're in control. Your data stays private.
            </div>
          </div>
        </div>
      );
    }

    // ── Error state ───────────────────────────────────────────────────
    if (enrollFlow.phase === 'error') {
      return (
        <div className="popup-root">
          <Topbar />
          <div className="popup-scroll">
            <div className="popup-heading">
              <h1>Something went wrong</h1>
            </div>
            <div className="error-card">
              <p className="error-card-title">Approval failed</p>
              <p className="error-card-body">{enrollFlow.error}</p>
            </div>
            <p style={{ fontSize: '.8375rem', color: 'var(--c-g500)', marginBottom: '.5rem' }}>
              Nothing was changed. You can try again.
            </p>
            <div className="privacy-footer">
              🔒 You're in control. Your data stays private.
            </div>
          </div>
          <div className="popup-actions">
            {enrollReq.orgBase ? (
              <button className="cta" onClick={approveCreateOrg}>Try again</button>
            ) : (
              <button
                className="cta"
                onClick={() => {
                  setEnrollFlow({ phase: 'idle' });
                  setCeremony({ step: 'consent' });
                }}
              >
                Try again
              </button>
            )}
            <button className="cta ghost" onClick={denyEnroll}>Cancel</button>
          </div>
        </div>
      );
    }

    // ── Org-create consent ────────────────────────────────────────────
    if (enrollReq.orgBase) {
      return (
        <div className="popup-root">
          <Topbar />
          <div className="popup-scroll">
            <div className="popup-heading">
              <h1>Allow org data access?</h1>
            </div>

            <div className="entity-chip">
              <div className="entity-chip-icon" aria-hidden="true">🏢</div>
              <div className="entity-chip-meta">
                <div className="entity-chip-name">{orgName}</div>
                <div className="entity-chip-sub">{host}</div>
              </div>
              <span className="entity-chip-badge">New org</span>
            </div>

            <div className="perm-card can">
              <div className="perm-card-title">This app can:</div>
              <ul className="perm-list">
                <li>
                  <span className="perm-icon ok" aria-hidden="true">✓</span>
                  View approved org records for this session
                </li>
                <li>
                  <span className="perm-icon ok" aria-hidden="true">✓</span>
                  Create this organization under your identity
                </li>
              </ul>
            </div>

            <details className="cannot-disclosure">
              <summary>What it cannot do</summary>
              <div className="perm-card cannot">
                <ul className="perm-list">
                  <li><span className="perm-icon no" aria-hidden="true">✕</span>Change organization access</li>
                  <li><span className="perm-icon no" aria-hidden="true">✕</span>Add members or move funds</li>
                  <li><span className="perm-icon no" aria-hidden="true">✕</span>Act outside this permission</li>
                </ul>
              </div>
            </details>

            <p style={{ fontSize: '.7rem', color: 'var(--c-g400)', margin: '.375rem 0 0', lineHeight: 1.5 }}>
              Permission for this app only. You can revoke it later from your secure home.
            </p>
            <div className="privacy-footer">
              🔒 You're in control. You can revoke access anytime.
            </div>
          </div>
          <div className="popup-actions">
            <button className="cta" onClick={approveCreateOrg}>
              Create &amp; approve with your device
            </button>
            <button className="cta ghost" onClick={denyEnroll}>Deny</button>
          </div>
        </div>
      );
    }

    // ── Sign-in / sign-up: GUIDED CEREMONY (spec 230 part 2) ──────────
    // One screen per step, a device prompt behind each button, a receipt after. New user = 3
    // steps (key → agent → approve); existing agent = 1 step (approve). Never two prompts back-to-back.
    const totalSteps = isNew ? 3 : 1;
    const StepBadge = ({ n }: { n: number }) =>
      <div className="step-pill">Step {n} of {totalSteps}</div>;
    const Receipt = ({ children }: { children: ReactNode }) => (
      <div className="receipt-chip"><span className="receipt-tick" aria-hidden="true">✓</span>{children}</div>
    );
    const CannotDetails = () => (
      <details className="cannot-disclosure">
        <summary>What it cannot do</summary>
        <div className="perm-card cannot">
          <ul className="perm-list">
            <li><span className="perm-icon no" aria-hidden="true">✕</span>Change your passkeys or recover your Smart Agent</li>
            <li><span className="perm-icon no" aria-hidden="true">✕</span>Move funds without your approval</li>
            <li><span className="perm-icon no" aria-hidden="true">✕</span>Act outside this permission</li>
          </ul>
        </div>
      </details>
    );

    // Busy (a device prompt is happening / on-chain work in flight).
    if (ceremony.step === 'busy') {
      return (
        <div className="popup-root">
          <Topbar />
          <div className="popup-scroll">
            <StepBadge n={ceremony.busyStep ?? 1} />
            <div className="popup-heading"><h1>Confirm with your device</h1></div>
            <div className="ceremony-card">
              <div className="ceremony-spinner-wrap"><span className="spinner spinner-lg" role="status" aria-label="Working" /></div>
              <p style={{ fontWeight: 700, fontSize: '.9375rem', color: 'var(--c-g900)', marginBottom: '.3rem' }}>
                {ceremony.busyMsg ?? 'Working…'}
              </p>
              <p style={{ fontSize: '.8rem', color: 'var(--c-g500)', margin: 0 }}>
                Your device may ask you to confirm. This takes a few seconds.
              </p>
            </div>
            <div className="privacy-footer">🔒 You're in control. Your data stays private.</div>
          </div>
        </div>
      );
    }

    // Step 1 receipt → Step 2 promise (set up the agent).
    if (ceremony.step === 'key-ready') {
      return (
        <div className="popup-root">
          <Topbar />
          <div className="popup-scroll">
            <StepBadge n={2} />
            <div className="popup-heading"><h1>{whitelabel.copy.portalStepTitle}</h1></div>
            <Receipt>Secure key created on this device</Receipt>
            <p style={{ fontSize: '.875rem', color: 'var(--c-g500)', margin: '.5rem 0 0', lineHeight: 1.55 }}>
              {whitelabel.copy.portalStepValue} One confirmation brings <strong>{enrollReq.name}</strong> to
              life as your Portal — and claims your place in the {whitelabel.brand.community}.
            </p>
            <div className="privacy-footer">🔒 You're in control. Your data stays private.</div>
          </div>
          <div className="popup-actions">
            <button className="cta" onClick={onSetupAgent}>Create my Portal</button>
            <button className="cta ghost" onClick={denyEnroll}>Cancel</button>
          </div>
        </div>
      );
    }

    // Step 2 receipt → Step 3 promise (approve the app — concrete consent).
    if (ceremony.step === 'agent-ready') {
      return (
        <div className="popup-root">
          <Topbar />
          <div className="popup-scroll">
            <StepBadge n={3} />
            <div className="popup-heading"><h1>{fmt(whitelabel.copy.authorizeStepTitle, { app: host })}</h1></div>
            <div className="agent-badge-card">
              <div className="agent-badge-shield"><ShieldLogo size={64} gradient /></div>
              <div className="agent-badge-kicker">Your Portal is live</div>
              <div className="agent-badge-name">{ceremony.name ?? enrollReq.name}</div>
              <div className="agent-badge-sub">You're now part of the {whitelabel.brand.community}.</div>
            </div>
            {/* Value steps ① + ② just completed — two receipts off the single setup confirmation. */}
            <Receipt>{whitelabel.copy.portalStepReceipt}</Receipt>
            <Receipt>{fmt(whitelabel.copy.communityStepReceipt, { name: ceremony.name ?? enrollReq.name })}</Receipt>
            <p style={{ fontSize: '.8375rem', color: 'var(--c-g500)', margin: '.75rem 0 .5rem', lineHeight: 1.55 }}>
              {fmt(whitelabel.copy.authorizeStepValue, { app: host })}
            </p>
            <div className="perm-card can">
              <div className="perm-card-title">{host} can:</div>
              <ul className="perm-list">
                <li><span className="perm-icon ok" aria-hidden="true">✓</span>Sign you in as <strong>{ceremony.name ?? enrollReq.name}</strong></li>
                <li><span className="perm-icon ok" aria-hidden="true">✓</span>Create approved workspaces and read approved profile data</li>
              </ul>
            </div>
            <CannotDetails />
            <div className="privacy-footer">🔒 Permission for this app only. Revoke anytime.</div>
          </div>
          <div className="popup-actions">
            <button className="cta" onClick={() => onApproveApp('passkey')}>{fmt(whitelabel.copy.authorizeStepCta, { app: host })}</button>
            <button className="cta ghost" onClick={denyEnroll}>Deny</button>
          </div>
        </div>
      );
    }

    // Final receipt (held ~1s before handing back to the app).
    if (ceremony.step === 'connected') {
      return (
        <div className="popup-root">
          <Topbar />
          <div className="popup-scroll">
            <div className="popup-heading"><h1>Connected</h1></div>
            <div className="agent-badge-card">
              <div className="agent-badge-shield"><ShieldLogo size={72} gradient /></div>
              <div className="agent-badge-kicker">You're connected</div>
              <div className="agent-badge-name">{ceremony.name ?? enrollReq.name}</div>
              <div className="agent-badge-sub">{host} is now a connected app. You can revoke it anytime.</div>
            </div>
            <div className="privacy-footer">Returning you to {host}…</div>
          </div>
        </div>
      );
    }

    // Step 0 — consent (the promise before the FIRST device prompt).
    return (
      <div className="popup-root">
        <Topbar />
        <div className="popup-scroll">
          <StepBadge n={1} />
          {/* What you get — the agent name is the centrepiece */}
          {isNew ? (
            <div className="agent-home-card">
              <div className="agent-home-hero">
                <ShieldLogo size={70} gradient />
                <div className="agent-home-url">{personalUrl}</div>
              </div>
              <div className="agent-grant-label">{whitelabel.copy.arrivalTitle}</div>
              <div className="agent-grant-name">{enrollReq.name}</div>
              <div className="agent-grant-sub">{whitelabel.copy.arrivalBody}</div>
            </div>
          ) : (
            <div className="agent-home-card">
              <div className="agent-home-hero">
                <ShieldLogo size={58} gradient />
                <div className="agent-home-url">{personalUrl}</div>
              </div>
              <div className="agent-grant-label">Welcome back to your {whitelabel.brand.name} portal</div>
              <div className="agent-grant-name">{enrollReq.name}</div>
              <div className="agent-grant-sub">{host} is asking to connect as an approved app.</div>
            </div>
          )}

          {/* New user: preview the three value steps up front (value ≠ signatures —
              comprehension first). They're set up with the fewest device prompts. */}
          {isNew && (
            <div className="value-overview">
              <div className="value-overview-title">{whitelabel.copy.overviewTitle}</div>
              <ol className="value-steps">
                <li>
                  <span className="value-step-n">1</span>
                  <div>
                    <div className="value-step-title">{whitelabel.copy.portalStepTitle}</div>
                    <div className="value-step-value">{whitelabel.copy.portalStepValue}</div>
                  </div>
                </li>
                <li>
                  <span className="value-step-n">2</span>
                  <div>
                    <div className="value-step-title">{whitelabel.copy.communityStepTitle}</div>
                    <div className="value-step-value">{whitelabel.copy.communityStepValue}</div>
                  </div>
                </li>
                <li>
                  <span className="value-step-n">3</span>
                  <div>
                    <div className="value-step-title">{fmt(whitelabel.copy.authorizeStepTitle, { app: host })}</div>
                    <div className="value-step-value">{fmt(whitelabel.copy.authorizeStepValue, { app: host })}</div>
                  </div>
                </li>
              </ol>
            </div>
          )}

          <div className="first-step-note">
            <strong>{isNew ? 'First, create your secure key.' : 'Review this connected app request.'}</strong>
            <span>
              {isNew
                ? `Your device confirms once to make this Portal yours. ${host} only gets the access you approve at the end.`
                : `${host} only gets the permission you approve here.`}
            </span>
          </div>

          {!isNew && <CannotDetails />}
          <div className="privacy-footer">🔒 Permission for this app only. Revoke anytime.</div>
        </div>
        <div className="popup-actions">
          {isNew ? (
            <button className="cta" onClick={onCreateKey}>{whitelabel.copy.portalStepCta}</button>
          ) : (
            <>
              {/* Approve with whichever custodian(s) this agent has (spec 230 / ADR-0019). */}
              {(enrollCustody.hasPasskey || !enrollCustody.hasEoa) && (
                <button className="cta" onClick={() => onApproveApp('passkey')}>Approve with passkey</button>
              )}
              {enrollCustody.hasEoa && (
                <button className="cta ghost" onClick={() => onApproveApp('wallet')}>Approve with wallet</button>
              )}
            </>
          )}
          <button className="cta ghost" onClick={denyEnroll}>{isNew ? 'Cancel' : 'Deny'}</button>
        </div>
        {/* New device arriving from a relying site with no passkey for this agent?
            Set one up here + link it from a device that has yours (spec 233 P2). */}
        {!isNew && (
          <div style={{ padding: '0 1.25rem 1rem' }}>
            {showSetupDevice ? (
              <NewDevice prefillName={enrollReq.name} />
            ) : (
              <button
                onClick={() => setShowSetupDevice(true)}
                style={{ fontSize: '.78rem', background: 'none', border: 'none', color: 'var(--c-g500)', textDecoration: 'underline', cursor: 'pointer', padding: 0 }}
              >
                No passkey on this device? Set up this device →
              </button>
            )}
          </div>
        )}
      </div>
    );
  }

  // ════════════════════════════════════════════════════════════════════
  // STANDALONE APP (demo-sso's own home page)
  // ════════════════════════════════════════════════════════════════════

  const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

  return (
    <div id="app-root" style={{ display: 'flex', flexDirection: 'column', minHeight: '100dvh' }}>

      {/* Standalone top bar */}
      <header className="standalone-topbar">
        <div className="standalone-topbar-inner">
          <div className="standalone-brand">
            <ShieldLogo size={26} />
            {session && session.via !== 'Google' && profile?.name
              ? profile.name
              : whitelabel.brand.name}
          </div>
          {session && (
            <button
              className="ghost"
              style={{ fontSize: '.8125rem', padding: '.35rem .75rem', minHeight: '36px' }}
              onClick={signOut}
            >
              Sign out
            </button>
          )}
        </div>
      </header>

      <div className="app-shell">

        {error && (
          <div role="alert" style={{
            background: 'var(--c-danger-bg)', border: '1px solid var(--c-danger-border)',
            borderRadius: 'var(--r-md)', padding: '.75rem 1rem', marginBottom: '1rem',
            fontSize: '.875rem', color: 'var(--c-danger)',
          }}>
            {error}
          </div>
        )}

        {restoring && !session && (
          <div style={{ textAlign: 'center', padding: '3rem 0', color: 'var(--c-g400)' }}>
            <span className="spinner spinner-lg" aria-label="Restoring session" />
          </div>
        )}

        {/* ── Not signed in ──────────────────────────────────────── */}
        {!session && !restoring && (
          <>
            {/* Hero */}
            <div className="standalone-hero">
              <h1>Your home in the {whitelabel.brand.community}</h1>
              <p>Your own Portal — a Smart Agent you own, created once and reachable from any app.</p>
            </div>

            {googleNotice && (
              <div className="scard" style={{ borderColor: 'var(--c-primary-border)', marginBottom: '1rem' }}>
                <p style={{ color: 'var(--c-g700)', margin: 0, fontSize: '.9rem' }}>{googleNotice}</p>
              </div>
            )}

            <div className="standalone-grid">

              {/* Sign-in card */}
              <div className="scard accent">
                <h2>Sign in</h2>
                <p className="muted" style={{ fontSize: '.875rem' }}>
                  {personalHandle ? (
                    <>This is <b>{personalHandle}</b>’s secure home.</>
                  ) : (
                    'Enter your agent name to sign in.'
                  )}
                </p>
                <div style={{ marginBottom: '.625rem' }}>
                  <input
                    value={connectName}
                    onChange={(e) => setConnectName(e.target.value.toLowerCase().replace(/[^a-z0-9.-]/g, ''))}
                    placeholder="bob.demo.agent"
                    aria-label="Agent name"
                    readOnly={!!personalHandle}
                  />
                </div>
                {nameInfo.status === 'checking' && (
                  <p className="muted" style={{ fontSize: '.8rem', margin: '0 0 .5rem', display: 'flex', alignItems: 'center', gap: '.35rem' }}>
                    <span className="spinner" aria-hidden="true" />
                    Checking…
                  </p>
                )}
                {nameInfo.status === 'none' &&
                  (personalHandle ? (
                    <div style={{ margin: '0 0 .5rem' }}>
                      <p style={{ fontSize: '.8rem', color: 'var(--c-g500)', margin: '0 0 .45rem' }}>
                        <b>{personalHandle}</b> isn’t claimed yet — make this your secure home.
                      </p>
                      <button disabled={busy || signupAvail !== 'available'} onClick={() => onSignup('passkey')} style={{ fontSize: '.875rem' }}>
                        Create {personalHandle} with a passkey
                      </button>
                    </div>
                  ) : (
                    <p style={{ fontSize: '.8rem', color: 'var(--c-g400)', margin: '0 0 .5rem' }}>
                      No agent with that name — sign up below.
                    </p>
                  ))}
                {nameInfo.status === 'found' && (
                  <p style={{ fontSize: '.8rem', color: 'var(--c-success)', fontWeight: 700, margin: '0 0 .5rem' }}>
                    ✓ Found {nameInfo.name}
                  </p>
                )}
                {connectErr && (
                  <p role="alert" style={{ fontSize: '.8rem', color: 'var(--c-danger)', margin: '0 0 .5rem' }}>
                    {connectErr}
                  </p>
                )}
                <div className="standalone-actions">
                  {nameInfo.status === 'found' && nameInfo.hasPasskey && (
                    <button disabled={busy} onClick={() => onConnectName('passkey')} style={{ fontSize: '.875rem' }}>
                      Continue with passkey
                    </button>
                  )}
                  {nameInfo.status === 'found' && nameInfo.hasEoa && (
                    <button className="ghost" disabled={busy} onClick={() => onConnectName('wallet')} style={{ fontSize: '.875rem' }}>
                      Continue with wallet
                    </button>
                  )}
                </div>
                {/* Cross-device (spec 233 P2): the agent exists, but THIS device may
                    not hold a passkey for it. Offer to set this device up + link it. */}
                {nameInfo.status === 'found' &&
                  (showSetupDevice ? (
                    <NewDevice prefillName={connectName} />
                  ) : (
                    <button
                      className="ghost"
                      onClick={() => setShowSetupDevice(true)}
                      style={{ fontSize: '.78rem', marginTop: '.5rem', background: 'none', border: 'none', color: 'var(--c-g500)', textDecoration: 'underline', cursor: 'pointer', padding: 0, minHeight: 'auto' }}
                    >
                      On a new device? Set up this device →
                    </button>
                  ))}
              </div>

              {/* Sign-up card — hidden on a personal subdomain (spec 229 P5: this
                  page IS that agent's home; you don't create a different name here —
                  claiming the subdomain's own name is offered in the sign-in card). */}
              {!personalHandle && (
              <div className="scard">
                <h2>New here?</h2>
                <p className="muted" style={{ fontSize: '.875rem' }}>Choose an agent name and create your Smart Agent.</p>
                <div style={{ marginBottom: '.375rem' }}>
                  <input
                    value={desiredName}
                    onChange={(e) =>
                      setDesiredName(e.target.value.toLowerCase().replace(/\.demo\.agent$/, '').replace(/[^a-z0-9-]/g, ''))
                    }
                    placeholder="e.g. alice"
                    aria-label="Choose your agent name"
                  />
                </div>
                {desiredName && (
                  <p style={{ fontFamily: "'SF Mono','Roboto Mono',monospace", fontSize: '.75rem', color: 'var(--c-g400)', margin: '0 0 .375rem' }}>
                    {desiredName}.demo.agent
                  </p>
                )}
                {desiredName && signupAvail === 'checking' && (
                  <p className="muted" style={{ fontSize: '.8rem', margin: '0 0 .375rem', display: 'flex', alignItems: 'center', gap: '.35rem' }}>
                    <span className="spinner" aria-hidden="true" />
                    Checking…
                  </p>
                )}
                {desiredName && signupAvail === 'available' && (
                  <p style={{ fontSize: '.8rem', color: 'var(--c-success)', fontWeight: 700, margin: '0 0 .375rem' }}>
                    ✓ Available
                  </p>
                )}
                {desiredName && signupAvail === 'taken' && (
                  <p role="alert" style={{ fontSize: '.8rem', color: 'var(--c-danger)', margin: '0 0 .375rem' }}>
                    Name taken — try another.
                  </p>
                )}
                <div className="standalone-actions">
                  <button disabled={busy || signupAvail !== 'available'} onClick={() => onSignup('passkey')} style={{ fontSize: '.875rem' }}>
                    Create with passkey
                  </button>
                  {hasWallet() && (
                    <button className="ghost" disabled={busy || signupAvail !== 'available'} onClick={() => onSignup('wallet')} style={{ fontSize: '.875rem' }}>
                      Create with wallet
                    </button>
                  )}
                </div>
                {!hasWallet() && (
                  <p className="muted" style={{ fontSize: '.78rem', marginTop: '.5rem' }}>
                    Uses a passkey — no browser wallet needed.
                  </p>
                )}
                <p className="muted" style={{ fontSize: '.78rem', marginTop: '.625rem' }}>
                  Or{' '}
                  <button
                    className="ghost"
                    disabled={busy}
                    onClick={() => startGoogleSignIn(AUD, window.location.origin + '/')}
                    style={{ fontSize: '.78rem', padding: '.2rem .5rem', minHeight: '28px', display: 'inline-flex' }}
                  >
                    Continue with Google
                  </button>
                </p>
              </div>
              )}

            </div>
          </>
        )}

        {/* ── Signed in via Google (login-grade): step-up ─────────── */}
        {session && session.via === 'Google' && (
          <div className="scard accent" style={{ maxWidth: '28rem' }}>
            <h2>Confirm it's you</h2>
            <p className="muted" style={{ fontSize: '.9rem' }}>
              Google identifies your workspace, but you need to confirm with your <strong>passkey or wallet</strong> to use it.
            </p>
            <div className="standalone-actions">
              <button onClick={() => stepUp('passkey')}>Continue with passkey</button>
              <button className="ghost" onClick={() => stepUp('wallet')}>Continue with wallet</button>
              <button className="ghost" onClick={signOut}>Disconnect</button>
            </div>
            {stepUpMsg && (
              <p role="alert" style={{ fontSize: '.875rem', color: 'var(--c-danger)', marginTop: '.625rem' }}>
                {stepUpMsg}
              </p>
            )}
          </div>
        )}

        {/* ── Signed in (custody-grade) ────────────────────────────── */}
        {session && session.via !== 'Google' && (
          <>
            {/* Portal hero — arrival into "your community portal" (belonging + ownership). */}
            <div className="portal-hero">
              <div className="portal-hero-kicker">{whitelabel.copy.portalWelcome}</div>
              <h1>{profile?.name ?? 'Your Portal'}</h1>
              <p>Manage your agents, devices, and connected apps — all from your secure home.</p>
            </div>

            {/* Welcome card + reward chips — your person agent (the default context). */}
            <div className="scard accent" style={{ marginBottom: '1rem' }}>
              {session.fresh ? (
                <>
                  <div style={{
                    fontSize: '.72rem', fontWeight: 800, color: 'var(--c-success)',
                    textTransform: 'uppercase', letterSpacing: '.08em', marginBottom: '.375rem',
                  }}>
                    ✓ Smart Agent ready
                  </div>
                  {profile && (
                    <div className="ws-name">{profile.name ?? 'Your workspace'}</div>
                  )}
                  {/* Reward chips — ownership moment */}
                  <div className="reward-row" aria-label="What you earned">
                    {profile?.name && (
                      <span className="reward-chip">
                        <span className="reward-chip-icon" aria-hidden="true">✓</span>
                        {profile.name} — owned by you
                      </span>
                    )}
                    <span className="reward-chip primary">
                      <span className="reward-chip-icon" aria-hidden="true">✓</span>
                      Smart Agent — yours
                    </span>
                  </div>
                </>
              ) : (
                <>
                  <div style={{
                    fontSize: '.72rem', fontWeight: 700, color: 'var(--c-g400)',
                    textTransform: 'uppercase', letterSpacing: '.08em', marginBottom: '.375rem',
                  }}>
                    Welcome back
                  </div>
                  {profile && (
                    <div className="ws-name">{profile.name ?? 'Your workspace'}</div>
                  )}
                </>
              )}
              {profile ? (
                <>
                  <p className="ws-agent">{profile.agent}</p>
                  <div className="ws-row">
                    <span style={{ color: 'var(--c-g400)', fontSize: '.78rem' }}>Signed in via</span>
                    <strong style={{ fontSize: '.8rem' }}>{session.via}</strong>
                    <span className="badge" style={{ marginLeft: '.25rem' }}>
                      {profile.access === 'standard' ? 'standard' : 'full access'}
                    </span>
                  </div>
                </>
              ) : (
                <p className="muted" style={{ fontSize: '.875rem' }}>Loading…</p>
              )}
              <div className="standalone-actions">
                <button
                  className="ghost"
                  style={{ fontSize: '.8125rem', padding: '.35rem .75rem', minHeight: '36px' }}
                  onClick={() => startGoogleSignIn(AUD, window.location.origin + '/', session.token)}
                >
                  Link Google
                </button>
              </div>
            </div>

            {/* Agents you manage — Person is live (this agent); the rest preview what's next. */}
            <div className="scard">
              <h2>{whitelabel.copy.portalManageHeading}</h2>
              <div className="manage-grid">
                {whitelabel.manageableAgents.map((a) => {
                  const isYou = a.id === 'person';
                  return (
                    <div key={a.id} className={`manage-card ${a.status}`}>
                      <div className="manage-card-head">
                        <span className="manage-card-label">
                          {isYou && profile?.name ? profile.name : a.label}
                        </span>
                        <span className={`manage-card-badge ${a.status}`}>
                          {a.status === 'live' ? (isYou ? whitelabel.copy.portalYouLabel : '✓ Live') : 'Coming next'}
                        </span>
                      </div>
                      <p className="manage-card-blurb">{a.blurb}</p>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Contact details */}
            <div className="scard">
              <h2>Contact details</h2>
              {sensitive ? (
                <pre style={{ fontSize: '.8rem' }}>{JSON.stringify(sensitive, null, 2)}</pre>
              ) : (
                <>
                  <p aria-hidden="true" style={{
                    filter: 'blur(4px)', userSelect: 'none',
                    color: 'var(--c-g300)', fontSize: '.875rem',
                    fontFamily: "'SF Mono','Roboto Mono',monospace",
                    letterSpacing: '.08em',
                  }}>
                    ▒▒▒▒▒▒▒@▒▒▒▒.▒▒▒ · +1 ▒▒▒ ▒▒▒ ▒▒▒▒
                  </p>
                  <div className="standalone-actions">
                    <button onClick={onRevealSensitive} style={{ fontSize: '.875rem' }}>Confirm to view</button>
                  </div>
                  {stepUpMsg && (
                    <p role="alert" style={{ fontSize: '.875rem', color: 'var(--c-danger)', marginTop: '.5rem' }}>
                      {stepUpMsg}
                    </p>
                  )}
                </>
              )}
            </div>

            {/* Agent services */}
            {session.via !== 'Google' && (
              <div className="scard">
                <h2>Agent services</h2>
                {service?.a2aAgent ? (
                  <p style={{ fontSize: '.875rem', color: 'var(--c-success)', margin: 0 }}>
                    ✓ Agent service live: <code style={{ fontSize: '.8rem' }}>{service.a2aAgent}</code>
                  </p>
                ) : service?.step ? (
                  <p className="muted" style={{ fontSize: '.875rem', display: 'flex', alignItems: 'center', gap: '.35rem' }}>
                    <span className="spinner" aria-hidden="true" />
                    {service.step}
                  </p>
                ) : (
                  <>
                    <p className="muted" style={{ fontSize: '.875rem' }}>
                      Provision a service agent that acts on your behalf, linked on-chain.
                    </p>
                    <div className="standalone-actions">
                      <button onClick={onProvisionService} style={{ fontSize: '.875rem' }}>Provision agent service</button>
                    </div>
                    {service?.error && (
                      <p role="alert" style={{ fontSize: '.875rem', color: 'var(--c-danger)', marginTop: '.5rem' }}>
                        {service.error}
                      </p>
                    )}
                  </>
                )}
              </div>
            )}

            {/* Add sign-in method */}
            {session.via !== 'Google' && (
              <div className="scard">
                <h2>Add a sign-in method</h2>
                {addCred?.done ? (
                  <p style={{ fontSize: '.875rem', color: 'var(--c-success)', margin: 0 }}>
                    ✓ {addCred.done} — same agent, same contact details.
                  </p>
                ) : addCred?.step ? (
                  <p className="muted" style={{ fontSize: '.875rem', display: 'flex', alignItems: 'center', gap: '.35rem' }}>
                    <span className="spinner" aria-hidden="true" />
                    {addCred.step}
                  </p>
                ) : (
                  <>
                    <p className="muted" style={{ fontSize: '.875rem' }}>
                      Secured by your <strong>{session.via}</strong>. Add the other credential so you can sign in either way — your agent address never changes.
                    </p>
                    <div className="standalone-actions">
                      <button onClick={onAddCredential} style={{ fontSize: '.875rem' }}>
                        {session.via === 'passkey' ? 'Add a wallet' : 'Add a passkey'}
                      </button>
                    </div>
                    {addCred?.error && (
                      <p role="alert" style={{ fontSize: '.875rem', color: 'var(--c-danger)', marginTop: '.5rem' }}>
                        {addCred.error}
                      </p>
                    )}
                  </>
                )}
              </div>
            )}

            {/* Cross-device (spec 233 P2): approve a passkey created on another device.
                Your existing passkey (ROOT) signs addPasskey for the new device's key. */}
            {session.via !== 'Google' && (
              <div className="scard">
                <h2>Add another device</h2>
                {showApproveDevice ? (
                  <ApproveDevice />
                ) : (
                  <>
                    <p className="muted" style={{ fontSize: '.875rem' }}>
                      Create a passkey on another device (its sign-in screen → “Set up this device”), then approve it here
                      by entering the code it shows. Your passkey signs to add it; your agent address never changes.
                    </p>
                    <div className="standalone-actions">
                      <button onClick={() => setShowApproveDevice(true)} style={{ fontSize: '.875rem' }}>
                        Add a device
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
          </>
        )}

        <p className="muted" style={{ marginTop: '1rem', fontSize: '.72rem', color: 'var(--c-g300)', letterSpacing: '.02em' }}>
          Real on Base Sepolia (chain 84532)
        </p>
      </div>

      {/* ── Signup progress modal ──────────────────────────────────── */}
      {signup && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="signup-modal-title">
          <div className="modal">

            {/* Header: done gets the large shield + check */}
            {signup.phase === 'done' ? (
              <div style={{ textAlign: 'center', marginBottom: '1rem' }}>
                <div style={{ display: 'inline-flex', justifyContent: 'center', marginBottom: '.75rem' }}>
                  <ShieldLogo size={52} gradient />
                </div>
                <h2 id="signup-modal-title" style={{ margin: 0, color: 'var(--c-success)', fontSize: '1.125rem' }}>
                  Your {whitelabel.brand.name} portal is ready
                </h2>
              </div>
            ) : (
              <h2 id="signup-modal-title">
                {signup.phase === 'error'
                  ? "Couldn't finish"
                  : `Setting up your ${whitelabel.brand.name} portal…`}
              </h2>
            )}

            {/* Reward chips on done */}
            {signup.phase === 'done' && desiredName && (
              <div className="reward-row" aria-label="What you earned" style={{ justifyContent: 'center', marginBottom: '1rem' }}>
                <span className="reward-chip">
                  <span className="reward-chip-icon" aria-hidden="true">✓</span>
                  {desiredName}.demo.agent — in the {whitelabel.brand.community}
                </span>
                <span className="reward-chip primary">
                  <span className="reward-chip-icon" aria-hidden="true">✓</span>
                  Your Portal — yours
                </span>
              </div>
            )}

            <ol className="steps" aria-label={signup.phase === 'error' ? 'Steps taken' : 'Progress steps'}>
              {signup.steps.map((s, i) => {
                const isLast = i === signup.steps.length - 1;
                const done = signup.phase === 'done' || !isLast;
                const current = signup.phase === 'running' && isLast;
                return (
                  <li key={i} className={done ? 'done' : current ? 'current' : 'pending'}>
                    <span className="step-icon" aria-hidden="true">
                      {current ? <span className="spinner" /> : done ? '✓' : '•'}
                    </span>
                    {s}
                  </li>
                );
              })}
            </ol>

            {signup.phase === 'running' && (
              <p className="muted" style={{ fontSize: '.875rem', marginBottom: 0 }}>
                Your device may ask you to confirm. This usually takes a few seconds.
              </p>
            )}
            {signup.phase === 'done' && (
              <p style={{ fontSize: '.875rem', color: 'var(--c-success)', margin: 0, textAlign: 'center', fontWeight: 600 }}>
                Signing you in…
              </p>
            )}
            {signup.phase === 'error' && (
              <>
                <div role="alert" style={{
                  background: 'var(--c-danger-bg)', border: '1px solid var(--c-danger-border)',
                  borderRadius: 'var(--r-md)', padding: '.625rem .875rem',
                  color: 'var(--c-danger)', fontSize: '.875rem', marginBottom: '.625rem',
                }}>
                  {signup.error}
                </div>
                <p className="muted" style={{ fontSize: '.875rem', marginBottom: '.875rem' }}>
                  Nothing was changed. You can try again.
                </p>
                <button className="ghost cta" onClick={() => setSignup(null)}>Close</button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
