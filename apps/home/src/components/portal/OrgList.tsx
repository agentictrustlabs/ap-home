'use client';
// Shared "your organizations" list — read from the person's PRIVATE vault (spec 246 /
// ADR-0025). The person↔org link lives at the home, never as a public on-chain edge; apps
// only see what the person delegates. Used by /you and /organizations.
import { useEffect, useState } from 'react';
import { listMyOrgs, type MyOrg } from '../../connect-client';
import { vaultListWithDelegation, vaultReadWithDelegation, type VaultRecordRef } from '../../lib/vault-client';
import { AddressChip } from '../shared/AddressChip';
import { BuildingIcon } from '../shared/Icons';

const EXPLORER = 'https://sepolia.basescan.org/address/';

export function purposeLabel(p: string): string {
  if (p === 'jp-adopter-org') return 'Adopter org';
  if (p === 'jp-facilitator-org') return 'Facilitator org';
  return p.replace(/-/g, ' ');
}

/** Read this org's vault using the STEWARDSHIP delegation (org→person) the person holds
 *  (spec 246): the person oversees the org, so they can list + read its records. The owner
 *  of the data is the org (the delegator); the read goes through demo-a2a → demo-mcp. */
function OrgVaultView({ org }: { org: MyOrg }) {
  const d = org.stewardshipDelegation;
  const [open, setOpen] = useState(false);
  const [records, setRecords] = useState<VaultRecordRef[] | null>(null);
  const [bodies, setBodies] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (!d) return null; // older / operator-registered orgs have no stewardship delegation

  async function load() {
    setOpen(true);
    if (records) return;
    setBusy(true);
    setErr(null);
    try {
      setRecords(await vaultListWithDelegation(d!));
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'read failed');
    } finally {
      setBusy(false);
    }
  }

  async function show(rt: string) {
    if (bodies[rt]) return;
    try {
      const data = await vaultReadWithDelegation(d!, rt);
      setBodies((b) => ({ ...b, [rt]: JSON.stringify(data, null, 2) }));
    } catch (e) {
      setBodies((b) => ({ ...b, [rt]: `(error: ${e instanceof Error ? e.message : 'read failed'})` }));
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        className="btn-ghost"
        style={{ marginTop: '.5rem', fontSize: '.8rem', padding: '.3rem .6rem' }}
        onClick={() => void load()}
      >
        View org data ↗
      </button>
    );
  }
  return (
    <div style={{ marginTop: '.5rem', borderTop: '1px solid var(--c-g100, #eee)', paddingTop: '.5rem' }}>
      <div style={{ fontSize: '.72rem', color: 'var(--c-g500, #64748b)', marginBottom: '.35rem' }}>
        Read with your stewardship delegation — you oversee this org.
      </div>
      {busy ? (
        <p className="manage-card-blurb">Reading {org.orgName || 'this org'}&rsquo;s vault…</p>
      ) : err ? (
        <p className="manage-card-blurb" style={{ color: 'var(--c-danger, #dc2626)' }}>Couldn&rsquo;t read: {err}</p>
      ) : !records || records.length === 0 ? (
        <p className="manage-card-blurb">This org&rsquo;s vault is empty.</p>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, fontSize: '.78rem' }}>
          {records.map((r) => (
            <li key={r.record_type} style={{ marginBottom: '.3rem' }}>
              <code>{r.record_type}</code>{' '}
              <button
                type="button"
                onClick={() => void show(r.record_type)}
                style={{ background: 'none', border: 'none', color: 'var(--c-accent, #2563eb)', cursor: 'pointer', fontSize: '.76rem', padding: 0 }}
              >
                show
              </button>
              {bodies[r.record_type] && (
                <pre style={{ background: 'var(--c-g50, #f8fafc)', padding: '.4rem .55rem', borderRadius: 6, overflowX: 'auto', fontSize: '.72rem', margin: '.25rem 0 0' }}>
                  {bodies[r.record_type]}
                </pre>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function OrgList({ token, heading = true, onSelect }: { token: string | null; heading?: boolean; onSelect?: (org: MyOrg) => void }) {
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
              {onSelect ? (
                <button
                  type="button"
                  className="btn-ghost"
                  style={{ marginTop: '.5rem', fontSize: '.8rem', padding: '.3rem .6rem' }}
                  onClick={() => onSelect(o)}
                >
                  View details →
                </button>
              ) : (
                <OrgVaultView org={o} />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
