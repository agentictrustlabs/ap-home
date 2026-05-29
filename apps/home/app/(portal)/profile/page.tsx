'use client';
// Profile editor at the member's Impact home. Two modes:
//
//   • Self-edit (no query params): browse from /you → "Edit profile". Standard CRUD.
//
//   • Relying-app handoff (`?app=&return=&state=&required=`): a community app (e.g.
//     JP Adopt) detected missing fields it requires and sent the member here. The page
//     pre-highlights the requested fields, shows a "JP Adopt is asking for these" banner,
//     and on save redirects back with the profile fields as query params on `return`.
//
// Profile lives in localStorage at this Impact origin (`<name>.impact-agent.me`) keyed
// on the agent address — community-wide, re-used across every relying app. In production
// this becomes a backend MCP the member alone can open. The "fields back via URL on
// return" is a demo limitation; production uses a delegated server-to-server read.

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useSession } from '../../../src/context/session';
import {
  loadImpactProfile, saveImpactProfile, PROFILE_FIELDS,
  type ImpactStoredProfile, type ImpactContactProfile, type ImpactProfileFieldKey,
} from '../../../src/profile-store';
import { relyingAllowed } from '../../../src/components/onboarding/useEnrollReq';
import { whitelabel } from '../../../src/whitelabel/config';
import { SectionShell } from '../../../src/components/portal/SectionShell';
import { UserIcon } from '../../../src/components/shared/Icons';

interface RelyingRequest {
  appId: string;
  appLabel: string;
  returnUrl: string;
  state: string;
  required: ImpactProfileFieldKey[];
}

function parseRelyingRequest(): RelyingRequest | null {
  if (typeof window === 'undefined') return null;
  const u = new URL(window.location.href);
  const app = u.searchParams.get('app');
  const returnUrl = u.searchParams.get('return');
  const state = u.searchParams.get('state');
  const required = u.searchParams.get('required');
  if (!app || !returnUrl || !state) return null;
  // SECURITY: only allowlisted relying-app origins may receive a redirect back. The
  // shared ALLOWED_RELYING_ORIGINS gate (audit F3) applies — same allowlist as the
  // OIDC sign-in flow uses. A second exact-match against the app's registered
  // redirect_uris is enforced below.
  if (!relyingAllowed(returnUrl)) return null;
  const appConfig = whitelabel.relyingApps.find((a) => a.client_id === app);
  if (!appConfig) return null;
  if (!appConfig.redirect_uris.some((u) => sameOrigin(u, returnUrl))) return null;
  const requestedKeys = (required?.split(',') ?? [])
    .map((s) => s.trim())
    .filter((k): k is ImpactProfileFieldKey =>
      (PROFILE_FIELDS as readonly { key: string }[]).some((f) => f.key === k),
    );
  return { appId: app, appLabel: appConfig.name ?? app, returnUrl, state, required: requestedKeys };
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

export default function ProfilePage() {
  const { agentAddress, agentName } = useSession();
  const [request, setRequest] = useState<RelyingRequest | null>(null);
  const [contact, setContact] = useState<ImpactContactProfile>({});
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Parse the relying-app handoff (if any) + load existing profile once we have the address.
  useEffect(() => {
    setRequest(parseRelyingRequest());
  }, []);

  useEffect(() => {
    if (!agentAddress) return;
    const p = loadImpactProfile(agentAddress);
    setContact(p.contact ?? {});
  }, [agentAddress]);

  const requiredKeys = useMemo<Set<ImpactProfileFieldKey>>(() => new Set(request?.required ?? []), [request]);
  const missingRequired = useMemo<ImpactProfileFieldKey[]>(
    () => (request?.required ?? []).filter((k) => !(contact[k] ?? '').trim()),
    [request, contact],
  );

  function handleChange(key: ImpactProfileFieldKey, v: string): void {
    setContact((c) => ({ ...c, [key]: v }));
    setSavedNotice(null);
  }

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!agentAddress) return;
    if (missingRequired.length > 0) return;
    setSubmitting(true);
    try {
      const next: ImpactStoredProfile = { v: 1, contact };
      saveImpactProfile(agentAddress, next);
      if (request) {
        // Hand the saved fields back to the relying app via query params on the registered
        // redirect URI. Demo limitation — production uses a delegated read API (no PII in URLs).
        const ret = new URL(request.returnUrl);
        ret.searchParams.set('profile_state', request.state);
        for (const k of request.required) {
          const v = contact[k];
          if (v && v.trim()) ret.searchParams.set(`profile_${k}`, v.trim());
        }
        window.location.href = ret.toString();
        return;
      }
      setSavedNotice('Saved to your home');
    } finally {
      setSubmitting(false);
    }
  }

  const personLabel = agentName ?? 'your home';

  return (
    <SectionShell
      title="Your profile"
      description={
        request
          ? `${request.appLabel} is asking for these fields so you can finish at their site. They live here at ${personLabel} — re-used across every community app.`
          : `These details live in your ${whitelabel.brand.community} home — re-used across every app you trust. You decide which app sees what.`
      }
    >
      {request && (
        <div className="relying-banner" role="status" style={bannerStyle}>
          <span style={bannerIconStyle} aria-hidden="true"><UserIcon size={18} /></span>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, color: 'var(--c-g900, #0f172a)' }}>
              {request.appLabel} needs {request.required.length} field{request.required.length === 1 ? '' : 's'} from your profile
            </div>
            <div style={{ fontSize: '.85rem', color: 'var(--c-g600, #475569)', marginTop: '.15rem' }}>
              We&apos;ll save it here at your home (one place, every app), then send you back to {request.appLabel}.
            </div>
          </div>
        </div>
      )}

      <form onSubmit={handleSubmit} className="profile-form" style={formStyle}>
        {PROFILE_FIELDS.map((f) => {
          const isRequired = requiredKeys.has(f.key);
          const missing = isRequired && !(contact[f.key] ?? '').trim();
          return (
            <div key={f.key} style={fieldStyle(isRequired)}>
              <label htmlFor={`profile-${f.key}`} style={labelStyle}>
                {f.label}
                {isRequired && <span style={requiredPill}>required by {request?.appLabel}</span>}
              </label>
              <input
                id={`profile-${f.key}`}
                type={f.type}
                value={contact[f.key] ?? ''}
                onChange={(e) => handleChange(f.key, e.target.value)}
                placeholder={f.placeholder}
                autoComplete={autoCompleteFor(f.key)}
                style={inputStyle(missing)}
              />
              <div style={helpStyle}>{f.help}</div>
            </div>
          );
        })}

        {savedNotice && <div role="status" style={savedStyle}>✓ {savedNotice}</div>}

        <div style={footerStyle}>
          <button
            type="submit"
            className="btn-primary"
            disabled={submitting || missingRequired.length > 0}
            style={primaryBtn}
          >
            {submitting
              ? 'Saving…'
              : request
                ? `Save & return to ${request.appLabel} →`
                : 'Save'}
          </button>
          {request && (
            <a href={request.returnUrl} style={cancelLinkStyle}>
              Cancel and return to {request.appLabel}
            </a>
          )}
          {!request && (
            <a href="/you" style={cancelLinkStyle}>Back</a>
          )}
        </div>
      </form>
    </SectionShell>
  );
}

