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

async function signerFor(via: string, agent: Address, token: string): Promise<SignHash> {
  const v = via.toLowerCase();
  if (v === 'wallet') { const addr = await connectWallet(); return (h) => personalSign(addr, h); }
  if (v === 'google') return googleSignHash(agent, token);
  return passkeySignHash;
}

export default function InviteRedeemPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const router = useRouter();
  const { session, agentAddress, agentName } = useSession();
  const [invite, setInvite] = useState<{ org: string; orgName: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [displayName, setDisplayName] = useState('');

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
                Sign in to accept this invitation — with a passkey, wallet, Google, or email.
              </p>
              <a className="btn" href={`/?invite=${encodeURIComponent(token)}`}>Sign in to accept</a>
            </>
          )}
        </>
      )}
    </div>
  );
}
