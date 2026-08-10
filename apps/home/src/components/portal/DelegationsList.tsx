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
  type MyOrg,
  type ReceivedDelegation,
} from '../../connect-client';
import type { DelegationWire } from '../../lib/delegation';
import { orgStatusOf, STATUS_LABEL } from '../../lib/org-lifecycle';
import { emitControlEvent, toConnectedAppGrant } from '../../home/control-plane';
import { signHashFor, type Via } from '../../home/onboarding';
import { useSession } from '../../context/session';
import { AddressChip } from '../shared/AddressChip';
import { LinkIcon } from '../shared/Icons';

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
  // spec 342 — say when the org is hidden elsewhere, so a live grant from an org the person can't
  // see in any list isn't a mystery. The grant itself is unaffected by the status.
  const status = orgStatusOf(it.org);
  const name = `${it.org.orgName || 'this org'}${status === 'active' ? '' : ` (${STATUS_LABEL[status].toLowerCase()})`}`;
  if (it.kind === 'membership') {
    // spec 324 §12 — this is the member→org PROFILE-ACCESS delegation, NOT membership itself (ADR-0048 #3):
    // membership is a private Situation; revoking this authority never ends the membership.
    return {
      badge: 'Member profile access',
      title: `You → ${name}`,
      blurb: <>You let <b>{name}</b> read your member profile from your vault. This is an access grant, not your membership — revoking it stops the reads but you stay a member.</>,
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
    // 'any' (spec 342) — deliberately NOT lifecycle-filtered. Deactivating an org revokes nothing,
    // so a grant it still holds is still live; dropping the row would hide an authority that exists
    // and take away the only place to revoke it. Hiding an org is a view decision about ROSTERS,
    // never about credentials.
    Promise.all([listMyOrgs(token, 'any'), listMyReceivedDelegations(token)])
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
      const signHash = await signHashFor((session?.via ?? 'passkey').toLowerCase() as Via, it.delegation.delegator, { token });
      const r = await revokeGrantedDelegation(it.delegation, signHash);
      if (r.ok) {
        setRevoked((s) => new Set(s).add(it.key));
        // Control-plane timeline (spec 310 W4) — the on-chain revoke is canonical;
        // this records the projection row with the delegation's AuthorityRef.
        void emitControlEvent(token, 'grant-revoked', [toConnectedAppGrant(it.kind, it.delegation, true).grantRef]);
      } else setError(r.error);
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
                // Portable projection (spec 310 W4): status + expiry come from the
                // delegation's own timestamp caveat, keyed by its canonical hash.
                const grant = toConnectedAppGrant(it.kind, it.delegation);
                return (
                  <div className="manage-card" key={it.key}>
                    <div className="manage-card-head">
                      <span className="manage-card-label">{c.title}</span>
                      <span className="manage-card-badge live">{c.badge}</span>
                    </div>
                    <div style={{ margin: '.45rem 0' }}><AddressChip address={it.org.orgAgent} size="sm" /></div>
                    <p className="manage-card-blurb">{c.blurb}</p>
                    <p className="manage-card-blurb" style={{ fontSize: '.78rem', opacity: 0.75 }}>
                      {grant.status === 'active' ? 'Active' : grant.status}
                      {grant.expiresAt ? ` · until ${new Date(grant.expiresAt).toLocaleDateString()}` : ''}
                      {' · '}<code>{grant.grantRef.hash.slice(0, 10)}…</code>
                    </p>
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
