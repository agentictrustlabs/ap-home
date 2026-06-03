'use client';
// Your delegations (spec 246/247) — read from your home:
//   • Granted   — every scoped delegation you (or your orgs) issued, each individually
//                 visible + revocable: the org→app grant (site), the membership grant
//                 (you→org, lets the org read your member profile), and the stewardship
//                 grant (your org→you, lets you read/oversee the org).
//   • Received  — inbound grants your organizations received (org↔org only; never the
//                 grantor's person identity — ADR-0025).
import { useEffect, useState, type ReactNode } from 'react';
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
import type { DelegationWire } from '../../lib/delegation';
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

type GrantKind = 'site' | 'membership' | 'stewardship';
interface GrantItem {
  key: string;
  kind: GrantKind;
  org: MyOrg;
  delegation: DelegationWire;
}

/** Flatten each related org into the delegations it carries, so every grant the person
 *  made is individually visible + revocable. */
function grantItems(orgs: MyOrg[]): GrantItem[] {
  const items: GrantItem[] = [];
  for (const o of orgs) {
    if (o.delegation) items.push({ key: `site-${o.orgAgent}`, kind: 'site', org: o, delegation: o.delegation });
    if (o.membershipDelegation) items.push({ key: `mem-${o.orgAgent}`, kind: 'membership', org: o, delegation: o.membershipDelegation });
    if (o.stewardshipDelegation) items.push({ key: `stew-${o.orgAgent}`, kind: 'stewardship', org: o, delegation: o.stewardshipDelegation });
  }
  return items;
}

function grantCopy(it: GrantItem): { badge: string; title: string; blurb: ReactNode } {
  const name = it.org.orgName || 'this org';
  if (it.kind === 'membership') {
    return {
      badge: 'Membership',
      title: `You → ${name}`,
      blurb: <>You let <b>{name}</b> read your member profile from your vault. Revoke and it can no longer see you.</>,
    };
  }
  if (it.kind === 'stewardship') {
    return {
      badge: 'Stewardship',
      title: `${name} → You`,
      blurb: <><b>{name}</b> lets you read &amp; oversee its data from your home. Revoke to drop that oversight grant.</>,
    };
  }
  return {
    badge: 'App access',
    title: `${name} → ${it.org.requestedBy}`,
    blurb: <>You granted <b>{it.org.requestedBy}</b> scoped access to <b>{name}</b>.</>,
  };
}

export function DelegationsList({ token, heading = true }: { token: string | null; heading?: boolean }) {
  const { session } = useSession();
  const [orgs, setOrgs] = useState<MyOrg[]>([]);
  const [received, setReceived] = useState<ReceivedDelegation[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [revoked, setRevoked] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) { setLoaded(true); return; }
    let cancelled = false;
    Promise.all([listMyOrgs(token), listMyReceivedDelegations(token)])
      .then(([o, rec]) => {
        if (cancelled) return;
        setOrgs(o);
        setReceived(rec);
        setLoaded(true);
      })
      .catch(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, [token]);

  async function revoke(it: GrantItem) {
    if (!token) return;
    const { title } = grantCopy(it);
    if (!window.confirm(`Revoke this delegation (${title})? It takes effect immediately on chain.`)) return;
    setError(null);
    setRevoking(it.key);
    try {
      const signHash = await signerFor(session?.via ?? 'passkey', it.delegation.delegator, token);
      const r = await revokeGrantedDelegation(it.delegation, signHash);
      if (r.ok) setRevoked((s) => new Set(s).add(it.key));
      else setError(r.error);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'revoke failed');
    } finally {
      setRevoking(null);
    }
  }

  const items = grantItems(orgs).filter((it) => !revoked.has(it.key));

  return (
    <div className="dash-section" style={{ marginTop: heading ? '1.5rem' : 0 }}>
      {heading && <h2><LinkIcon size={16} /> Your delegations</h2>}
      <p style={{ color: 'var(--c-g500, #64748b)', fontSize: '.9rem', marginTop: heading ? '-.4rem' : 0, marginBottom: '.8rem' }}>
        Scoped, revocable access you granted to apps and your organizations, and the inbound access your
        organizations received. Each is a caveated delegation — never custody.
      </p>

      {!loaded ? (
        <p className="manage-card-blurb">Loading…</p>
      ) : (
        <>
          <h3 style={{ fontSize: '.9rem', margin: '.4rem 0' }}>Granted by you</h3>
          {items.length === 0 ? (
            <p className="manage-card-blurb">No delegations granted yet.</p>
          ) : (
            <div className="manage-grid">
              {items.map((it) => {
                const c = grantCopy(it);
                return (
                  <div className="manage-card" key={it.key}>
                    <div className="manage-card-head">
                      <span className="manage-card-label">{c.title}</span>
                      <span className="manage-card-badge live">{c.badge}</span>
                    </div>
                    <div style={{ margin: '.45rem 0' }}><AddressChip address={it.org.orgAgent} size="sm" /></div>
                    <p className="manage-card-blurb">{c.blurb}</p>
                    <button
                      type="button"
                      className="btn-danger-outline"
                      style={{ marginTop: '.6rem', fontSize: '.8rem', padding: '.35rem .7rem' }}
                      onClick={() => void revoke(it)}
                      disabled={revoking === it.key}
                    >
                      {revoking === it.key ? 'Revoking…' : 'Revoke'}
                    </button>
                  </div>
                );
              })}
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