function autoCompleteFor(k: ImpactProfileFieldKey): string {
  switch (k) {
    case 'firstName': return 'given-name';
    case 'lastName': return 'family-name';
    case 'email': return 'email';
    case 'phone': return 'tel';
    case 'country': return 'country-name';
    case 'city': return 'address-level2';
    case 'organizationName': return 'organization';
    case 'organizationCountry': return 'country-name';
  }
}

// Local inline styles — keeps the new page additive (no global CSS churn) while
// matching the portal's visual language. Move to the portal's stylesheet later.
const bannerStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'flex-start', gap: '.75rem',
  background: 'var(--c-primary-subtle, #eef2ff)',
  border: '1px solid var(--c-primary-border, #c7d2fe)',
  borderRadius: 14, padding: '1rem 1.1rem', marginBottom: '1.25rem',
};
const bannerIconStyle: React.CSSProperties = {
  width: 36, height: 36, borderRadius: 10, flex: '0 0 auto',
  background: 'var(--c-primary, #4f46e5)', color: '#fff',
  display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 1px 2px rgba(15,23,42,.06)',
};
const formStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: '1rem', maxWidth: 680 };
const fieldStyle = (req: boolean): React.CSSProperties => ({
  background: req ? 'var(--c-primary-subtle, #eef2ff)' : 'var(--c-g50, #f8fafc)',
  border: `1px solid ${req ? 'var(--c-primary-border, #c7d2fe)' : 'var(--c-g200, #e2e8f0)'}`,
  borderRadius: 12, padding: '.85rem 1rem',
});
const labelStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: '.5rem', fontWeight: 700, fontSize: '.85rem',
  color: 'var(--c-g800, #1e293b)', marginBottom: '.45rem',
};
const requiredPill: React.CSSProperties = {
  fontSize: '.65rem', fontWeight: 800, letterSpacing: '.04em', textTransform: 'uppercase',
  padding: '.15rem .5rem', borderRadius: 999,
  background: 'var(--c-primary, #4f46e5)', color: '#fff',
};
const inputStyle = (missing: boolean): React.CSSProperties => ({
  width: '100%', padding: '.65rem .8rem', fontSize: '.95rem', borderRadius: 10,
  border: `1.5px solid ${missing ? 'var(--c-danger, #dc2626)' : 'var(--c-g300, #cbd5e1)'}`,
  background: '#fff', fontFamily: 'inherit',
});
const helpStyle: React.CSSProperties = { marginTop: '.4rem', fontSize: '.75rem', color: 'var(--c-g500, #64748b)' };
const savedStyle: React.CSSProperties = {
  padding: '.65rem .9rem', borderRadius: 10, background: '#dcfce7', color: '#166534',
  border: '1px solid #86efac', fontSize: '.875rem', fontWeight: 600,
};
const footerStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap', marginTop: '.5rem',
};
const primaryBtn: React.CSSProperties = {
  background: 'var(--c-primary, #4f46e5)', color: '#fff', border: 'none',
  padding: '.7rem 1.1rem', borderRadius: 999, fontWeight: 700, fontSize: '.92rem', cursor: 'pointer',
};
const cancelLinkStyle: React.CSSProperties = {
  fontSize: '.85rem', color: 'var(--c-g500, #64748b)', textDecoration: 'underline',
};
