'use client';
// Full-bleed entry experience shown by the portal gate when NOT authed (or mid relying-app
// enrollment). Routes: relying-app enroll (new / existing / org-create) and self-serve
// (onboarding / sign-in). The onboarding journey itself lives in <OnboardingJourney/>.
import { useEffect, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { openHome, createOrganization } from '../../home/onboarding';
import { whitelabel } from '../../whitelabel/config';
import { useSession } from '../../context/session';
import { CENTRAL_AUTH_DOMAIN, nameLabel, personalAuthOrigin, toAgentName } from '../../lib/domain';
import { useEnrollReq } from './useEnrollReq';
import { OnboardingJourney } from './OnboardingJourney';
import { BrandShield } from '../shared/BrandShield';
import { ConsentSheet } from '../shared/ConsentSheet';
import { ReceiptCard } from '../shared/ReceiptCard';

interface NameInfo { exists?: boolean; agent?: Address; hasEoa?: boolean; hasPasskey?: boolean }
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
    }
    return { k: 'name' };
  });

  // Enroll mode: resolve the requested name → new vs existing vs org-create.
  useEffect(() => {
    if (mode !== 'enroll' || !api.enroll) return;
    if (!api.allowed) {
      setView({ k: 'blocked' });
      return;
    }
    void (async () => {
      const info = await nameInfo(api.enroll!.name);
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
    return <SignInView name={view.name} onSession={(t, via) => openSession(t, via, false)} />;
  }
  // Self-serve name-first start.
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
function NameStart({ onStart }: { onStart: (name: string, exists: boolean) => void }) {
  const [value, setValue] = useState('');
  const [avail, setAvail] = useState<'idle' | 'checking' | 'available' | 'taken'>('idle');
  const [busy, setBusy] = useState(false);
  const label = nameLabel(value);

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
    </Shell>
  );
}

// ── Returning member sign-in ──────────────────────────────────────────────────
function SignInView({ name, onSession }: { name: string; onSession: (token: string, via: string) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
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
  return (
    <Shell>
      <BrandShield size={56} />
      <h1 className="onboarding-h1">Welcome back</h1>
      <p className="onboarding-sub">Sign in to <strong>{name}</strong> — your home in the {whitelabel.brand.community}.</p>
      {busy ? (
        <div className="onboarding-busy"><span className="spinner spinner-lg" /><p className="onboarding-busy-msg">Confirming with your device…</p></div>
      ) : (
        <>
          <button className="btn-primary" onClick={() => go('passkey')}>Continue with passkey</button>
          <button className="btn-ghost onboarding-secondary" onClick={() => go('wallet')}>Continue with wallet</button>
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
  const tpl = whitelabel.delegationTemplates['org-create'] ?? { canDo: [], cannotDo: ['Move funds', 'Add members', 'Act outside this permission'] };
  const orgBase = api.enroll?.orgBase ?? '';

  async function authorize() {
    if (!api.enroll) return;
    setPhase('busy');
    try {
      const created = await createOrganization({ address: personAgent, name: api.enroll.name }, orgBase, api.enroll.delegate);
      if (!created.ok) { setErr(created.error); setPhase('error'); return; }
      const code = await api.submitGrant(api.enroll.name, created.grant, created.org);
      setPhase('connected');
      setTimeout(() => api.deliverCode(code), 1100);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'org creation failed');
      setPhase('error');
    }
  }

  if (phase === 'busy') return <Shell><div className="onboarding-busy"><span className="spinner spinner-lg" /><p className="onboarding-busy-msg">Creating your organization…</p></div></Shell>;
  if (phase === 'connected') return <Shell><BrandShield size={56} /><h1 className="onboarding-h1">Organization created</h1><ReceiptCard title={`${orgBase} is set up and connected`} /><p className="onboarding-sub">Returning you to {api.host}…</p></Shell>;
  if (phase === 'error') return <Shell><h1 className="onboarding-h1">Couldn&apos;t finish</h1><p className="onboarding-hint taken">{err}</p><button className="btn-primary" onClick={() => setPhase('consent')}>Try again</button></Shell>;
  return (
    <Shell>
      <ConsentSheet
        title={`Create ${orgBase} in the ${whitelabel.brand.community}`}
        appName={api.host}
        appDomain={api.host}
        template={tpl}
        authorizeLabel="Create & authorize"
        onAuthorize={authorize}
        onDecline={api.denyEnroll}
      />
    </Shell>
  );
}
