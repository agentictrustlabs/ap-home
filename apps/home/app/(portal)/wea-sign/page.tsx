'use client';
// WEA Statement of Faith signing at the member's Impact home. Two modes (same shape
// as /profile):
//
//   • Self-sign (no params): browse from /you and sign the WEA for community-wide
//     re-use. The attestation lives at this Impact home.
//
//   • Relying-app handoff (`?app=&return=&state=`): a community app (e.g. JP Adopt)
//     needs the WEA attestation. We show the same canonical text + a "JP Adopt is
//     asking" banner, sign on Save, store the attestation in this Impact home, and
//     redirect back to the relying app with `?wea_state=&wea_docHash=&wea_signedAt=
//     &wea_consentBoundTo=` for the app to record. The relying app verifies the hash
//     by recomputing from its own canonical WEA bytes.

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useSession } from '../../../src/context/session';
import {
  loadImpactProfile, saveImpactProfile, type ImpactStoredProfile, type StoredAttestation,
} from '../../../src/profile-store';
import { WEA_TEXT, WEA_AFFIRMATIONS, WEA_DOC_ID, buildWeaAttestation } from '../../../src/wea-doc';
import { relyingAllowed } from '../../../src/components/onboarding/useEnrollReq';
import { whitelabel } from '../../../src/whitelabel/config';
import { SectionShell } from '../../../src/components/portal/SectionShell';

interface RelyingRequest {
  appId: string;
  appLabel: string;
  returnUrl: string;
  state: string;
}

function parseRelyingRequest(): RelyingRequest | null {
  if (typeof window === 'undefined') return null;
  const u = new URL(window.location.href);
  const app = u.searchParams.get('app');
  const returnUrl = u.searchParams.get('return');
  const state = u.searchParams.get('state');
  if (!app || !returnUrl || !state) return null;
  if (!relyingAllowed(returnUrl)) return null;
  const appConfig = whitelabel.relyingApps.find((a) => a.client_id === app);
  if (!appConfig) return null;
  if (!appConfig.redirect_uris.some((u) => sameOrigin(u, returnUrl))) return null;
  return { appId: app, appLabel: appConfig.name ?? app, returnUrl, state };
}

function sameOrigin(a: string, b: string): boolean {
  try { return new URL(a).origin === new URL(b).origin; } catch { return false; }
}

