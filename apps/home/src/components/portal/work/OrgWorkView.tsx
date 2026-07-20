'use client';
// Org Work — Endeavor list / board (spec 334 §6). Deterministic projections
// over the org's endeavor.list rows: a simple list and a lifecycle-column
// board over the SAME rows. Members see open endeavors; stewards additionally
// see triage (Requests) and decline/allocation actions — gating comes from the
// serving plane's response, re-verified server-side (never nav-only).
import { useCallback, useMemo, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { ENDEAVOR_LIFECYCLES, type EndeavorLifecycle } from '@agenticprimitives/home';
import { useSession } from '../../../context/session';
import { SectionShell } from '../SectionShell';
import { BusyButton } from '../../shared/BusyButton';
import { projectEndeavorSummary, type EndeavorRow } from '../../../lib/work-client';
import { useReEnableInteractions, useWorkList } from './useWork';

const LIFECYCLE_LABEL: Record<EndeavorLifecycle, string> = {
  proposed: 'Proposed',
  adopted: 'Adopted',
  active: 'Active',
  suspended: 'Suspended',
  satisfied: 'Satisfied',
  abandoned: 'Abandoned',
};

function EndeavorCard({ org, row }: { org: string; row: EndeavorRow }) {
  const s = projectEndeavorSummary(org, row);
  return (
    <a
      href={`/org/${org}/work/${encodeURIComponent(row.endeavorId)}`}
      className="manage-card"
      style={{ display: 'block', padding: '0.7rem 0.9rem', textDecoration: 'none', color: 'inherit' }}
    >
      <div style={{ fontWeight: 600, fontSize: '0.88rem' }}>{s.title}</div>
      <div style={{ fontSize: '0.75rem', opacity: 0.7, marginTop: '0.2rem' }}>
        {LIFECYCLE_LABEL[s.lifecycle]}
        {s.stepsTotal > 0 && ` · ${s.stepsSatisfied}/${s.stepsTotal} plan steps satisfied`}
        {s.deadline && ` · due ${new Date(s.deadline).toLocaleDateString()}`}
      </div>
    </a>
  );
}

export function OrgWorkView({ org }: { org: Address }) {
  const { session } = useSession();
  const communityId = org.toLowerCase();
  const { data, member, steward, error, needsReEnable, refresh } = useWorkList(session, communityId);
  const [view, setView] = useState<'list' | 'board'>('list');
  const reEnable = useReEnableInteractions();
  const [reEnabling, setReEnabling] = useState(false);
  const [reEnableError, setReEnableError] = useState<string | null>(null);

  const runReEnable = useCallback(async () => {
    setReEnabling(true); setReEnableError(null);
    const r = await reEnable(communityId as Address);
    if (!r.ok) setReEnableError(r.error ?? 'could not re-enable storage');
    else await refresh();
    setReEnabling(false);
  }, [reEnable, communityId, refresh]);

  const endeavors = useMemo(() => data?.endeavors ?? [], [data]);
  const pendingRequests = useMemo(
    () => (data?.requests ?? []).filter((r) => (r.status ?? 'pending') === 'pending').length,
    [data],
  );

  if (!session) return <SectionShell title="Work"><p>Not signed in.</p></SectionShell>;

  if (member === false) {
    return (
      <SectionShell title="Work">
        <p style={{ fontSize: '0.85rem', opacity: 0.75 }}>
          Work is visible to members of this organization. Request membership from{' '}
          <a href={`/org/${communityId}/discussions`}>Discussions</a>.
        </p>
      </SectionShell>
    );
  }

  return (
    <SectionShell
      title="Work"
      actions={
        <span style={{ display: 'inline-flex', gap: '0.4rem', alignItems: 'center' }}>
          {steward && (
            <a href={`/org/${communityId}/work/requests`} className="ghost" style={{ textDecoration: 'none', fontSize: '0.8rem' }}>
              Requests{pendingRequests > 0 ? ` · ${pendingRequests}` : ''}
            </a>
          )}
          <a href={`/org/${communityId}/work/new`} className="btn-primary" style={{ width: 'auto', textDecoration: 'none', fontSize: '0.8rem', padding: '0.35rem 0.8rem' }}>
            New request
          </a>
        </span>
      }
    >
      {needsReEnable ? (
        <div className="manage-card" style={{ padding: '0.8rem 1rem', marginBottom: '0.9rem', border: '1px solid var(--color-amber-400)', background: 'var(--color-amber-50)' }}>
          <p style={{ fontSize: '0.83rem', margin: '0 0 0.5rem' }}>
            Storage was upgraded for coordination — the organization&rsquo;s grant must be re-signed before Work can load.
          </p>
          {steward ? (
            <BusyButton busy={reEnabling} busyLabel="Re-enabling…" className="btn-primary" style={{ width: 'auto' }} onClick={() => void runReEnable()}>
              Re-enable storage
            </BusyButton>
          ) : (
            <p style={{ fontSize: '0.78rem', opacity: 0.75, margin: 0 }}>Ask an organization steward to open this page and re-enable storage.</p>
          )}
          {reEnableError && <p style={{ color: 'var(--color-danger)', fontSize: '0.78rem', margin: '0.4rem 0 0' }}>{reEnableError}</p>}
        </div>
      ) : error ? (
        <p style={{ color: 'var(--color-danger)', fontSize: '0.8rem' }}>{error}</p>
      ) : null}

      <div style={{ display: 'flex', gap: '0.4rem', marginBottom: '0.8rem' }}>
        <button type="button" className={view === 'list' ? 'btn' : 'ghost'} onClick={() => setView('list')}>List</button>
        <button type="button" className={view === 'board' ? 'btn' : 'ghost'} onClick={() => setView('board')}>Board</button>
      </div>

      {data === null ? (
        <p style={{ opacity: 0.6, fontSize: '0.85rem' }}>Loading…</p>
      ) : endeavors.length === 0 ? (
        <p style={{ opacity: 0.7, fontSize: '0.85rem' }}>
          No endeavors yet. A request becomes an endeavor when a steward adopts it —
          start with <a href={`/org/${communityId}/work/new`}>New request</a>.
        </p>
      ) : view === 'list' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {endeavors.map((e) => <EndeavorCard key={e.endeavorId} org={communityId} row={e} />)}
        </div>
      ) : (
        <div style={{ display: 'flex', gap: '0.6rem', overflowX: 'auto', alignItems: 'flex-start' }}>
          {ENDEAVOR_LIFECYCLES.map((lc) => {
            const rows = endeavors.filter((e) => e.lifecycle === lc);
            if (rows.length === 0 && (lc === 'suspended' || lc === 'abandoned')) return null;
            return (
              <div key={lc} style={{ minWidth: 220, flex: '0 0 220px' }}>
                <div style={{ fontSize: '0.75rem', fontWeight: 700, opacity: 0.7, margin: '0 0 0.4rem 0.15rem' }}>
                  {LIFECYCLE_LABEL[lc]} · {rows.length}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                  {rows.map((e) => <EndeavorCard key={e.endeavorId} org={communityId} row={e} />)}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </SectionShell>
  );
}
