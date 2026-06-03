'use client';
// Organization detail (spec 246/247) — everything the person's home knows about one org
// they govern, plus live reads over the two person↔org delegations:
//   • Stewardship (org→you)   → read the ORG's vault (its records).
//   • Membership  (you→org)   → read YOUR member record the org is entitled to see.
// All MCP access goes through demo-a2a; no data is copied into the home.
import { useEffect, useState, type ReactNode } from 'react';
import { decodeAbiParameters } from 'viem';
import type { Address } from '@agenticprimitives/types';
import { listMyReceivedDelegations, type MyOrg, type ReceivedDelegation } from '../../connect-client';
import type { DelegationWire } from '../../lib/delegation';
import { CONTRACTS } from '../../lib/chain';
import { vaultListWithDelegation, vaultReadWithDelegation, vaultWriteWithDelegation, type VaultRecordRef } from '../../lib/vault-client';
import { AddressChip } from '../shared/AddressChip';
import { BuildingIcon, LinkIcon } from '../shared/Icons';

/** The org's managed profile — the canonical "org details" record the steward edits.
 *  Stored in the ORG's own vault under `org:profile`, written over the stewardship
 *  delegation (delegator = org). Free-form, vertical-agnostic. */
const RT_ORG_PROFILE = 'org:profile';
interface OrgProfile {
  v: 1;
  displayName?: string;
  description?: string;
  website?: string;
  contactEmail?: string;
  location?: string;
}

const EXPLORER = 'https://sepolia.basescan.org/address/';
const ROOT_AUTHORITY = '0x0000000000000000000000000000000000000000000000000000000000000000';
const short = (h?: string) => (h && h.length > 14 ? `${h.slice(0, 8)}…${h.slice(-6)}` : h ?? '—');

function purposeLabel(p: string): string {
  if (p === 'jp-adopter-org') return 'Adopter org';
  if (p === 'jp-facilitator-org') return 'Facilitator org';
  return p.replace(/-/g, ' ');
}

/** Human-readable summary of a single caveat, decoded by matching the enforcer address. */
function caveatLabel(c: { enforcer: Address; terms: `0x${string}` }): string {
  const e = c.enforcer.toLowerCase();
  try {
    if (e === CONTRACTS.timestampEnforcer.toLowerCase()) {
      const [, validUntil] = decodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], c.terms) as [bigint, bigint];
      return `Time-boxed — expires ${new Date(Number(validUntil) * 1000).toLocaleString()}`;
    }
    if (e === CONTRACTS.valueEnforcer.toLowerCase()) {
      const [v] = decodeAbiParameters([{ type: 'uint256' }], c.terms) as [bigint];
      return v === 0n ? 'No value transfer (0 wei)' : `Max value ${v.toString()} wei`;
    }
    if (e === CONTRACTS.allowedTargetsEnforcer.toLowerCase()) {
      const [t] = decodeAbiParameters([{ type: 'address[]' }], c.terms) as [Address[]];
      return `Allowed targets: ${t.length}`;
    }
  } catch {
    /* fall through to the generic label */
  }
  return `Enforcer ${short(c.enforcer)}`;
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: '.6rem', padding: '.4rem 0', borderTop: '1px solid var(--c-g100, #eee)', fontSize: '.85rem' }}>
      <span style={{ color: 'var(--c-g500, #64748b)', minWidth: 130 }}>{label}</span>
      <span style={{ color: 'var(--c-g800, #1e293b)', wordBreak: 'break-word' }}>{children}</span>
    </div>
  );
}

function DelegationCard({ kind, d }: { kind: 'App access' | 'Membership' | 'Stewardship'; d: DelegationWire }) {
  return (
    <div className="manage-card">
      <div className="manage-card-head">
        <span className="manage-card-label">{kind}</span>
        <span className="manage-card-badge live">{d.authority === ROOT_AUTHORITY ? 'root' : 'sub'}</span>
      </div>
      <Fact label="Delegator"><AddressChip address={d.delegator} size="sm" withName /></Fact>
      <Fact label="Delegate"><AddressChip address={d.delegate} size="sm" withName /></Fact>
      <Fact label="Caveats">
        {d.caveats.length === 0 ? 'none' : (
          <ul style={{ margin: 0, paddingLeft: '1rem' }}>
            {d.caveats.map((c, i) => <li key={i}>{caveatLabel(c)}</li>)}
          </ul>
        )}
      </Fact>
      <Fact label="Salt"><code>{short(BigInt(d.salt).toString(16))}</code></Fact>
      <Fact label="Signature"><code>{short(d.signature)}</code></Fact>
    </div>
  );
}

