'use client';
// Invite redemption landing (spec 315 invite). The invitee lands here from the email link (or an in-app
// chip). Signed in ⇒ accept = publish their own self-signed directory listing into the org's community
// (ADR-0025 — they consent by signing; this makes them an authority-only member). Not signed in ⇒ prompt
// to sign in first (any method, incl. email). One invitation, redeemed by joining.
import { use, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Address } from '@agenticprimitives/types';
import { useSession } from '../../../src/context/session';
import { connectWallet, personalSign } from '../../../src/lib/wallet';
import { passkeySignHash, googleSignHash, type SignHash } from '../../../src/connect-client';
import { issueDirectoryListing } from '../../../src/home/directory';
import { orgHref } from '../../../src/lib/workspace';
import { EmailAuthCard } from '../../../src/components/portal/EmailAuthCard';
import { secureHomeNoName, activateVault } from '../../../src/home/onboarding';

async function signerFor(via: string, agent: Address, token: string): Promise<SignHash> {
  const v = via.toLowerCase();
  if (v === 'wallet') { const addr = await connectWallet(); return (h) => personalSign(addr, h); }
  // KMS-custodied homes (Google / YouVersion / email-bootstrap) sign server-side via the session token.
  if (v === 'google' || v === 'youversion' || v === 'email') return googleSignHash(agent, token);
  return passkeySignHash;
}

export default function InviteRedeemPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const router = useRouter();
  const { session, agentAddress, agentName, openSession } = useSession();
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
      const sign = await signerFor(session.via, agentAddress as Address, session.token);
      const name = displayName.trim() || (agentName ? agentName.split('.')[0]! : 'Member');
      const listing = await issueDirectoryListing(agentAddress as Address, sign, {
        communityId: invite.org.toLowerCase(),
        displayName: name,
      });
      const res = await fetch('/connect/directory', {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
        body: JSON.stringify({ action: 'publish', listing }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !body.ok) throw new Error(body.error ?? `join failed (${res.status})`);
      router.push(orgHref(invite.org, 'channels'));
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
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
      const d = (await r.json().catch(() => ({}))) as { ok?: boolean; status?: string; token?: string; error?: string };
      if (r.ok && d.status === 'needs-otp') { setOtpFallback(true); return; }
      if (!r.ok || !d.ok || !d.token) throw new Error(d.error ?? 'could not accept the invitation');
      const res = await secureHomeNoName({ token: d.token });
      if (!res.ok) throw new Error(res.error);
      void activateVault(res.home.address, 'email', { token: d.token }); // spec 278 — best-effort vault
      const sign = googleSignHash(res.home.address, d.token); // KMS-custodied home signs server-side
      const name = displayName.trim() || 'Member';
      const listing = await issueDirectoryListing(res.home.address, sign, {
        communityId: invite.org.toLowerCase(),
        displayName: name,
      });
      const pub = await fetch('/connect/directory', {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${d.token}` },
        body: JSON.stringify({ action: 'publish', listing }),
      });
      const pj = (await pub.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!pub.ok || !pj.ok) throw new Error(pj.error ?? `join failed (${pub.status})`);
      await openSession(d.token, 'email', false);
      router.push(orgHref(invite.org, 'channels'));
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
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
              <button className="btn" disabled={busy} onClick={() => void accept()}>
                {busy ? 'Signing…' : `Accept & join ${invite.orgName}`}
              </button>
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
                  <button className="btn" disabled={busy} onClick={() => void redeemWithLink()}>
                    {busy ? 'Setting up your home…' : `Accept & join ${invite.orgName}`}
                  </button>
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
