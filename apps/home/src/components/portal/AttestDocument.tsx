'use client';
// Signing a document at the member's Home. One component for every attestable document (`src/whitelabel/
// attestable-documents.ts`); `/wea-sign` and `/attest/[doc]` both render it. Two modes, the shape /profile has:
//
//   • Self-sign (no params): browse from /attestations and sign for community-wide re-use. The attestation lives
//     at this Home.
//
//   • Relying-app handoff (`?app=&return=&state=`): a community app (e.g. JP Adopt) needs the attestation. We show
//     the same canonical text + an "<app> is asking" banner, sign on Save, store the attestation here, and redirect
//     back to the relying app with `<prefix>_state=&<prefix>_docHash=&<prefix>_docId=&<prefix>_signedAt=
//     &<prefix>_consentBoundTo=` (plus the publisher, handle, slug, version and release id for a signed-release
//     record). The relying app verifies the hash by recomputing it from its own canonical bytes (inline-text) or
//     by reading the same signed release from the publisher (signed-release).
//
// The text shown is the text committed to: inline bytes the Home holds, or the parts of the publisher's signed
// release read through `/attestations/release` moments ago. A signed-release document cannot be signed unless the
// publisher's verifier says `verified` — there is no fallback (ADR-0013).

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useSession } from '../../context/session';
import { loadImpactProfile, saveImpactProfile, type ImpactStoredProfile, type StoredAttestation } from '../../profile-store';
import {
  buildAttestation, consentBinding, inlineTextHash, returnParams, storedFor, type AttestableDocument, type ResolvedCommitment,
} from '../../attestation-docs';
import type { PublishedPart } from '../../lib/published-work';
import { relyingAllowed } from '../onboarding/useEnrollReq';
import { whitelabel } from '../../whitelabel/config';
import { SectionShell } from './SectionShell';

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

/** What `/attestations/release` answers for a signed-release document. */
interface ReleaseAnswer {
  ok: true; docId: string; docHash: string; title: string; url: string; partCount: number; verdict: string; signatureStatus: string;
  source: NonNullable<StoredAttestation['source']>; parts: PublishedPart[];
}
type ReleaseState = { phase: 'loading' } | { phase: 'ready'; release: ReleaseAnswer } | { phase: 'failed'; why: string };

