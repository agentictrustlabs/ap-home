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
import { List, Row, Card, Empty, ErrorNote, Meta, Toolbar, Tabs, Button, LinkButton, Panel, Stats, Stat, SearchInput, useReadyReport, type PanelState } from '../../../ui';
import { ActivityIcon, CheckIcon, InboxIcon } from '../today-icons';
import { BusyButton } from '../../shared/BusyButton';
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

function EndeavorRow({ org, row }: { org: string; row: EndeavorRow }) {
  const it = workItemRow(org, row);
  return (
    <Row
      href={`/org/${org}/work/${encodeURIComponent(row.endeavorId)}`}
      title={row.title}
      meta={<>
        {it.progress ? `${it.progress.satisfied}/${it.progress.total} steps` : 'no plan yet'}
        {(row.stepsTotal ?? 0) === 0 && row.lifecycle === 'adopted' && <span style={{ color: 'var(--color-amber-700)' }}> · needs a plan</span>}
        {row.deadline && ` · due ${new Date(row.deadline).toLocaleDateString()}`}
        {row.updatedAt && ` · updated ${new Date(row.updatedAt).toLocaleDateString()}`}
        {/* 398 §4.3 — the same item contract on the row: the owner here; executors · artifacts · acceptance · cost are read on the item. */}
        <span data-testid="work-item-row" title={`${it.onItem.join(' · ')}: on the item`}> · owner <AgentName address={it.owner.agent} /></span>
      </>}
      side={<><StatePill state={lifecycleState(row.lifecycle)} native={LIFECYCLE_LABEL[row.lifecycle]} /><Progress done={row.stepsSatisfied ?? 0} total={row.stepsTotal ?? 0} /></>}
    />
  );
}

