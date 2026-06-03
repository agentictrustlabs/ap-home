'use client';
// Two-party agreement CONSENT signing at a party's Impact home (RW1-1 / ADR-0027).
//
// A relying app (e.g. JP Adopt) has a fully-specified agreement whose on-chain joint
// assertion requires BOTH parties to consent. Each party is sent here with the canonical
// consent digest + a human-readable summary; they review and sign with THEIR credential
// (passkey / wallet / Google KMS). We produce an ERC-1271 signature that validates under
// the party SA on-chain, and redirect back to the relying app with:
//   `?consent_state=&consent_party=&consent_digest=&consent_sig=`
// The relying app stores the signature; when both parties have signed, the issuer publishes
// the joint assertion and the AttestationRegistry recomputes the digest + verifies both sigs.
//
// Unlike /wea-sign (a doc-hash RECEIPT) this is a real cryptographic signature over a digest
// the relying app supplies — nothing is granted, scoped, or revocable (it is not a delegation).

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useSession } from '../../../src/context/session';
import { signConsent, type Via } from '../../../src/home/onboarding';
import { relyingAllowed } from '../../../src/components/onboarding/useEnrollReq';
import { whitelabel } from '../../../src/whitelabel/config';
import { SectionShell } from '../../../src/components/portal/SectionShell';
import type { Address, Hex } from '@agenticprimitives/types';

interface ConsentRequest {
  appId: string;
  appLabel: string;
  returnUrl: string;
  state: string;
  /** The canonical consent digest (bytes32) the party signs. */
  digest: Hex;
  /** The party SA the signature must validate under (person home, or a stewarded org). */
  party: Address;
  /** Human-readable agreement summary shown to the party. */
  label: string;
}

function sameOrigin(a: string, b: string): boolean {
  try { return new URL(a).origin === new URL(b).origin; } catch { return false; }
}

function parseConsentRequest(): ConsentRequest | null {
  if (typeof window === 'undefined') return null;
  const u = new URL(window.location.href);
  const app = u.searchParams.get('app');
  const returnUrl = u.searchParams.get('return');
  const state = u.searchParams.get('state');
  const digest = u.searchParams.get('digest');
  const party = u.searchParams.get('party');
  const label = u.searchParams.get('label') ?? 'a two-party agreement';
  if (!app || !returnUrl || !state || !digest || !party) return null;
  if (!relyingAllowed(returnUrl)) return null;
  if (!/^0x[0-9a-fA-F]{64}$/.test(digest)) return null;
  if (!/^0x[0-9a-fA-F]{40}$/.test(party)) return null;
  const appConfig = whitelabel.relyingApps.find((a) => a.client_id === app);
  if (!appConfig) return null;
  if (!appConfig.redirect_uris.some((r) => sameOrigin(r, returnUrl))) return null;
  return {
    appId: app,
    appLabel: appConfig.name ?? app,
    returnUrl,
    state,
    digest: digest as Hex,
    party: party as Address,
    label,
  };
}

