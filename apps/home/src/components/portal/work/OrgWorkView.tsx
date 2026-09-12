'use client';
// Org Work — Endeavor list / board / requests (spec 334 §6) behind ONE
// segmented control (no dead-end route links). Deterministic projections over
// the org's endeavor.list rows; gating comes from the serving plane's
// response, re-verified server-side (never nav-only).
import { useCallback, useMemo, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { ENDEAVOR_LIFECYCLES, type EndeavorLifecycle } from '@agenticprimitives/home';
import { useSession } from '../../../context/session';
import { SectionShell } from '../SectionShell';
import { BusyButton } from '../../shared/BusyButton';
import { Loading } from '../../shared/Loading';
import { type EndeavorRow } from '../../../lib/work-client';
import { workItemRow } from '../../../home/work-item';
import { AgentName } from '../../shared/AgentName';
import { useOrgMemberNames, useReEnableInteractions, useWorkList } from './useWork';
import { RequestsTriage } from './RequestsTriage';
import { LIFECYCLE_LABEL, lifecycleState } from './labels';
import { StatePill } from '../StatePill';

function Progress({ done, total }: { done: number; total: number }) {
  if (total === 0) return null;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.72rem', color: 'var(--color-text-muted)' }}>
      <span style={{ width: 64, height: 5, borderRadius: 999, background: 'var(--color-surface-sunken, #eee)', overflow: 'hidden', display: 'inline-block' }}>
        <span style={{ display: 'block', height: '100%', width: `${Math.round((done / total) * 100)}%`, background: 'var(--color-sage-500, #5f9b76)' }} />
      </span>
      {done}/{total}
    </span>
  );
}

function EndeavorCard({ org, row, compact }: { org: string; row: EndeavorRow; compact?: boolean }) {
  return (
    <a
      href={`/org/${org}/work/${encodeURIComponent(row.endeavorId)}`}
      className="manage-card"
      style={{ display: 'block', padding: compact ? '0.6rem 0.75rem' : '0.75rem 0.95rem', textDecoration: 'none', color: 'inherit' }}
    >
      <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <span style={{ fontWeight: 600, fontSize: '0.87rem', lineHeight: 1.35 }}>{row.title}</span>
        {!compact && <StatePill state={lifecycleState(row.lifecycle)} native={LIFECYCLE_LABEL[row.lifecycle]} />}
      </div>
      <div style={{ display: 'flex', gap: '0.7rem', alignItems: 'center', marginTop: '0.35rem', flexWrap: 'wrap' }}>
        <Progress done={row.stepsSatisfied ?? 0} total={row.stepsTotal ?? 0} />
        {(row.stepsTotal ?? 0) === 0 && row.lifecycle === 'adopted' && (
          <span style={{ fontSize: '0.72rem', color: 'var(--color-amber-700, #b45309)' }}>needs a plan</span>
        )}
        {row.deadline && <span style={{ fontSize: '0.72rem', color: 'var(--color-text-muted)' }}>due {new Date(row.deadline).toLocaleDateString()}</span>}
        {row.updatedAt && <span style={{ fontSize: '0.7rem', color: 'var(--color-text-faint)' }}>updated {new Date(row.updatedAt).toLocaleDateString()}</span>}
      </div>
      {/* 398 §4.3 — the same item contract on the row: owner here; executors · artifacts · acceptance · cost are the item's, said so. */}
      {!compact && (() => { const it = workItemRow(org, row); return (
        <div style={{ fontSize: '0.68rem', color: 'var(--color-text-faint)', marginTop: '0.3rem' }} data-testid="work-item-row">
          owner <AgentName address={it.owner.agent} /> · {it.onItem.join(' · ')}: on the item →
        </div>
      ); })()}
    </a>
  );
}

type Tab = 'list' | 'board' | 'requests';

