'use client';
// Session context for the portal shell. Holds the signed-in agent session + profile,
// restores it on load, and handles the Google OIDC `?code` return. Extracted verbatim
// from the old monolithic App.tsx (same SESSION_KEY, same fetchProfile validation) so
// every portal route shares one session via useSession().
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { AUD, fetchProfile, type BasicProfile } from '../connect-client';
import { exchangeCode } from '../server-client';
import { nameLabel, parseAgentSubdomain } from '../lib/domain';
import { setSsoCookie, readSsoCookie, clearSsoCookie } from '../lib/sso-cookie';

export interface Session {
  token: string;
  via: string; // 'wallet' | 'passkey' | 'Google'
  fresh: boolean; // just created (welcome) vs reconnected (welcome back)
}

export type SessionPhase = 'restoring' | 'anon' | 'authed';

interface SessionCtx {
  phase: SessionPhase;
  session: Session | null;
  profile: BasicProfile | null;
  /** The agent's address, derived from `profile.agent` (CAIP-10 tail). */
  agentAddress: Address | null;
  agentName: string | null;
  /** spec 257 Phase 1.5 — is the SA deployed on-chain? Distinguishes a counterfactual fresh-Google
   *  SA (false → secure-home) from a deployed-but-nameless deferred home (true → portal). */
  agentDeployed: boolean;
  /** A Google return / link notice to surface in the UI (auto-cleared on dismiss). */
  notice: string | null;
  clearNotice(): void;
  openSession(token: string, via: string, fresh: boolean): Promise<BasicProfile | null>;
  signOut(): void;
  refreshProfile(): Promise<void>;
}

export const SESSION_KEY = 'agenticprimitives:demo-sso:session';
const Ctx = createContext<SessionCtx | null>(null);

/** Tell the browser's FedCM login-status API the user's IdP state (Chrome-only; feature-detected). With
 *  `logged-in`, FedCM will call `/fedcm/accounts`; with `logged-out` it shows the `login_url` affordance
 *  instead of erroring. Without this signal FedCM treats the IdP state as `unknown` and an accounts 401
 *  surfaces as an error (spec 264 Phase 1b). */
export function setFedcmLoginStatus(status: 'logged-in' | 'logged-out'): void {
  try {
    (navigator as unknown as { login?: { setStatus?: (s: string) => void } }).login?.setStatus?.(status);
  } catch {
    /* not supported — fine */
  }
}

/** Restore a persisted session on load only if one exists AND we're not mid Google-redirect
 *  (?code/connect_status) or central-auth enrollment (?delegate) — those mint their own. */
function shouldRestore(): boolean {
  try {
    const u = new URL(window.location.href);
    if (u.searchParams.has('code') || u.searchParams.has('connect_status') || u.searchParams.has('delegate')) {
      return false;
    }
    // A per-origin session OR the parent-domain SSO cookie (cross-subdomain) means "restore".
    return !!localStorage.getItem(SESSION_KEY) || !!readSsoCookie();
  } catch {
    return false;
  }
}