export function AttestDocument({ doc }: { doc: AttestableDocument }) {
  const { agentAddress, session } = useSession();
  const [request, setRequest] = useState<RelyingRequest | null>(null);
  const [existing, setExisting] = useState<StoredAttestation | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [release, setRelease] = useState<ReleaseState>({ phase: 'loading' });
  const isRelease = doc.commitment.kind === 'signed-release';

  useEffect(() => { setRequest(parseRelyingRequest()); }, []);
  useEffect(() => {
    if (!agentAddress) return;
    let cancelled = false;
    // Best-effort: an un-activated vault (no binding) just means no prior attestation to show.
    loadImpactProfile(agentAddress)
      .then((p) => { if (!cancelled) setExisting(storedFor(p.attestations, doc)); })
      .catch(() => { /* vault locked / unreachable → treat as not-yet-signed */ });
    return () => { cancelled = true; };
  }, [agentAddress, doc]);

  // A signed-release document: read the publisher's release (and its text) through our own route.
  useEffect(() => {
    if (!isRelease) return;
    let cancelled = false;
    setRelease({ phase: 'loading' });
    fetch(`/attestations/release?doc=${encodeURIComponent(doc.id)}`, { headers: { accept: 'application/json' } })
      .then(async (r) => {
        const j = (await r.json().catch(() => null)) as (ReleaseAnswer & { ok: true }) | { ok: false; error?: string } | null;
        if (cancelled) return;
        if (!j || !j.ok) { setRelease({ phase: 'failed', why: (j && 'error' in j && j.error) || `the release could not be read (${r.status})` }); return; }
        setRelease({ phase: 'ready', release: j });
      })
      .catch((e: unknown) => { if (!cancelled) setRelease({ phase: 'failed', why: e instanceof Error ? e.message : 'the release could not be read' }); });
    return () => { cancelled = true; };
  }, [doc.id, isRelease]);

  const alreadySigned = !!existing;
  const signedDate = useMemo(
    () => (existing ? new Date(existing.signedAt * 1000).toLocaleDateString() : null),
    [existing],
  );
  const releaseVerified = release.phase === 'ready' && release.release.verdict === 'verified';
  // Signing needs a commitment in hand: inline bytes always; a release only once it is read and verified.
  const canSign = alreadySigned || !isRelease || releaseVerified;
  // A re-used record whose root no longer matches the live release is worth saying out loud; it stays valid for
  // what the member affirmed then, and the relying app compares roots itself.
  const rootMoved = existing && release.phase === 'ready' && existing.docHash !== release.release.docHash;

  async function resolveCommitment(): Promise<ResolvedCommitment> {
    if (doc.commitment.kind === 'inline-text') return { docHash: await inlineTextHash(doc.commitment.text) };
    if (release.phase !== 'ready') throw new Error('the publisher’s release has not been read yet');
    if (release.release.verdict !== 'verified') throw new Error(`the publisher’s release is not verified (${release.release.verdict})`);
    return { docHash: release.release.docHash, source: release.release.source };
  }

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!agentAddress || !session?.token) return;
    setBusy(true);
    setError(null);
    try {
      let att: StoredAttestation;
      if (existing) {
        // Already signed at this home — reuse the stored attestation. The point of
        // a community-wide attestation is re-use without re-signing.
        att = existing;
      } else {
        const resolved = await resolveCommitment();
        att = buildAttestation(doc, resolved, await consentBinding(session.token));
        const existingProfile = await loadImpactProfile(agentAddress);
        const next: ImpactStoredProfile = {
          ...existingProfile,
          attestations: { ...(existingProfile.attestations ?? {}), [doc.storageKey]: att },
        };
        await saveImpactProfile(agentAddress, next);
        setExisting(att);
      }
      if (request) {
        const ret = new URL(request.returnUrl);
        ret.searchParams.set(`${doc.returnPrefix}_state`, request.state);
        for (const [k, v] of Object.entries(returnParams(doc, att))) ret.searchParams.set(k, v);
        window.location.href = ret.toString();
        return;
      }
      setSavedNotice('Signed at your home');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'signing failed');
    } finally {
      setBusy(false);
    }
  }

  // Pre-check the box if already signed — saves the member a click when re-using.
  useEffect(() => { if (alreadySigned) setAgreed(true); }, [alreadySigned]);

  return (
    <SectionShell
      title={doc.title}
      description={
        request
          ? `${request.appLabel} is asking for your ${doc.title} attestation. Sign it once here at your home — every faith-aligned community app will see “✓ on file.”`
          : `Affirm ${doc.title} once at your home — re-used across every faith-aligned community app that needs it.`
      }
    >
      {request && (
        <div role="status" style={bannerStyle}>
          <span style={bannerIconStyle} aria-hidden="true">!</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 800, color: 'var(--c-g900, #0f172a)' }}>
              {request.appLabel} is asking for your {doc.title} attestation
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
          ✓ Signed on <b>{signedDate}</b>.{request ? ' The relying app will receive your existing attestation.' : ''}
          {rootMoved && ' The publisher has since released a new version; your attestation stays with the text you affirmed.'}
        </div>
      )}

      <form onSubmit={handleSubmit} style={formStyle}>
        <div style={textBoxStyle}>
          {doc.commitment.kind === 'inline-text' && <InlineText text={doc.commitment.text} />}
          {doc.commitment.kind === 'signed-release' && (
            release.phase === 'loading' ? <p style={mutedStyle}>Reading the publisher’s signed release…</p>
            : release.phase === 'failed' ? <p role="alert" style={errorStyle}>The text could not be read from the publisher: {release.why}</p>
            : <ReleaseText title={doc.title} parts={release.release.parts} />
          )}
        </div>

        <Provenance doc={doc} release={release} />

        <label style={agreeStyle}>
          <input
            type="checkbox" checked={agreed} disabled={alreadySigned || !canSign}
            onChange={(e) => setAgreed(e.target.checked)}
            style={{ marginTop: '.25rem' }}
          />
          <span>
            {doc.affirmation}
            {' '}{alreadySigned
              ? 'Already affirmed at your home.'
              : 'This signs an attestation stored at your home; the relying app receives only the hash receipt + signing date.'}
          </span>
        </label>

        {savedNotice && <div role="status" style={savedStyle}>✓ {savedNotice}</div>}
        {error && <div role="alert" style={errorBoxStyle}>{error}</div>}

        <div style={footerStyle}>
          <button type="submit" disabled={busy || !canSign || (!agreed && !alreadySigned)} style={primaryBtn}>
            {busy ? 'Signing…' : request
              ? (alreadySigned ? `Send attestation to ${request.appLabel} →` : `Sign & return to ${request.appLabel} →`)
              : (alreadySigned ? 'Already signed' : 'Sign at my home')}
          </button>
          {request && (
            <a href={request.returnUrl} style={cancelLinkStyle}>Cancel and return to {request.appLabel}</a>
          )}
          {!request && <a href="/attestations" style={cancelLinkStyle}>Back</a>}
        </div>
      </form>
    </SectionShell>
  );
}