export default function ConsentSignPage() {
  const { agentAddress, session } = useSession();
  const [request, setRequest] = useState<ConsentRequest | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { setRequest(parseConsentRequest()); }, []);

  const via = useMemo<Via>(() => {
    const v = (session?.via ?? 'passkey').toLowerCase();
    return v === 'wallet' ? 'wallet' : v === 'google' ? 'google' : 'passkey';
  }, [session?.via]);

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!request || !agentAddress) return;
    setBusy(true);
    setError(null);
    try {
      const out = await signConsent(
        request.party,
        request.digest,
        via,
        session?.token ? { token: session.token } : undefined,
      );
      if (!out.ok) { setError(out.error); return; }
      const ret = new URL(request.returnUrl);
      ret.searchParams.set('consent_state', request.state);
      ret.searchParams.set('consent_party', request.party);
      ret.searchParams.set('consent_digest', request.digest);
      ret.searchParams.set('consent_sig', out.signature);
      window.location.href = ret.toString();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'could not sign consent');
    } finally {
      setBusy(false);
    }
  }

  if (!request) {
    return (
      <SectionShell title="Agreement consent" description="This page signs your consent to a specific agreement at your home.">
        <div role="status" style={errorStyle}>
          No valid consent request. Open this from the app that is asking for your agreement consent.
        </div>
      </SectionShell>
    );
  }

  const signingAsSelf = !!agentAddress && request.party.toLowerCase() === agentAddress.toLowerCase();

  return (
    <SectionShell
      title="Agreement consent"
      description={`${request.appLabel} is asking you to consent to an agreement. Review it and sign with your credential — your signature is verified on chain, and nothing is granted or shared beyond this consent.`}
    >
      <div role="status" style={bannerStyle}>
        <span style={bannerIconStyle} aria-hidden="true">✓</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 800, color: 'var(--c-g900, #0f172a)' }}>
            {request.appLabel} is asking for your consent
          </div>
          <div style={{ fontSize: '.85rem', color: 'var(--c-g600, #475569)', marginTop: '.15rem' }}>
            You are consenting {signingAsSelf ? 'as yourself' : 'as an organization you steward'}. Both
            parties must consent before the agreement can be published.
          </div>
        </div>
      </div>

      <form onSubmit={handleSubmit} style={formStyle}>
        <div style={textBoxStyle}>
          <h3 style={textHeadStyle}>What you are consenting to</h3>
          <p style={{ color: 'var(--c-g700, #334155)', marginTop: '.6rem', lineHeight: 1.6 }}>{request.label}</p>
          <dl style={metaStyle}>
            <div style={metaRow}><dt style={metaDt}>Consenting as</dt><dd style={metaDd}>{request.party}</dd></div>
            <div style={metaRow}><dt style={metaDt}>Consent digest</dt><dd style={{ ...metaDd, fontFamily: 'monospace', fontSize: '.78rem', wordBreak: 'break-all' }}>{request.digest}</dd></div>
          </dl>
        </div>

        <label style={agreeStyle}>
          <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} style={{ marginTop: '.25rem' }} />
          <span>
            I consent to this agreement. My credential signs the consent digest above; the relying app
            receives only this signature, which is verified on chain under {signingAsSelf ? 'my agent' : 'the organization'}.
          </span>
        </label>

        {error && <div role="alert" style={errorStyle}>{error}</div>}

        <div style={footerStyle}>
          <button type="submit" disabled={busy || !agreed} style={primaryBtn}>
            {busy ? 'Signing…' : `Sign consent & return to ${request.appLabel} →`}
          </button>
          <a href={request.returnUrl} style={cancelLinkStyle}>Cancel and return to {request.appLabel}</a>
        </div>
      </form>
    </SectionShell>
  );
}

const bannerStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'flex-start', gap: '.75rem',
  background: 'var(--c-primary-subtle, #eef2ff)', border: '1px solid var(--c-primary-border, #c7d2fe)',
  borderRadius: 14, padding: '1rem 1.1rem', marginBottom: '1.25rem',
};
const bannerIconStyle: React.CSSProperties = {
  width: 36, height: 36, borderRadius: 10, flex: '0 0 auto',
  background: 'var(--c-primary, #4f46e5)', color: '#fff',
  display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 900, boxShadow: '0 1px 2px rgba(15,23,42,.06)',
};
const formStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: '1rem', maxWidth: 760 };
const textBoxStyle: React.CSSProperties = {
  background: 'var(--c-g50, #f8fafc)', border: '1px solid var(--c-g200, #e2e8f0)',
  borderRadius: 12, padding: '1.25rem 1.5rem', maxHeight: 420, overflow: 'auto',
};
const textHeadStyle: React.CSSProperties = { color: 'var(--c-g900, #0f172a)', fontSize: '1.15rem', margin: 0 };
const metaStyle: React.CSSProperties = { marginTop: '1rem', display: 'flex', flexDirection: 'column', gap: '.5rem' };
const metaRow: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: '.15rem' };
const metaDt: React.CSSProperties = { fontSize: '.72rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', color: 'var(--c-g500, #64748b)' };
const metaDd: React.CSSProperties = { margin: 0, fontSize: '.85rem', color: 'var(--c-g800, #1e293b)', wordBreak: 'break-all' };
const agreeStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'flex-start', gap: '.65rem', fontSize: '.9rem', color: 'var(--c-g700, #334155)',
};
const errorStyle: React.CSSProperties = {
  padding: '.65rem .9rem', borderRadius: 10, background: '#fef2f2', color: '#991b1b',
  border: '1px solid #fecaca', fontSize: '.875rem', fontWeight: 600,
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
