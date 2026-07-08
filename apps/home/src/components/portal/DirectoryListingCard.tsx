'use client';
// Opt-in community directory listing (spec 312 §4.4 / W3). ADR-0025: no roster
// is ever inferred — you appear in a community's directory ONLY because you
// published this self-signed, revocable listing. Your ROOT credential signs it.
import { useCallback, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { passkeySignHash, googleSignHash, type SignHash } from '../../connect-client';
import { connectWallet, personalSign } from '../../lib/wallet';
import { nameLabel } from '../../lib/domain';
import { useSession } from '../../context/session';
import { issueDirectoryListing } from '../../home/directory';

async function signerFor(via: string, agent: Address, token: string): Promise<SignHash> {
  const v = via.toLowerCase();
  if (v === 'wallet') {
    const addr = await connectWallet();
    return (h) => personalSign(addr, h);
  }
  if (v === 'google') return googleSignHash(agent, token);
  return passkeySignHash;
}

export function DirectoryListingCard() {
  const { session, agentAddress, agentName } = useSession();
  const [communityId, setCommunityId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const publish = useCallback(async () => {
    if (!session || !agentAddress) return;
    setBusy(true);
    setMsg(null);
    try {
      const sign = await signerFor(session.via, agentAddress as Address, session.token);
      const listing = await issueDirectoryListing(agentAddress as Address, sign, {
        communityId: communityId.trim().toLowerCase(),
        displayName: displayName.trim(),
      });
      const res = await fetch('/connect/directory', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
        body: JSON.stringify({ action: 'publish', listing }),
      });
      const body = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !body.ok) throw new Error(body.error ?? `publish failed (${res.status})`);
      setMsg(`Listed in "${communityId.trim().toLowerCase()}". People in this community can now find you and message your inbox.`);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [session, agentAddress, communityId, displayName]);

  const revoke = useCallback(async () => {
    if (!session || !communityId.trim()) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch('/connect/directory', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
        body: JSON.stringify({ action: 'revoke', communityId: communityId.trim().toLowerCase() }),
      });
      const body = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !body.ok) throw new Error(body.error ?? `revoke failed (${res.status})`);
      setMsg('Listing removed — you are no longer discoverable in that community.');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [session, communityId]);

  if (!session || !agentAddress) return null;

  if (!agentName) {
    return (
      <div className="dash-section" style={{ marginTop: '1.5rem' }}>
        <h2>Community directory</h2>
        <p style={{ opacity: 0.8 }}>
          Directory entries are name-addressed — claim your agent name first, then you can opt in to a
          community directory so others can find and message you.
        </p>
      </div>
    );
  }

  return (
    <div className="dash-section" style={{ marginTop: '1.5rem' }}>
      <h2>Community directory</h2>
      <p style={{ opacity: 0.8 }}>
        Opt in to be discoverable by people in a community you belong to. This publishes a listing you
        sign and can revoke anytime — nothing about your memberships is shared without it.
      </p>
      <div style={{ display: 'grid', gap: '0.5rem', maxWidth: 480 }}>
        <input
          placeholder="Community id (agree on one with your community, e.g. grace-chapel)"
          value={communityId}
          onChange={(e) => setCommunityId(e.target.value)}
          style={{ padding: '0.4rem 0.6rem', border: '1px solid #d1d5db', borderRadius: 6 }}
        />
        <input
          placeholder={`Display name (e.g. ${nameLabel(agentName)})`}
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          style={{ padding: '0.4rem 0.6rem', border: '1px solid #d1d5db', borderRadius: 6 }}
        />
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button className="btn" disabled={busy || !communityId.trim() || !displayName.trim()} onClick={() => void publish()}>
            {busy ? 'Signing…' : 'Publish listing'}
          </button>
          <button className="btn" disabled={busy || !communityId.trim()} onClick={() => void revoke()}>
            Remove listing
          </button>
        </div>
      </div>
      {msg && <p style={{ marginTop: '0.5rem' }}>{msg}</p>}
    </div>
  );
}