/** Inline canonical bytes, rendered line by line: the first line as the heading, numbered lines as a list. */
function InlineText({ text }: { text: string }) {
  const lines = text.split('\n');
  const head = lines[0] ?? '';
  const rest = lines.slice(1).filter((l) => l.trim() !== '');
  const items = rest.filter((l) => /^\d+\.\s/.test(l));
  const paras = rest.filter((l) => !/^\d+\.\s/.test(l));
  return (
    <>
      <h3 style={textHeadStyle}>{head}</h3>
      {paras.map((p, i) => <p key={i} style={{ color: 'var(--c-g600, #475569)', marginTop: '.6rem' }}>{p}</p>)}
      {items.length > 0 && (
        <ol style={listStyle}>
          {items.map((l, i) => <li key={i} style={listItemStyle}>{l.replace(/^\d+\.\s/, '')}</li>)}
        </ol>
      )}
    </>
  );
}

/** The parts of a signed release. A part's text begins with its own heading; the title is shown once. */
function ReleaseText({ title, parts }: { title: string; parts: PublishedPart[] }) {
  return (
    <>
      <h3 style={textHeadStyle}>{title}</h3>
      {parts.map((p) => {
        const body = (p.text ?? '').split('\n').filter((l) => !/^#\s/.test(l)).join('\n').trim();
        const paras = body.split(/\n\s*\n/).filter((x) => x.trim() !== '');
        return (
          <section key={p.n} style={{ marginTop: '1rem' }}>
            <h4 style={partHeadStyle}>{p.title}</h4>
            {p.text === null
              ? <p style={mutedStyle}>This part is not public.</p>
              : paras.map((para, i) => <p key={i} style={paraStyle}>{para}</p>)}
          </section>
        );
      })}
    </>
  );
}

/** Where the words came from and what the attestation commits to — the reader sees the same facts the record stores. */
function Provenance({ doc, release }: { doc: AttestableDocument; release: ReleaseState }) {
  return (
    <div style={provenanceStyle}>
      <div>
        <b>Author:</b> {doc.author}
        {doc.sourceUrl && <> · <a href={doc.sourceUrl} target="_blank" rel="noreferrer noopener" style={linkStyle}>source</a></>}
      </div>
      {doc.commitment.kind === 'inline-text' && (
        <div>Canonical text held at this home; the attestation commits to its SHA-256.</div>
      )}
      {doc.commitment.kind === 'signed-release' && release.phase === 'ready' && (
        <div>
          Read from the publisher’s signed release <code style={monoStyle}>{release.release.source.handle}/{release.release.source.slug}</code> v{release.release.source.version}
          {' · '}{release.release.verdict === 'verified'
            ? <span style={{ color: '#166534', fontWeight: 700 }}>✓ release verified</span>
            : <span style={{ color: '#b91c1c', fontWeight: 700 }}>release {release.release.verdict} — cannot be signed</span>}
          {release.release.url && <> · <a href={release.release.url} target="_blank" rel="noreferrer noopener" style={linkStyle}>read it there</a></>}
          <div style={{ marginTop: '.2rem' }}>Commitment <code style={monoStyle}>{release.release.docHash}</code></div>
        </div>
      )}
    </div>
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
const partHeadStyle: React.CSSProperties = { color: 'var(--c-g900, #0f172a)', fontSize: '1rem', margin: '0 0 .35rem' };
const paraStyle: React.CSSProperties = { color: 'var(--c-g700, #334155)', fontSize: '.95rem', margin: '0 0 .6rem', lineHeight: 1.6 };
const mutedStyle: React.CSSProperties = { color: 'var(--c-g500, #64748b)', fontSize: '.9rem', margin: 0 };
const errorStyle: React.CSSProperties = { color: '#b91c1c', fontSize: '.9rem', margin: 0 };
const listStyle: React.CSSProperties = { paddingLeft: '1.5rem', marginTop: '.5rem' };
const listItemStyle: React.CSSProperties = { color: 'var(--c-g700, #334155)', fontSize: '.95rem', marginBottom: '.6rem', lineHeight: 1.6 };
const provenanceStyle: React.CSSProperties = {
  fontSize: '.8rem', color: 'var(--c-g600, #475569)', display: 'flex', flexDirection: 'column', gap: '.25rem', lineHeight: 1.5,
};
const monoStyle: React.CSSProperties = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '.78rem', wordBreak: 'break-all' };
const linkStyle: React.CSSProperties = { color: 'var(--c-primary, #4f46e5)', textDecoration: 'underline' };
const agreeStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'flex-start', gap: '.65rem', fontSize: '.9rem', color: 'var(--c-g700, #334155)',
};
const savedStyle: React.CSSProperties = {
  padding: '.65rem .9rem', borderRadius: 10, background: '#dcfce7', color: '#166534',
  border: '1px solid #86efac', fontSize: '.875rem', fontWeight: 600,
};
const errorBoxStyle: React.CSSProperties = {
  padding: '.65rem .9rem', borderRadius: 10, background: '#fef2f2', color: '#b91c1c',
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
