'use client';
// Shared "your organizations" list — read from the person's PRIVATE vault (spec 246 /
// ADR-0025). The person↔org link lives at the home, never as a public on-chain edge; apps
// only see what the person delegates. Used by /you and /organizations.
import { useEffect, useState } from 'react';
import { listMyOrgs, type MyOrg } from '../../connect-client';
import { AddressChip } from '../shared/AddressChip';
import { BuildingIcon } from '../shared/Icons';

const EXPLORER = 'https://sepolia.basescan.org/address/';

export function purposeLabel(p: string): string {
  if (p === 'jp-adopter-org') return 'Adopter org';
  if (p === 'jp-facilitator-org') return 'Facilitator org';
  return p.replace(/-/g, ' ');
}

export function OrgList({ token, heading = true }: { token: string | null; heading?: boolean }) {
  const [orgs, setOrgs] = useState<MyOrg[]>([]);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (!token) { setLoaded(true); return; }
    let cancelled = false;
    void listMyOrgs(token)
      .then((o) => { if (!cancelled) { setOrgs(o); setLoaded(true); } })
      .catch(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, [token]);

  return (
    <div className="dash-section" style={{ marginTop: heading ? '1.5rem' : 0 }}>
      {heading && <h2>Your organizations</h2>}
      <p style={{ color: 'var(--c-g500, #64748b)', fontSize: '.9rem', marginTop: heading ? '-.4rem' : 0, marginBottom: '.8rem' }}>
        Organizations you created — each its own Smart Agent, custodied by you. This link is private to
        your home; apps only see what you delegate to them.
      </p>
      {!loaded ? (
        <p className="manage-card-blurb">Loading…</p>
      ) : orgs.length === 0 ? (
        <p className="manage-card-blurb">No organizations yet — create one from a community app.</p>
      ) : (
        <div className="manage-grid">
          {orgs.map((o) => (
            <div className="manage-card" key={o.orgAgent}>
              <div className="manage-card-head">
                <span className="manage-card-label"><BuildingIcon size={16} /> {o.orgName || '(unnamed org)'}</span>
                <span className="manage-card-badge live">{purposeLabel(o.purpose)}</span>
              </div>
              <div style={{ margin: '.45rem 0' }}><AddressChip address={o.orgAgent} size="sm" /></div>
              <p className="manage-card-blurb">
                Created for <b>{o.requestedBy}</b>. Custodied by you; {o.requestedBy} holds only a scoped
                delegation. <a href={EXPLORER + o.orgAgent} target="_blank" rel="noreferrer">View on explorer ↗</a>
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