function hasGoogleReturn(): boolean {
  try {
    const u = new URL(window.location.href);
    return u.searchParams.has('code') || u.searchParams.has('connect_status');
  } catch {
    return false;
  }
}

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<BasicProfile | null>(null);
  // 'restoring' while we validate a stored session or finish a Google ?code exchange.
  const [phase, setPhase] = useState<SessionPhase>(() => {
    if (typeof window === 'undefined') return 'restoring';
    return shouldRestore() || hasGoogleReturn() ? 'restoring' : 'anon';
  });
  const [notice, setNotice] = useState<string | null>(null);
  const ran = useRef(false);

  const openSession = useCallback(async (token: string, via: string, fresh: boolean): Promise<BasicProfile | null> => {
    setSession({ token, via, fresh });
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify({ token, via })); // survive refresh (this origin)
    } catch {
      /* storage blocked (private mode) — session just won't persist */
    }
    setSsoCookie(token, via); // share across *.impact-agent.me (parent-domain SSO)
    setFedcmLoginStatus('logged-in'); // FedCM may now call /fedcm/accounts (spec 264)
    const p = await fetchProfile(token);
    setProfile(p);
    setPhase('authed');
    return p;
  }, []);

  const signOut = useCallback(() => {
    setSession(null);
    setProfile(null);
    setNotice(null);
    try {
      localStorage.removeItem(SESSION_KEY);
    } catch {
      /* ignore */
    }
    clearSsoCookie(); // sign out across *.impact-agent.me
    setFedcmLoginStatus('logged-out'); // FedCM shows the login_url affordance instead of erroring
    setPhase('anon');
  }, []);

  const refreshProfile = useCallback(async () => {
    if (!session) return;
    setProfile(await fetchProfile(session.token));
  }, [session]);

  // On mount: handle a Google return (?code / connect_status), else restore a stored session.
  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    void (async () => {
      const url = new URL(window.location.href);

      // One-click SIWE handoff (spec 247): a relying app (e.g. demo-jp) signed the operator
      // in with their key and opened us at `…/you#session=<token>`. Establish the session
      // straight from the fragment, then strip it so the token never lingers in history.
      const handoff = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('session');
      if (handoff) {
        window.history.replaceState({}, '', url.pathname + url.search);
        try {
          await openSession(handoff, 'Wallet', true);
        } catch {
          setPhase('anon');
        }
        return;
      }

      // Google bootstrap notice (the callback redirects back with a status, not a dead JSON page).
      const connectStatus = url.searchParams.get('connect_status');
      if (connectStatus) {
        const email = url.searchParams.get('email');
        const reason = url.searchParams.get('reason');
        if (connectStatus === 'linked') {
          setNotice(`✓ Google${email ? ` (${email})` : ''} is now linked — next time you can sign in with Google.`);
        } else if (connectStatus === 'link_failed') {
          setNotice(`Couldn't link Google: ${reason ?? 'please try again'}.`);
        } else {
          setNotice(
            `We recognized your Google account${email ? ` (${email})` : ''}, but no portal is linked to it yet. ` +
              `Create one with a passkey or wallet — or sign in and use "Link Google".`,
          );
        }
        for (const k of ['connect_status', 'via', 'email', 'reason']) url.searchParams.delete(k);
        window.history.replaceState({}, '', url.toString());
        setPhase('anon');
        return;
      }

      // Real OIDC return: ?code → exchange → session. `via` (default Google) names which IdP opened it —
      // both Google and YouVersion are KMS-custodied, so the credential label drives custody routing.
      const code = url.searchParams.get('code');
      if (code && !url.searchParams.has('delegate')) {
        const credVia = url.searchParams.get('via') === 'youversion' ? 'YouVersion' : 'Google';
        try {
          const token = await exchangeCode(code, AUD);
          const prof = await openSession(token, credVia, true);
          // Google is one-account-one-home: if it resolved to an EXISTING home that differs from
          // the name the member just asked for, tell them (their Google account is already bound).
          // A brand-new member (no home yet) keeps `pendingHomeName` for the secure-home step.
          if (prof?.name) {
            const pending = sessionStorage.getItem('pendingHomeName');
            const want = pending ? nameLabel(pending) : '';
            if (want && nameLabel(prof.name) !== want) {
              setNotice(
                `Your ${credVia} account already opens ${prof.name}. Signing in with ${credVia} always brings you ` +
                  `here — to set up a separate “${want}”, secure it with a passkey or wallet instead.`,
              );
            }
            try {
              sessionStorage.removeItem('pendingHomeName');
            } catch {
              /* ignore */
            }
          }
        } catch {
          setPhase('anon');
        } finally {
          url.searchParams.delete('code');
          url.searchParams.delete('state');
          url.searchParams.delete('via');
          window.history.replaceState({}, '', url.toString());
        }
        return;
      }

      // Restore a persisted session (validated against the broker; drop if expired/invalid).
      if (!shouldRestore()) {
        setPhase('anon');
        return;
      }
      try {
        // Prefer the per-origin localStorage session; else fall back to the parent-domain SSO
        // cookie (signed in once on another *.impact-agent.me origin).
        const raw = localStorage.getItem(SESSION_KEY);
        const stored = raw ? (JSON.parse(raw) as { token?: string; via?: string }) : null;
        let token = stored?.token;
        let via = stored?.via;
        let fromCookie = false;
        if (!token) {
          const c = readSsoCookie();
          if (c) {
            token = c.token;
            via = c.via;
            fromCookie = true;
          }
        }
        if (!token || !via) {
          localStorage.removeItem(SESSION_KEY);
          setPhase('anon');
          return;
        }
        const p = await fetchProfile(token);
        if (!p) {
          localStorage.removeItem(SESSION_KEY);
          if (fromCookie) clearSsoCookie();
          setPhase('anon');
          return;
        }
        // A cookie session landing on a DIFFERENT home's subdomain must NOT impersonate that home
        // here — let them sign in as THIS subdomain's home (keep the cookie for its own home).
        if (fromCookie) {
          const sub = parseAgentSubdomain(window.location.hostname);
          if (sub && p.name && nameLabel(p.name) !== sub) {
            setPhase('anon');
            return;
          }
        }
        setSession({ token, via, fresh: false });
        setProfile(p);
        setPhase('authed');
        // spec 264 — a RESTORED session (returning user) must also (a) refresh the SSO cookie so an old
        // SameSite=Lax cookie is upgraded to SameSite=None (FedCM's cross-site accounts/assertion fetch
        // can't read a Lax cookie), and (b) signal `logged-in` to FedCM. Without this, a logged-in user
        // is invisible to FedCM and it shows the sign-in screen instead of the account chooser.
        setSsoCookie(token, via);
        setFedcmLoginStatus('logged-in');
        if (fromCookie) {
          try {
            localStorage.setItem(SESSION_KEY, JSON.stringify({ token, via })); // cache on this origin
          } catch {
            /* ignore */
          }
        }
      } catch {
        setPhase('anon');
      }
    })();
  }, [openSession]);

  const agentAddress = (profile?.agent ? (profile.agent.split(':').pop() as Address) : null) ?? null;
  const agentName = profile?.name ?? null;
  const agentDeployed = profile?.deployed ?? false;

  const value: SessionCtx = {
    phase,
    session,
    profile,
    agentAddress,
    agentName,
    agentDeployed,
    notice,
    clearNotice: () => setNotice(null),
    openSession,
    signOut,
    refreshProfile,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useSession must be used within <SessionProvider>');
  return ctx;
}