export default function WeaSignPage() {
  const { agentAddress, session } = useSession();
  const [request, setRequest] = useState<RelyingRequest | null>(null);
  const [existing, setExisting] = useState<StoredAttestation | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);

  useEffect(() => { setRequest(parseRelyingRequest()); }, []);
  useEffect(() => {
    if (!agentAddress) return;
    const p = loadImpactProfile(agentAddress);
    setExisting(p.attestations?.wea ?? null);
  }, [agentAddress]);

  const alreadySigned = !!existing;
  const signedDate = useMemo(
    () => (existing ? new Date(existing.signedAt * 1000).toLocaleDateString() : null),
    [existing],
  );

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!agentAddress || !session?.token) return;
    setBusy(true);
    try {
      let att: StoredAttestation;
      if (existing) {
        // Already signed at this home — reuse the stored attestation. The point of
        // a community-wide attestation is re-use without re-signing.
        att = existing;
      } else {
        att = await buildWeaAttestation({ sessionToken: session.token });
        const existingProfile = loadImpactProfile(agentAddress);
        const next: ImpactStoredProfile = {
          ...existingProfile,
          attestations: { ...(existingProfile.attestations ?? {}), wea: att },
        };
        saveImpactProfile(agentAddress, next);
        setExisting(att);
      }
      if (request) {
        const ret = new URL(request.returnUrl);
        ret.searchParams.set('wea_state', request.state);
        ret.searchParams.set('wea_docHash', att.docHash);
        ret.searchParams.set('wea_docId', att.docId);
        ret.searchParams.set('wea_signedAt', String(att.signedAt));
        ret.searchParams.set('wea_consentBoundTo', att.consentBoundTo);
        window.location.href = ret.toString();
        return;
      }
      setSavedNotice('Signed at your home');
    } finally {
      setBusy(false);
    }
  }

  // Pre-check the box if already signed — saves the member a click when re-using.
  useEffect(() => { if (alreadySigned) setAgreed(true); }, [alreadySigned]);

  return (
    <SectionShell
      title="WEA Statement of Faith"
      description={
        request
          ? `${request.appLabel} is asking for your WEA Statement of Faith attestation. Sign it once here at your home — every faith-aligned community app will see “✓ on file.”`
          : `Affirm the World Evangelical Alliance Statement of Faith once at your home — re-used across every faith-aligned community app that needs it.`
      }
    >
      {request && (
        <div role="status" style={bannerStyle}>
          <span style={bannerIconStyle} aria-hidden="true">!</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 800, color: 'var(--c-g900, #0f172a)' }}>
              {request.appLabel} is asking for your WEA attestation
            </div>
            <div style={{ fontSize: '.85rem', color: 'var(--c-g600, #475569)', marginTop: '.15rem' }}>
              {alreadySigned
                ? `You've already signed this — we'll re-use it and send you back to ${request.appLabel}.`
                : `Read, affirm, and sign once. Every faith-aligned app gets the same attestation receipt.`}
            </div>
          </div>
        </div>
      )}

      {alreadySigned && (
        <div role="status" style={alreadyStyle}>
          ✓ Signed on <b>{signedDate}</b>. The relying app will receive your existing attestation.
        </div>
      )}

      <form onSubmit={handleSubmit} style={formStyle}>
        <div style={textBoxStyle}>
          <h3 style={textHeadStyle}>{WEA_TEXT.split('\n')[0]}</h3>
          <p style={{ color: 'var(--c-g600, #475569)', marginTop: '.6rem' }}>We believe in:</p>
          <ol style={listStyle}>
            {WEA_AFFIRMATIONS.map((a, i) => <li key={i} style={listItemStyle}>{a}</li>)}
          </ol>
        </div>

        <label style={agreeStyle}>
          <input
            type="checkbox" checked={agreed} disabled={alreadySigned}
            onChange={(e) => setAgreed(e.target.checked)}
            style={{ marginTop: '.25rem' }}
          />
          <span>
            I affirm the WEA Statement of Faith as a personal expression of belief.
            {' '}{alreadySigned
              ? 'Already affirmed at your home.'
              : 'This signs an attestation stored at your home; the relying app receives only the hash receipt + signing date.'}
          </span>
        </label>

        {savedNotice && <div role="status" style={savedStyle}>✓ {savedNotice}</div>}

        <div style={footerStyle}>
          <button type="submit" disabled={busy || (!agreed && !alreadySigned)} style={primaryBtn}>
            {busy ? 'Signing…' : request
              ? (alreadySigned ? `Send attestation to ${request.appLabel} →` : `Sign & return to ${request.appLabel} →`)
              : (alreadySigned ? 'Already signed' : 'Sign at my home')}
          </button>
          {request && (
            <a href={request.returnUrl} style={cancelLinkStyle}>Cancel and return to {request.appLabel}</a>
          )}
          {!request && <a href="/you" style={cancelLinkStyle}>Back</a>}
        </div>
      </form>
    </SectionShell>
  );
}

const bannerStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'flex-start', gap: '.75rem',
  background: 'var(--c-primary-subtle, #eef2ff)',
  border: '1px solid var(--c-primary-border, #c7d2fe)',
  borderRadius: 14, padding: '1rem 1.1rem', marginBottom: '1.25rem',
};
const bannerIconStyle: React.CSSProperties = {
  width: 36, height: 36, borderRadius: 10, flex: '0 0 auto',
  background: 'var(--c-primary, #4f46e5)', color: '#fff',
  display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 900, boxShadow: '0 1px 2px rgba(15,23,42,.06)',
};
const alreadyStyle: React.CSSProperties = {
  padding: '.65rem .9rem', borderRadius: 10, background: '#dcfce7', color: '#166534',
  border: '1px solid #86efac', fontSize: '.875rem', fontWeight: 600, marginBottom: '1rem',
};
const formStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: '1rem', maxWidth: 760 };
const textBoxStyle: React.CSSProperties = {
  background: 'var(--c-g50, #f8fafc)', border: '1px solid var(--c-g200, #e2e8f0)',
  borderRadius: 12, padding: '1.25rem 1.5rem', maxHeight: 420, overflow: 'auto',
};
const textHeadStyle: React.CSSProperties = { color: 'var(--c-g900, #0f172a)', fontSize: '1.15rem', margin: 0 };
const listStyle: React.CSSProperties = { paddingLeft: '1.5rem', marginTop: '.5rem' };
const listItemStyle: React.CSSProperties = { color: 'var(--c-g700, #334155)', fontSize: '.95rem', marginBottom: '.6rem', lineHeight: 1.6 };
const agreeStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'flex-start', gap: '.65rem', fontSize: '.9rem', color: 'var(--c-g700, #334155)',
};
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
