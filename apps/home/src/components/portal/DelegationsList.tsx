'use client';
// Your delegations (spec 247) — both directions, read from your home:
//   • Granted   — scoped org→site delegations you issued to community apps.
//   • Received  — inbound grants your organizations received (org↔org only; never
//                 the grantor's person identity — ADR-0025). Read from each org's
//                 own store via the person-session received-delegations query.
import { useEffect, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import {
  listMyOrgs,
  listMyReceivedDelegations,
  revokeGrantedDelegation,
  passkeySignHash,
  googleSignHash,
  type MyOrg,
  type ReceivedDelegation,
  type SignHash,
} from '../../connect-client';
import { connectWallet, personalSign } from '../../lib/wallet';
import { useSession } from '../../context/session';
import { AddressChip } from '../shared/AddressChip';
import { LinkIcon } from '../shared/Icons';

/** The signer for a revoke userOp, chosen by the session credential (mirrors onboarding's
 *  signHashFor). `delegator` is the SA whose ERC-1271 must validate (person SA or its org). */
async function signerFor(via: string, delegator: Address, token: string): Promise<SignHash> {
  const v = via.toLowerCase();
  if (v === 'wallet') {
    const addr = await connectWallet();
    return (h) => personalSign(addr, h);
  }
  if (v === 'google') return googleSignHash(delegator, token);
  return passkeySignHash;
}

export function DelegationsList({ token, heading = true }: { token: string | null; heading?: boolean }) {
  const { session } = useSession();
  const [granted, setGranted] = useState<MyOrg[]>([]);
  const [received, setReceived] = useState<ReceivedDelegation[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function revoke(o: MyOrg) {
    if (!o.delegation || !token) return;
    if (!window.confirm(`Revoke ${o.requestedBy}'s access to ${o.orgName || 'this organization'}? It loses access immediately.`)) return;
    setError(null);
    setRevoking(o.orgAgent);
    try {
      const signHash = await signerFor(session?.via ?? 'passkey', o.delegation.delegator, token);
      const r = await revokeGrantedDelegation(o.delegation, signHash);
      if (r.ok) setGranted((g) => g.filter((x) => x.orgAgent !== o.orgAgent));
      else setError(r.error);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'revoke failed');
    } finally {
      setRevoking(null);
    }
  }

  useEffect(() => {
    if (!token) { setLoaded(true); return; }
    let cancelled = false;
    Promise.all([listMyOrgs(token), listMyReceivedDelegations(token)])
      .then(([orgs, rec]) => {
        if (cancelled) return;
        setGranted(orgs.filter((o) => o.delegation));
        setReceived(rec);
        setLoaded(true);
      })
      .catch(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, [token]);

  return (
    <div className="dash-section" style={{ marginTop: heading ? '1.5rem' : 0 }}>
      {heading && <h2><LinkIcon size={16} /> Your delegations</h2>}
      <p style={{ color: 'var(--c-g500, #64748b)', fontSize: '.9rem', marginTop: heading ? '-.4rem' : 0, marginBottom: '.8rem' }}>
        Scoped, revocable access you granted to apps, and the inbound access your organizations
        received. Each is a caveated delegation — never custody.
      </p>

      {!loaded ? (
        <p className="manage-card-blurb">Loading…</p>
      ) : (
        <>
          <h3 style={{ fontSize: '.9rem', margin: '.4rem 0' }}>Granted by you</h3>
          {granted.length === 0 ? (
            <p className="manage-card-blurb">No delegations granted yet.</p>
          ) : (
            <div className="manage-grid">
              {granted.map((o) => (
                <div className="manage-card" key={`g-${o.orgAgent}`}>
                  <div className="manage-card-head">
                    <span className="manage-card-label">{o.orgName || '(unnamed org)'} → {o.requestedBy}</span>
                    <span className="manage-card-badge live">Granted</span>
                  </div>
                  <div style={{ margin: '.45rem 0' }}><AddressChip address={o.orgAgent} size="sm" /></div>
                  <p className="manage-card-blurb">
                    You granted <b>{o.requestedBy}</b> scoped access to <b>{o.orgName || 'this org'}</b>.
                  </p>
                  <button
                    type="button"
                    className="btn-danger-outline"
                    style={{ marginTop: '.6rem', fontSize: '.8rem', padding: '.35rem .7rem' }}
                    onClick={() => void revoke(o)}
                    disabled={revoking === o.orgAgent}
                  >
                    {revoking === o.orgAgent ? 'Revoking…' : 'Revoke access'}
                  </button>
                </div>
              ))}
            </div>
          )}
          {error && <p className="manage-card-blurb" style={{ color: 'var(--c-danger, #dc2626)' }}>Revoke failed: {error}</p>}

          <h3 style={{ fontSize: '.9rem', margin: '1rem 0 .4rem' }}>Received by your organizations</h3>
          {received.length === 0 ? (
            <p className="manage-card-blurb">No inbound delegations yet.</p>
          ) : (
            <div className="manage-grid">
              {received.map((r, i) => (
                <div className="manage-card" key={`r-${r.viaOrg}-${r.orgAgent}-${i}`}>
                  <div className="manage-card-head">
                    <span className="manage-card-label">{r.orgName || '(unnamed org)'} → {r.viaOrgName || 'your org'}</span>
                    <span className="manage-card-badge">Received</span>
                  </div>
                  <div style={{ margin: '.45rem 0' }}><AddressChip address={r.orgAgent} size="sm" /></div>
                  <p className="manage-card-blurb">
                    <b>{r.orgName || 'An organization'}</b> delegated scoped access to your{' '}
                    <b>{r.viaOrgName || 'organization'}</b>.
                  </p>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
