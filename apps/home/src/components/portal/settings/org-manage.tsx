'use client';
// Org "Manage" sections (spec 315) — the former single scrolling Data page (OrgDetail), broken into
// the pieces that become left-nav items under Manage: Profile, Members, Records, Access. Each is a real
// route so the sidebar's exact-path active state works; each renders the relevant OrgDetail export over
// the person↔org delegations. One shared loader for the MyOrg record.
import { useEffect, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { useSession } from '../../../context/session';
import { SectionShell } from '../SectionShell';
import { OrgInvitePanel } from '../OrgInvitePanel';
import { OrgApplicationsPanel } from '../OrgApplicationsPanel';
import {
  DelegationCard,
  OrgMembers,
  OrgProfileManager,
  VaultReader,
} from '../OrgDetail';
import { BusyButton } from '../../shared/BusyButton';
import { notifyAgentsChanged } from '../ManagedAgents';
import { listMyOrgs, type MyOrg } from '../../../connect-client';
import {
  STATUS_LABEL,
  orgStatusOf,
  type OrgLifecycleRecordV1,
  type OrgLifecycleStatus,
} from '../../../lib/org-lifecycle';
import { readOrgLifecycle, projectOrgStatus, setOrgLifecycleStatus } from '../../../home/org-lifecycle';

/** Load the person's MyOrg record for one org SA (the delegation record the home holds).
 *  Reads with surface 'any' (spec 342): these pages are addressed BY the org's SA, so an inactive
 *  or deleted org must still resolve here — otherwise Settings, the one place that can reactivate
 *  it, would be the one place that can't see it. */
function useOrgRecord(orgSa: string): { record: MyOrg | null; loaded: boolean; token: string | null } {
  const { session } = useSession();
  const [record, setRecord] = useState<MyOrg | null>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (!session?.token) return;
    let cancelled = false;
    void listMyOrgs(session.token, 'any')
      .then((all) => {
        if (cancelled) return;
        setRecord(all.find((o) => o.orgAgent.toLowerCase() === orgSa.toLowerCase()) ?? null);
        setLoaded(true);
      })
      .catch(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, [session?.token, orgSa]);
  return { record, loaded, token: session?.token ?? null };
}

const NoRecord = ({ title }: { title: string }) => (
  <SectionShell title={title}>
    <p className="manage-card-blurb">No delegation record for this organization — nothing to show.</p>
  </SectionShell>
);
const NotSignedIn = ({ title }: { title: string }) => (
  <SectionShell title={title}><p>Not signed in.</p></SectionShell>
);
const Loading = ({ title }: { title: string }) => (
  <SectionShell title={title}><p className="manage-card-blurb">Loading…</p></SectionShell>
);

// ── Profile — the org's editable details (over the stewardship delegation) ────────────────────────
export function OrgProfileSection({ orgSa }: { orgSa: string }) {
  const { session } = useSession();
  const { record, loaded } = useOrgRecord(orgSa);
  if (!session) return <NotSignedIn title="Profile" />;
  if (!loaded) return <Loading title="Profile" />;
  if (!record) return <NoRecord title="Profile" />;
  return (
    <SectionShell title="Profile">
      {record.stewardshipDelegation
        ? <OrgProfileManager delegation={record.stewardshipDelegation} />
        : <p className="manage-card-blurb">No stewardship delegation on this org — its details can&rsquo;t be edited from here.</p>}
    </SectionShell>
  );
}

// ── Members — agents that delegated to the org ────────────────────────────────────────────────────
export function OrgMembersSection({ orgSa }: { orgSa: string }) {
  const { session } = useSession();
  const { record, loaded, token } = useOrgRecord(orgSa);
  if (!session) return <NotSignedIn title="Membership" />;
  if (!loaded) return <Loading title="Membership" />;
  if (!record) return <NoRecord title="Membership" />;
  return (
    <SectionShell title="Membership" description="Who belongs, who has asked to, and who you invite. Membership is the relationship; a member's access grant is evidence of it, never the membership itself.">
      <OrgMembers org={record} token={token} />
      {/* spec 324 §7/§12 — ONE enrollment surface: pending join requests (steward decides) + Invite live with
          the roster (the standalone /invite page 308-redirects here; the topbar "Invite member" points here). */}
      <OrgApplicationsPanel org={orgSa} />
      <OrgInvitePanel org={orgSa} />
    </SectionShell>
  );
}

// ── Records — the org's vault data (stewardship) + your member record (membership) ────────────────
export function OrgRecordsSection({ orgSa }: { orgSa: string }) {
  const { session } = useSession();
  const { record, loaded } = useOrgRecord(orgSa);
  if (!session) return <NotSignedIn title="Records" />;
  if (!loaded) return <Loading title="Records" />;
  if (!record) return <NoRecord title="Records" />;
  return (
    <SectionShell title="Records">
      {record.stewardshipDelegation
        ? <VaultReader
            title="Organization records"
            hint="Every record in the org's vault, read with your stewardship delegation (org → you). The org owns this data; you oversee it."
            delegation={record.stewardshipDelegation}
          />
        : <p className="manage-card-blurb">No stewardship delegation — can&rsquo;t read the org&rsquo;s vault.</p>}
      {record.membershipDelegation && (
        <VaultReader
          title="Your member record (what this org can read about you)"
          hint="Read from YOUR vault using the membership delegation (you → org) — exactly what the org is entitled to see about you. It stays in your vault."
          delegation={record.membershipDelegation}
        />
      )}
    </SectionShell>
  );
}

// ── Settings — the org's lifecycle: activate / deactivate / delete (spec 342) ─────────────────────

const BADGE_TONE: Record<OrgLifecycleStatus, { bg: string; fg: string }> = {
  active: { bg: 'var(--color-emerald-50, #ecfdf5)', fg: 'var(--color-emerald-800, #065f46)' },
  inactive: { bg: 'var(--color-amber-50, #fffbeb)', fg: 'var(--color-amber-800, #92400e)' },
  deleted: { bg: 'var(--c-g100, #f1f5f9)', fg: 'var(--c-g600, #475569)' },
};

function StatusBadge({ status }: { status: OrgLifecycleStatus }) {
  const t = BADGE_TONE[status];
  return (
    <span style={{
      background: t.bg, color: t.fg, borderRadius: 999, padding: '.15rem .55rem',
      fontSize: '.72rem', fontWeight: 650, letterSpacing: '.02em',
    }}>
      {STATUS_LABEL[status]}
    </span>
  );
}

export function OrgSettingsSection({ orgSa }: { orgSa: string }) {
  const { session, agentAddress } = useSession();
  const { record, loaded, token } = useOrgRecord(orgSa);
  const stewardship = record?.stewardshipDelegation;

  const [lifecycle, setLifecycle] = useState<OrgLifecycleRecordV1 | null>(null);
  const [reading, setReading] = useState(true);
  const [busy, setBusy] = useState<OrgLifecycleStatus | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [typed, setTyped] = useState('');
  const [reason, setReason] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Read the AUTHORITATIVE record (the org's vault), then reconcile the projection from it when the
  // two disagree — a projection catching up with its source, not a second mechanism (ADR-0013).
  useEffect(() => {
    if (!stewardship || !token || !agentAddress) { setReading(false); return; }
    let cancelled = false;
    setReading(true);
    void readOrgLifecycle(stewardship)
      .then(async (r) => {
        if (cancelled) return;
        setLifecycle(r);
        const authoritative = orgStatusOf(r);
        if (authoritative !== orgStatusOf(record)) {
          await projectOrgStatus({ person: agentAddress as Address, org: orgSa as Address, token, status: authoritative });
          notifyAgentsChanged();
        }
      })
      .catch((e) => { if (!cancelled) setErr(e instanceof Error ? e.message : 'could not read the organization’s status'); })
      .finally(() => { if (!cancelled) setReading(false); });
    return () => { cancelled = true; };
    // `record` is intentionally not a dependency: it is the projection being reconciled, and
    // re-running on its change would loop the reconcile against itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stewardship, token, agentAddress, orgSa]);

  if (!session) return <NotSignedIn title="Settings" />;
  if (!loaded || reading) return <Loading title="Settings" />;
  if (!record) return <NoRecord title="Settings" />;

  const status = lifecycle ? orgStatusOf(lifecycle) : orgStatusOf(record);
  const orgLabel = record.orgName || orgSa;

  async function change(next: OrgLifecycleStatus) {
    if (!stewardship || !token || !agentAddress) return;
    setBusy(next);
    setErr(null);
    setMsg(null);
    const r = await setOrgLifecycleStatus({
      person: agentAddress as Address,
      org: orgSa as Address,
      token,
      stewardship,
      status: next,
      reason,
    });
    setBusy(null);
    if (!r.ok) { setErr(r.error); return; }
    setLifecycle(r.record);
    setConfirmDelete(false);
    setTyped('');
    notifyAgentsChanged();
    setMsg(
      r.projected
        ? next === 'active' ? 'Organization activated ✓'
          : next === 'inactive' ? 'Organization deactivated — it stays on your organizations list so you can activate it again.'
          : 'Organization deleted — its records are kept in its vault; your home stops showing it.'
        : `Saved to the organization’s vault ✓ — but your home’s list didn’t update. Reload to re-read it.`,
    );
  }

  return (
    <SectionShell title="Settings">
      <div className="dash-section" style={{ marginTop: '1.25rem' }}>
        <h3 className="subhead" style={{ display: 'flex', alignItems: 'center', gap: '.5rem' }}>
          Organization status <StatusBadge status={status} />
        </h3>
        <p className="manage-card-blurb" style={{ margin: '0 0 .7rem', maxWidth: 620 }}>
          Whether this organization appears in your home. The decision is written to the{' '}
          <b>organization&rsquo;s own vault</b> (<code>org.lifecycle</code>) over your stewardship delegation —
          only a steward can set it.
        </p>
        <p className="manage-card-blurb" style={{ margin: '0 0 .9rem', maxWidth: 620 }}>
          <b>What this does not do:</b> it revokes no delegation, disables no agent, and deletes no data.
          Deleting marks the organization as retired — every record in its vault is kept, and its address
          stays what it always was. To withdraw authority, revoke the delegations under <b>Access</b>.
        </p>

        {!stewardship ? (
          <p className="manage-card-blurb" style={{ color: 'var(--c-danger, #dc2626)' }}>
            You hold no stewardship delegation on this organization, so you can&rsquo;t change its status.
            Members can belong to an organization without overseeing it.
          </p>
        ) : (
          <>
            {lifecycle?.changedAt && (
              <p className="manage-card-blurb" style={{ margin: '0 0 .7rem', fontSize: '.78rem' }}>
                Set {new Date(lifecycle.changedAt).toLocaleString()}
                {lifecycle.changedBy ? ` by ${lifecycle.changedBy.slice(0, 8)}…${lifecycle.changedBy.slice(-4)}` : ''}
                {lifecycle.reason ? ` — “${lifecycle.reason}”` : ''}
              </p>
            )}
            <label style={{ display: 'flex', flexDirection: 'column', gap: '.25rem', fontSize: '.8rem', color: 'var(--c-g600, #475569)', maxWidth: 520, marginBottom: '.7rem' }}>
              Reason (optional — kept with the record)
              <input
                style={{ width: '100%', padding: '.5rem .6rem', borderRadius: 8, border: '1px solid var(--c-g200, #e2e8f0)', fontSize: '.85rem', fontFamily: 'inherit', background: '#fff' }}
                placeholder="e.g. project wrapped up in July"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </label>

            <div style={{ display: 'flex', gap: '.6rem', flexWrap: 'wrap', alignItems: 'center' }}>
              {status !== 'active' && (
                <BusyButton
                  busy={busy === 'active'}
                  busyLabel="Activating…"
                  className="btn-primary"
                  style={{ fontSize: '.85rem', padding: '.45rem .9rem' }}
                  onClick={() => void change('active')}
                >
                  {status === 'deleted' ? 'Restore organization' : 'Activate organization'}
                </BusyButton>
              )}
              {status === 'active' && (
                <BusyButton
                  busy={busy === 'inactive'}
                  busyLabel="Deactivating…"
                  className="btn-ghost"
                  style={{ fontSize: '.85rem', padding: '.45rem .9rem' }}
                  onClick={() => void change('inactive')}
                >
                  Deactivate organization
                </BusyButton>
              )}
              {status !== 'deleted' && !confirmDelete && (
                <button
                  type="button"
                  className="btn-ghost"
                  style={{ fontSize: '.85rem', padding: '.45rem .9rem', color: 'var(--c-danger, #dc2626)' }}
                  onClick={() => setConfirmDelete(true)}
                >
                  Delete organization
                </button>
              )}
            </div>

            {confirmDelete && status !== 'deleted' && (
              <div style={{ marginTop: '.9rem', padding: '.75rem .85rem', borderRadius: 10, border: '1px solid var(--c-danger, #dc2626)', maxWidth: 560 }}>
                <p className="manage-card-blurb" style={{ margin: '0 0 .5rem' }}>
                  Type <b>{orgLabel}</b> to confirm. The organization disappears from your home; its vault
                  records, its address and every delegation stay exactly as they are.
                </p>
                <input
                  style={{ width: '100%', padding: '.5rem .6rem', borderRadius: 8, border: '1px solid var(--c-g200, #e2e8f0)', fontSize: '.85rem', fontFamily: 'inherit', background: '#fff' }}
                  placeholder={orgLabel}
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                />
                <div style={{ display: 'flex', gap: '.5rem', marginTop: '.6rem' }}>
                  <BusyButton
                    busy={busy === 'deleted'}
                    busyLabel="Deleting…"
                    className="btn-primary"
                    style={{ fontSize: '.85rem', padding: '.4rem .85rem', background: 'var(--c-danger, #dc2626)' }}
                    disabled={typed.trim() !== orgLabel}
                    onClick={() => void change('deleted')}
                  >
                    Delete organization
                  </BusyButton>
                  <button
                    type="button"
                    className="btn-ghost"
                    style={{ fontSize: '.85rem', padding: '.4rem .85rem' }}
                    onClick={() => { setConfirmDelete(false); setTyped(''); }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            <div style={{ marginTop: '.7rem', fontSize: '.8rem' }}>
              {msg && <span style={{ color: 'var(--c-success, #16a34a)' }}>{msg}</span>}
              {err && <span style={{ color: 'var(--c-danger, #dc2626)' }}>{err}</span>}
            </div>
          </>
        )}
      </div>
    </SectionShell>
  );
}

// ── Access — the person↔org delegations that make everything above possible ───────────────────────
export function OrgAccessSection({ orgSa }: { orgSa: string }) {
  const { session } = useSession();
  const { record, loaded } = useOrgRecord(orgSa);
  if (!session) return <NotSignedIn title="Access" />;
  if (!loaded) return <Loading title="Access" />;
  if (!record) return <NoRecord title="Access" />;
  const any = record.delegation || record.membershipDelegation || record.stewardshipDelegation;
  return (
    <SectionShell title="Access">
      <p className="manage-card-blurb" style={{ margin: '0 0 .8rem' }}>
        The scoped, revocable delegations between you and this organization — the authority behind every read above.
      </p>
      {any ? (
        <div className="manage-grid">
          {record.delegation && <DelegationCard kind="App access" d={record.delegation} />}
          {record.membershipDelegation && <DelegationCard kind="Membership" d={record.membershipDelegation} />}
          {record.stewardshipDelegation && <DelegationCard kind="Stewardship" d={record.stewardshipDelegation} />}
        </div>
      ) : (
        <p className="manage-card-blurb">No delegations recorded for this organization.</p>
      )}
    </SectionShell>
  );
}