export function OrgWorkView({ org }: { org: Address }) {
  const { session } = useSession();
  const communityId = org.toLowerCase();
  const { data, member, steward, error, needsReEnable, refresh } = useWorkList(session, communityId);
  const names = useOrgMemberNames(session, communityId);
  const [tab, setTab] = useState<Tab>('list');
  const [showClosed, setShowClosed] = useState(false);
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

  const endeavors = useMemo(() => {
    const rows = [...(data?.endeavors ?? [])];
    rows.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
    return rows;
  }, [data]);
  const openRows = endeavors.filter((e) => e.lifecycle !== 'satisfied' && e.lifecycle !== 'abandoned');
  const closedRows = endeavors.filter((e) => e.lifecycle === 'satisfied' || e.lifecycle === 'abandoned');
  const requests = useMemo(() => data?.requests ?? [], [data]);
  const pendingRequests = requests.filter((r) => (r.status ?? 'pending') === 'pending').length;

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

  const segStyle = (active: boolean): React.CSSProperties => ({
    padding: '0.32rem 0.85rem',
    fontSize: '0.8rem',
    fontWeight: active ? 600 : 500,
    border: '1px solid var(--color-border)',
    background: active ? 'var(--color-surface, #fff)' : 'transparent',
    color: active ? 'var(--color-text-primary)' : 'var(--color-text-muted)',
    cursor: 'pointer',
    boxShadow: active ? 'var(--shadow-card, 0 1px 2px rgba(0,0,0,0.06))' : 'none',
  });

  return (
    <SectionShell
      title="Work"
      actions={
        <a href={`/org/${communityId}/work/new`} className="btn-primary" style={{ width: 'auto', textDecoration: 'none', fontSize: '0.8rem', padding: '0.35rem 0.8rem' }}>
          New request
        </a>
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

      {/* Segmented control — Requests is a first-class tab, not a route link */}
      <div style={{ display: 'inline-flex', marginBottom: '0.9rem', borderRadius: 8, overflow: 'hidden', border: '1px solid var(--color-border)' }}>
        <button type="button" style={{ ...segStyle(tab === 'list'), border: 'none', borderRight: '1px solid var(--color-border)' }} onClick={() => setTab('list')}>List</button>
        <button type="button" style={{ ...segStyle(tab === 'board'), border: 'none', borderRight: '1px solid var(--color-border)' }} onClick={() => setTab('board')}>Board</button>
        <button type="button" style={{ ...segStyle(tab === 'requests'), border: 'none' }} onClick={() => setTab('requests')}>
          Requests{pendingRequests > 0 ? (
            <span style={{ marginLeft: '0.35rem', background: 'var(--color-amber-400, #fbbf24)', color: '#4a3200', borderRadius: 999, padding: '0 0.4rem', fontSize: '0.68rem', fontWeight: 700 }}>{pendingRequests}</span>
          ) : ''}
        </button>
      </div>

      {data === null ? (
        <Loading label="Loading requests and endeavors…" />
      ) : tab === 'requests' ? (
        <RequestsTriage org={communityId} requests={requests} steward={steward} names={names} refresh={refresh} />
      ) : endeavors.length === 0 ? (
        <div className="manage-card" style={{ padding: '1.1rem 1.2rem', textAlign: 'center' }}>
          <p style={{ fontSize: '0.87rem', margin: '0 0 0.35rem', fontWeight: 600 }}>No endeavors yet</p>
          <p style={{ fontSize: '0.8rem', opacity: 0.7, margin: 0 }}>
            A request becomes an endeavor when a steward accepts it — start with{' '}
            <a href={`/org/${communityId}/work/new`}>New request</a>.
          </p>
        </div>
      ) : tab === 'list' ? (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {openRows.map((e) => <EndeavorCard key={e.endeavorId} org={communityId} row={e} />)}
            {openRows.length === 0 && <p style={{ fontSize: '0.82rem', opacity: 0.7 }}>Nothing in flight — everything is completed or closed.</p>}
          </div>
          {closedRows.length > 0 && (
            <div style={{ marginTop: '0.9rem' }}>
              <button type="button" className="ghost" style={{ fontSize: '0.78rem' }} onClick={() => setShowClosed((v) => !v)}>
                {showClosed ? 'Hide' : 'Show'} completed &amp; closed ({closedRows.length})
              </button>
              {showClosed && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '0.5rem' }}>
                  {closedRows.map((e) => <EndeavorCard key={e.endeavorId} org={communityId} row={e} />)}
                </div>
              )}
            </div>
          )}
        </>
      ) : (
        <div style={{ display: 'flex', gap: '0.6rem', overflowX: 'auto', alignItems: 'flex-start', paddingBottom: '0.4rem' }}>
          {ENDEAVOR_LIFECYCLES.map((lc: EndeavorLifecycle) => {
            const rows = endeavors.filter((e) => e.lifecycle === lc);
            if (rows.length === 0 && (lc === 'suspended' || lc === 'abandoned' || lc === 'proposed')) return null;
            return (
              <div key={lc} style={{ minWidth: 230, flex: '0 0 230px', background: 'var(--color-surface-sunken, #f6f6f4)', borderRadius: 10, padding: '0.55rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', margin: '0 0 0.5rem 0.15rem' }}>
                  <StatePill state={lifecycleState(lc)} native={LIFECYCLE_LABEL[lc]} />
                  <span style={{ fontSize: '0.72rem', color: 'var(--color-text-muted)' }}>{rows.length}</span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                  {rows.map((e) => <EndeavorCard key={e.endeavorId} org={communityId} row={e} compact />)}
                  {rows.length === 0 && <div style={{ fontSize: '0.74rem', color: 'var(--color-text-faint)', padding: '0.4rem 0.2rem' }}>Empty</div>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </SectionShell>
  );
}