function EndeavorCard({ org, row }: { org: string; row: EndeavorRow }) {
  return (
    <Card href={`/org/${org}/work/${encodeURIComponent(row.endeavorId)}`} style={{ padding: 'var(--sp-3)' }}>
      <div className="ui-row-title" style={{ fontSize: 'var(--fs-sm)' }}>{row.title}</div>
      <div style={{ display: 'flex', gap: 'var(--sp-2)', alignItems: 'center', marginTop: 6, flexWrap: 'wrap' }}>
        <Progress done={row.stepsSatisfied ?? 0} total={row.stepsTotal ?? 0} />
        {row.deadline && <span className="ui-micro">due {new Date(row.deadline).toLocaleDateString()}</span>}
      </div>
    </Card>
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
  const [q, setQ] = useState('');
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

  const needle = q.trim().toLowerCase();
  const shownOpen = needle ? openRows.filter((e) => `${e.title ?? ''} ${e.endeavorId}`.toLowerCase().includes(needle)) : openRows;
  const shownClosed = needle ? closedRows.filter((e) => `${e.title ?? ''} ${e.endeavorId}`.toLowerCase().includes(needle)) : closedRows;
  useReadyReport('org-work', data === null);

  if (!session) return <SectionShell title="Work"><Empty>Not signed in.</Empty></SectionShell>;

  if (member === false) {
    return (
      <SectionShell title="Work">
        <Empty title="Members only">Work is visible to members of this organization. Request membership from <a href={`/org/${communityId}/discussions`}>Discussions</a>.</Empty>
      </SectionShell>
    );
  }

  return (
    <SectionShell
      title="Work"
      description="The organization's endeavors — what was asked, what was adopted, and where each stands."
      actions={<LinkButton variant="primary" href={`/org/${communityId}/work/new`}>New request</LinkButton>}
    >
      {needsReEnable ? (
        <Card quiet>
          <p className="ui-meta" style={{ margin: '0 0 var(--sp-2)', color: 'var(--color-text-body)' }}>Storage was upgraded for coordination — the organization&rsquo;s grant must be re-signed before Work can load.</p>
          {steward ? (
            <BusyButton busy={reEnabling} busyLabel="Re-enabling…" className="ui-btn ui-btn--primary ui-btn--sm" onClick={() => void runReEnable()}>Re-enable storage</BusyButton>
          ) : (
            <Meta>Ask an organization steward to open this page and re-enable storage.</Meta>
          )}
          {reEnableError && <ErrorNote>{reEnableError}</ErrorNote>}
        </Card>
      ) : error ? (
        <ErrorNote>{error}</ErrorNote>
      ) : null}

      <Stats>
        <Stat label="Pending requests" value={pendingRequests} loading={data === null} tone={pendingRequests ? 'warn' : undefined} hint="waiting for a steward's decision" />
        <Stat label="In flight" value={openRows.length} loading={data === null} hint="endeavors adopted and moving" />
        <Stat label="Completed & closed" value={closedRows.length} loading={data === null} tone="ok" hint="satisfied or closed" />
      </Stats>
      <Toolbar>
        <Tabs value={tab} onChange={setTab} label="Work views" items={[{ id: 'list', label: 'List' }, { id: 'board', label: 'Board' }, { id: 'requests', label: 'Requests', ...(pendingRequests > 0 ? { count: pendingRequests } : {}) }]} />
        {tab !== 'requests' && <SearchInput placeholder="Search endeavors…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search endeavors" />}
      </Toolbar>

      {tab === 'requests' ? (
        data === null ? <Panel title="Requests" icon={<InboxIcon />} state="loading" rows={3} /> : <RequestsTriage org={communityId} requests={requests} steward={steward} names={names} refresh={refresh} />
      ) : tab === 'list' ? (
        <>
          <Panel title="In flight" icon={<ActivityIcon />} count={shownOpen.length} state={(data === null ? 'loading' : shownOpen.length ? 'ready' : 'empty') as PanelState} rows={4}
            empty={{ icon: <ActivityIcon />, title: q ? 'No endeavor matches' : endeavors.length ? 'Nothing in flight' : 'No endeavors yet', hint: q ? `Nothing in flight mentions “${q}”.` : endeavors.length ? 'Everything is completed or closed.' : 'A request becomes an endeavor when a steward accepts it.', action: !q && !endeavors.length ? <LinkButton size="sm" variant="secondary" href={`/org/${communityId}/work/new`}>New request</LinkButton> : undefined }}>
            <List>{shownOpen.map((e) => <EndeavorRow key={e.endeavorId} org={communityId} row={e} />)}</List>
          </Panel>
          {closedRows.length > 0 && (
            <Panel title="Completed & closed" icon={<CheckIcon />} count={shownClosed.length} state={showClosed ? (shownClosed.length ? 'ready' : 'empty') : 'ready'} aside={<Button size="sm" variant="ghost" onClick={() => setShowClosed((v) => !v)}>{showClosed ? 'Hide' : 'Show'}</Button>}
              empty={{ icon: <CheckIcon />, title: 'No closed endeavor matches' }}>
              {showClosed ? <List>{shownClosed.map((e) => <EndeavorRow key={e.endeavorId} org={communityId} row={e} />)}</List> : <div className="ui-note" style={{ padding: 'var(--sp-3) var(--sp-4)', margin: 0 }}>{closedRows.length} finished endeavor{closedRows.length === 1 ? '' : 's'} — show them to look back.</div>}
            </Panel>
          )}
        </>
      ) : data === null ? (
        <Panel title="Board" icon={<ActivityIcon />} state="loading" rows={3} />
      ) : (
        <div style={{ display: 'flex', gap: 'var(--sp-3)', overflowX: 'auto', alignItems: 'flex-start', paddingBottom: 'var(--sp-2)' }}>
          {ENDEAVOR_LIFECYCLES.map((lc: EndeavorLifecycle) => {
            const rows = endeavors.filter((e) => e.lifecycle === lc);
            if (rows.length === 0 && (lc === 'suspended' || lc === 'abandoned' || lc === 'proposed')) return null;
            return (
              <div key={lc} style={{ minWidth: 240, flex: '0 0 240px', background: 'var(--color-surface-sunken)', borderRadius: 'var(--ui-radius)', padding: 'var(--sp-2)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-2)', margin: '2px 2px 8px' }}>
                  <StatePill state={lifecycleState(lc)} native={LIFECYCLE_LABEL[lc]} />
                  <span className="ui-micro">{rows.length}</span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)' }}>
                  {rows.map((e) => <EndeavorCard key={e.endeavorId} org={communityId} row={e} />)}
                  {rows.length === 0 && <div className="ui-micro" style={{ padding: '6px 4px' }}>Empty</div>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </SectionShell>
  );
}