/** Live read over a delegation: list the delegator's vault records, expand each to JSON. */
function VaultReader({ title, hint, delegation }: { title: string; hint: string; delegation: DelegationWire }) {
  const [records, setRecords] = useState<VaultRecordRef[] | null>(null);
  const [bodies, setBodies] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    setErr(null);
    vaultListWithDelegation(delegation)
      .then((r) => { if (!cancelled) setRecords(r); })
      .catch((e) => { if (!cancelled) setErr(e instanceof Error ? e.message : 'read failed'); })
      .finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [delegation]);

  async function show(rt: string) {
    if (bodies[rt]) return;
    try {
      const data = await vaultReadWithDelegation(delegation, rt);
      setBodies((b) => ({ ...b, [rt]: JSON.stringify(data, null, 2) }));
    } catch (e) {
      setBodies((b) => ({ ...b, [rt]: `(error: ${e instanceof Error ? e.message : 'read failed'})` }));
    }
  }

  return (
    <div className="dash-section" style={{ marginTop: '1.25rem' }}>
      <h3 style={{ fontSize: '.95rem', margin: '0 0 .2rem' }}>{title}</h3>
      <p style={{ fontSize: '.78rem', color: 'var(--c-g500, #64748b)', margin: '0 0 .6rem' }}>{hint}</p>
      {busy ? (
        <p className="manage-card-blurb">Reading over the delegation…</p>
      ) : err ? (
        <p className="manage-card-blurb" style={{ color: 'var(--c-danger, #dc2626)' }}>Couldn&rsquo;t read: {err}</p>
      ) : !records || records.length === 0 ? (
        <p className="manage-card-blurb">No records yet.</p>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, fontSize: '.82rem' }}>
          {records.map((r) => (
            <li key={r.record_type} style={{ borderTop: '1px solid var(--c-g100, #eee)', padding: '.4rem 0' }}>
              <code>{r.record_type}</code>
              <span style={{ color: 'var(--c-g500, #64748b)' }}> · updated {r.updated_at}</span>{' '}
              <button
                type="button"
                onClick={() => void show(r.record_type)}
                style={{ background: 'none', border: 'none', color: 'var(--c-accent, #2563eb)', cursor: 'pointer', padding: 0, fontSize: '.8rem' }}
              >
                show
              </button>
              {bodies[r.record_type] && (
                <pre style={{ background: 'var(--c-g50, #f8fafc)', padding: '.45rem .6rem', borderRadius: 6, overflowX: 'auto', fontSize: '.72rem', margin: '.3rem 0 0' }}>
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

const FIELDS: Array<{ key: keyof OrgProfile; label: string; ph: string; area?: boolean }> = [
  { key: 'displayName', label: 'Display name', ph: 'e.g. Grace Community Church' },
  { key: 'description', label: 'Description', ph: 'What this organization does', area: true },
  { key: 'website', label: 'Website', ph: 'https://…' },
  { key: 'contactEmail', label: 'Contact email', ph: 'hello@example.org' },
  { key: 'location', label: 'Location', ph: 'City, Country' },
];

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '.5rem .6rem', borderRadius: 8, border: '1px solid var(--c-g200, #e2e8f0)',
  fontSize: '.85rem', fontFamily: 'inherit', background: '#fff',
};

/** Manage the org's own details over the STEWARDSHIP delegation (write to the org's vault).
 *  Read on mount, edit the fields, Save → vaultWriteWithDelegation(stewardship, org:profile). */
function OrgProfileManager({ delegation }: { delegation: DelegationWire }) {
  const [p, setP] = useState<OrgProfile>({ v: 1 });
  const [busy, setBusy] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    setErr(null);
    vaultReadWithDelegation<OrgProfile>(delegation, RT_ORG_PROFILE)
      .then((r) => { if (!cancelled && r) setP({ ...r, v: 1 }); })
      .catch((e) => { if (!cancelled) setErr(e instanceof Error ? e.message : 'read failed'); })
      .finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [delegation]);

  async function save() {
    setSaving(true);
    setErr(null);
    setMsg(null);
    try {
      await vaultWriteWithDelegation(delegation, RT_ORG_PROFILE, p);
      setMsg('Saved to the organization’s vault ✓');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'save failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="dash-section" style={{ marginTop: '1.25rem' }}>
      <h3 style={{ fontSize: '.95rem', margin: '0 0 .2rem' }}>Manage organization details</h3>
      <p style={{ fontSize: '.78rem', color: 'var(--c-g500, #64748b)', margin: '0 0 .7rem' }}>
        You have <b>stewardship</b> of this org, so you can edit its details. Changes are written to the
        <b> organization’s own vault</b> over your stewardship delegation — never copied into your home.
      </p>
      {busy ? (
        <p className="manage-card-blurb">Loading the org’s details…</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '.6rem', maxWidth: 520 }}>
          {FIELDS.map((f) => (
            <label key={f.key} style={{ display: 'flex', flexDirection: 'column', gap: '.25rem', fontSize: '.8rem', color: 'var(--c-g600, #475569)' }}>
              {f.label}
              {f.area ? (
                <textarea
                  style={{ ...inputStyle, minHeight: 64, resize: 'vertical' }}
                  placeholder={f.ph}
                  value={p[f.key] ?? ''}
                  onChange={(e) => setP((s) => ({ ...s, [f.key]: e.target.value }))}
                />
              ) : (
                <input
                  style={inputStyle}
                  placeholder={f.ph}
                  value={p[f.key] ?? ''}
                  onChange={(e) => setP((s) => ({ ...s, [f.key]: e.target.value }))}
                />
              )}
            </label>
          ))}
          <div style={{ display: 'flex', gap: '.6rem', alignItems: 'center', marginTop: '.2rem' }}>
            <button type="button" className="btn-primary" style={{ fontSize: '.85rem', padding: '.45rem .9rem' }} onClick={() => void save()} disabled={saving}>
              {saving ? 'Saving…' : 'Save org details'}
            </button>
            {msg && <span style={{ fontSize: '.8rem', color: 'var(--c-success, #16a34a)' }}>{msg}</span>}
            {err && <span style={{ fontSize: '.8rem', color: 'var(--c-danger, #dc2626)' }}>{err}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

/** One member of the org — an agent that delegated to it (org→org broker grant). The
 *  delegation's delegator IS the member, so we read the member's vault over it. */
function MemberCard({ m }: { m: ReceivedDelegation }) {
  const d = m.delegation;
  const [open, setOpen] = useState(false);
  const [profile, setProfile] = useState<OrgProfile | null>(null);
  const [records, setRecords] = useState<VaultRecordRef[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    setOpen(true);
    if (!d || records) return;
    setBusy(true);
    setErr(null);
    try {
      const [p, recs] = await Promise.all([
        vaultReadWithDelegation<OrgProfile>(d, RT_ORG_PROFILE),
        vaultListWithDelegation(d),
      ]);
      setProfile(p);
      setRecords(recs);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'read failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="manage-card">
      <div className="manage-card-head">
        <span className="manage-card-label">{m.orgName || 'member'}</span>
        <span className="manage-card-badge live">Member</span>
      </div>
      <div style={{ margin: '.45rem 0' }}><AddressChip address={m.orgAgent} size="sm" withName /></div>
      {!d ? (
        <p className="manage-card-blurb">No readable delegation for this member.</p>
      ) : !open ? (
        <button type="button" className="btn-ghost" style={{ fontSize: '.8rem', padding: '.3rem .6rem' }} onClick={() => void load()}>
          View member details →
        </button>
      ) : busy ? (
        <p className="manage-card-blurb">Reading {m.orgName || 'member'}&rsquo;s vault…</p>
      ) : err ? (
        <p className="manage-card-blurb" style={{ color: 'var(--c-danger, #dc2626)' }}>Couldn&rsquo;t read: {err}</p>
      ) : (
        <div style={{ fontSize: '.8rem' }}>
          {profile && (profile.displayName || profile.description || profile.website || profile.contactEmail || profile.location) ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '.2rem', marginBottom: '.4rem' }}>
              {profile.displayName && <div><b>{profile.displayName}</b></div>}
              {profile.description && <div style={{ color: 'var(--c-g600, #475569)' }}>{profile.description}</div>}
              {profile.website && <div style={{ color: 'var(--c-g500, #64748b)' }}>{profile.website}</div>}
              {profile.contactEmail && <div style={{ color: 'var(--c-g500, #64748b)' }}>{profile.contactEmail}</div>}
              {profile.location && <div style={{ color: 'var(--c-g500, #64748b)' }}>{profile.location}</div>}
            </div>
          ) : (
            <p className="manage-card-blurb">No profile set yet.</p>
          )}
          <div style={{ color: 'var(--c-g500, #64748b)', fontSize: '.72rem' }}>
            {records && records.length > 0 ? `Records: ${records.map((r) => r.record_type).join(', ')}` : 'No vault records.'}
          </div>
        </div>
      )}
    </div>
  );
}

/** Members of the org = the agents that delegated TO it (the broker pool). Person-session
 *  authorized via /connect/received-delegations, filtered to this org. Each carries the
 *  member→org delegation, so we can read each member's details over it. */
function OrgMembers({ org, token }: { org: MyOrg; token: string | null }) {
  const [members, setMembers] = useState<ReceivedDelegation[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!token) { setLoaded(true); return; }
    let cancelled = false;
    listMyReceivedDelegations(token)
      .then((all) => {
        if (cancelled) return;
        setMembers(all.filter((r) => r.viaOrg.toLowerCase() === org.orgAgent.toLowerCase()));
        setLoaded(true);
      })
      .catch(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, [token, org.orgAgent]);

  return (
    <div className="dash-section" style={{ marginTop: '1.25rem' }}>
      <h3 style={{ fontSize: '.95rem', margin: '0 0 .2rem' }}>Members</h3>
      <p style={{ fontSize: '.78rem', color: 'var(--c-g500, #64748b)', margin: '0 0 .7rem' }}>
        Agents that delegated to <b>{org.orgName || 'this org'}</b> — its members. Each granted a scoped
        delegation, so you can read their details over it (their data stays in their own vault).
      </p>
      {!loaded ? (
        <p className="manage-card-blurb">Loading members…</p>
      ) : members.length === 0 ? (
        <p className="manage-card-blurb">No members yet — no agent has delegated to this organization.</p>
      ) : (
        <div className="manage-grid">
          {members.map((m, i) => <MemberCard key={`${m.orgAgent}-${i}`} m={m} />)}
        </div>
      )}
    </div>
  );
}

export function OrgDetail({ org, token, onBack }: { org: MyOrg; token: string | null; onBack: () => void }) {
  const created = org.createdAt ? new Date(org.createdAt).toLocaleString() : '—';
  return (
    <div>
      <button type="button" className="btn-ghost" style={{ marginBottom: '1rem', fontSize: '.85rem' }} onClick={onBack}>
        ← All organizations
      </button>

      {/* Identity */}
      <div className="dash-section">
        <h2><BuildingIcon size={16} /> {org.orgName || '(unnamed org)'}</h2>
        <Fact label="Name"><code>{org.orgName || '—'}</code></Fact>
        <Fact label="Address">
          <AddressChip address={org.orgAgent} size="sm" withName />{' '}
          <a href={EXPLORER + org.orgAgent} target="_blank" rel="noreferrer">explorer ↗</a>
        </Fact>
        <Fact label="Kind">{purposeLabel(org.purpose)}</Fact>
        <Fact label="Created for">{org.requestedBy || '—'}</Fact>
        <Fact label="Created">{created}</Fact>
        <Fact label="Custody">Your Impact credential (the org is custodied by you)</Fact>
        {org.proofHash && <Fact label="Link proof"><code>{short(org.proofHash)}</code></Fact>}
      </div>

      {/* Delegations */}
      <div className="dash-section" style={{ marginTop: '1.25rem' }}>
        <h3 style={{ fontSize: '.95rem', margin: '0 0 .6rem' }}><LinkIcon size={14} /> Delegations</h3>
        <div className="manage-grid">
          {org.delegation && <DelegationCard kind="App access" d={org.delegation} />}
          {org.membershipDelegation && <DelegationCard kind="Membership" d={org.membershipDelegation} />}
          {org.stewardshipDelegation && <DelegationCard kind="Stewardship" d={org.stewardshipDelegation} />}
        </div>
      </div>

      {/* Members — agents that delegated to this org (read each over their grant) */}
      <OrgMembers org={org} token={token} />

      {/* Stewardship — manage + read the org's own vault */}
      {org.stewardshipDelegation ? (
        <>
          <OrgProfileManager delegation={org.stewardshipDelegation} />
          <VaultReader
            title="All organization records"
            hint="Every record in the org's vault, read with your stewardship delegation (org → you). The org owns this data; you oversee it."
            delegation={org.stewardshipDelegation}
          />
        </>
      ) : (
        <div className="dash-section" style={{ marginTop: '1.25rem' }}>
          <h3 style={{ fontSize: '.95rem', margin: 0 }}>Organization data</h3>
          <p className="manage-card-blurb">No stewardship delegation on this org — can&rsquo;t read or manage its vault.</p>
        </div>
      )}

      {/* Membership read — what the org sees about you, via the OTHER delegation */}
      {org.membershipDelegation ? (
        <VaultReader
          title="Your member record (what this org can read about you)"
          hint="Read from YOUR vault using the membership delegation (you → org). This is exactly what the org is entitled to see about you as its member — it stays in your vault."
          delegation={org.membershipDelegation}
        />
      ) : (
        <div className="dash-section" style={{ marginTop: '1.25rem' }}>
          <h3 style={{ fontSize: '.95rem', margin: 0 }}>Your member record</h3>
          <p className="manage-card-blurb">No membership delegation on this org — nothing to read.</p>
        </div>
      )}
    </div>
  );
}
