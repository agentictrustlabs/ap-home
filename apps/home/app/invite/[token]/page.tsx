'use client';
// Invite redemption landing (spec 315 invite). The invitee lands here from the email link (or an in-app
// chip). Signed in ⇒ accept = publish their own self-signed directory listing into the org's community
// (ADR-0025 — they consent by signing; this makes them an authority-only member). Not signed in ⇒ prompt
// to sign in first (any method, incl. email). One invitation, redeemed by joining.
import { use, useEffect, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { useSession } from '../../../src/context/session';
import { issueDirectoryListing } from '../../../src/home/directory';
import { orgHref } from '../../../src/lib/workspace';
import { EmailAuthCard } from '../../../src/components/portal/EmailAuthCard';
import { secureHomeNoName, activateVault, signHashFor, resolveVia } from '../../../src/home/onboarding';
import { recordOrgMembership } from '../../../src/lib/org-membership';
import { BusyButton } from '../../../src/components/shared/BusyButton';

// Coerce ANY thrown shape to a readable string — Error, a string, or a plain object with a `.message`
// (MetaMask/RPC rejections are objects like `{ code: 4001, message: 'User rejected …' }`, NOT Error
// instances, so `instanceof Error` alone silently dropped them to the fallback).
const asMsg = (x: unknown, fallback: string): string => {
  if (typeof x === 'string' && x) return x;
  if (x && typeof x === 'object') {
    const m = (x as { message?: unknown }).message;
    if (typeof m === 'string' && m) return m;
    try { const s = JSON.stringify(x); if (s && s !== '{}') return s; } catch { /* non-serializable */ }
  }
  return fallback;
};

export default function InviteRedeemPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const { session, profile, agentAddress, agentName, openSession } = useSession();
  const [invite, setInvite] = useState<{ org: string; orgName: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [otpFallback, setOtpFallback] = useState(false);

  useEffect(() => {
    void fetch(`/connect/org-invite/lookup?token=${encodeURIComponent(token)}`)
      .then((r) => r.json())
      .then((d) => { if (d.ok) setInvite({ org: d.org, orgName: d.orgName }); else setErr(d.error ?? 'invalid invitation'); })
      .catch(() => setErr('could not load this invitation'));
  }, [token]);

  const accept = async () => {
    if (!session || !agentAddress || !invite) return;
    setBusy(true); setErr(null);
    try {
      // Route by the home's ACTUAL on-chain credential, not the cookie `via` — a Google/KMS home has no
      // wallet/passkey, and the naive cookie via would wrongly pop MetaMask (or a passkey prompt).
      const via = resolveVia(profile?.credential, session.via);
      const sign = await signHashFor(via, agentAddress as Address, { token: session.token });
      const name = displayName.trim() || (agentName ? agentName.split('.')[0]! : 'Member');
      const listing = await issueDirectoryListing(agentAddress as Address, sign, {
        communityId: invite.org.toLowerCase(),
        displayName: name,
      });
      const res = await fetch('/connect/directory', {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
        body: JSON.stringify({ action: 'publish', listing }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: unknown };
      if (!res.ok || !body.ok) throw new Error(asMsg(body.error, `join failed (${res.status})`));
      await recordOrgMembership(agentAddress as Address, invite.org.toLowerCase(), sign, session.token, null, name);
      window.location.assign(orgHref(invite.org, 'channels'));
    } catch (e) { setErr(asMsg(e, 'could not join')); } finally { setBusy(false); }
  };

  // Magic-link accept (anonymous invitee, no prior home): clicking the emailed link proves inbox
  // possession, so the server bootstraps a KMS-custodied home bound to the invited email — no OTP, no app.
  // We then secure it on-chain, publish the invitee's self-signed join listing, and open the session. If
  // the org kept no email hash for this token, the server returns `needs-otp` → fall back to the code card.
  const redeemWithLink = async () => {
    if (!invite) return;
    setBusy(true); setErr(null);
    try {
      const r = await fetch('/connect/org-invite/redeem', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      const d = (await r.json().catch(() => ({}))) as { ok?: boolean; status?: string; token?: string; error?: unknown; memberAccessDelegation?: { delegate?: string } | null };
      if (r.ok && d.status === 'needs-otp') { setOtpFallback(true); return; }
      if (!r.ok || !d.ok || !d.token) throw new Error(asMsg(d.error, 'could not accept the invitation'));
      const res = await secureHomeNoName({ token: d.token });
      if (!res.ok) throw new Error(res.error);
      void activateVault(res.home.address, 'email', { token: d.token }); // spec 278 — best-effort vault
      // Fresh email-bootstrapped home → KMS via; signs server-side with the session token (no device prompt).
      const sign = await signHashFor('email', res.home.address, { token: d.token });
      const name = displayName.trim() || 'Member';
      const listing = await issueDirectoryListing(res.home.address, sign, {
        communityId: invite.org.toLowerCase(),
        displayName: name,
      });
      const pub = await fetch('/connect/directory', {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${d.token}` },
        body: JSON.stringify({ action: 'publish', listing }),
      });
      const pj = (await pub.json().catch(() => ({}))) as { ok?: boolean; error?: unknown };
      if (!pub.ok || !pj.ok) throw new Error(asMsg(pj.error, `join failed (${pub.status})`));
      await recordOrgMembership(res.home.address, invite.org.toLowerCase(), sign, d.token, d.memberAccessDelegation, name); // KMS-signed — no device prompt
      await openSession(d.token, 'email', false);
      window.location.assign(orgHref(invite.org, 'channels'));
    } catch (e) { setErr(asMsg(e, 'could not join')); } finally { setBusy(false); }
  };

  return (
    <div style={{ maxWidth: 440, margin: '4rem auto', padding: '1.5rem', fontFamily: 'system-ui, sans-serif' }}>
      {err && <p style={{ color: '#b91c1c' }}>{err}</p>}
      {!invite ? (
        !err && <p style={{ opacity: 0.7 }}>Loading invitation…</p>
      ) : (
        <>
          <h1 style={{ fontSize: '1.4rem' }}>You&rsquo;re invited to join <b>{invite.orgName}</b></h1>
          {session && agentAddress ? (
            <>
              <p style={{ fontSize: '.9rem', opacity: 0.75 }}>
                Accepting publishes a listing you sign — you become a member (you can leave anytime). Your keys
                stay yours; the org gets no custody.
              </p>
              <input
                placeholder="Display name (how members see you)"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                style={{ width: '100%', padding: '.55rem .7rem', margin: '.6rem 0', borderRadius: 8, border: '1px solid #d1d5db' }}
              />
              <BusyButton busy={busy} busyLabel="Signing…" onClick={() => void accept()}>
                Accept &amp; join {invite.orgName}
              </BusyButton>
              {(() => {
                const via = resolveVia(profile?.credential, session.via);
                const label = via === 'wallet' ? 'your wallet — a signature request will appear'
                  : via === 'passkey' ? 'your passkey'
                  : 'your secured account (no prompt)';
                return (
                  <p style={{ fontSize: '.75rem', opacity: 0.55, marginTop: '.5rem' }}>
                    Signs with {label}. <span style={{ opacity: 0.8 }}>(credential: {profile?.credential ?? '—'})</span>
                  </p>
                );
              })()}
            </>
          ) : (
            <>
              <p style={{ fontSize: '.9rem', opacity: 0.75 }}>
                You were invited by email — that&rsquo;s all we need. Accept and we&rsquo;ll set up your home
                automatically, no app to install. Your keys stay yours; the org gets no custody.
              </p>
              <input
                placeholder="Display name (how members see you)"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                style={{ width: '100%', padding: '.55rem .7rem', margin: '.6rem 0', borderRadius: 8, border: '1px solid #d1d5db' }}
              />
              {!otpFallback ? (
                <>
                  {/* One-click: the emailed link is the email-validation proof (magic link) → the server
                      bootstraps a KMS home bound to the invited email and this handler joins the org. */}
                  <BusyButton busy={busy} busyLabel="Setting up your home…" onClick={() => void redeemWithLink()}>
                    Accept &amp; join {invite.orgName}
                  </BusyButton>
                  <a className="btn-ghost" href={`/?invite=${encodeURIComponent(token)}`} style={{ display: 'block', marginTop: '.7rem' }}>
                    Already have a home? Use a passkey, wallet, or Google
                  </a>
                </>
              ) : (
                <>
                  {/* Fallback: no email hash stored for this token → verify by code, then Accept & join. */}
                  <p style={{ fontSize: '.85rem', opacity: 0.7, marginBottom: '.5rem' }}>
                    Verify your email to continue:
                  </p>
                  <EmailAuthCard />
                </>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
