'use client';
// Person My Work (spec 334 §7): the principal's own coordination facts across
// every org they belong to — allocations awaiting their signed commitment
// (with a Commit action posting endeavor.commit), active commitments, and
// pending decision requests. Entries are projected through the portable
// @agenticprimitives/home contracts (HomeContributionEntryV1 /
// HomeDecisionCardV1) and rendered as action-card-style rows: pressing an
// action only PROPOSES a signed lifecycle transition — it grants nothing.
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import type { HomeContributionEntryV1, HomeDecisionCardV1 } from '@agenticprimitives/home';
import { useSession } from '../../../context/session';
import { fetchParkedRuns, type ParkedRun } from '../../../home/ask';
import { SectionShell } from '../SectionShell';
import { List, Row, Empty, ErrorNote, Button, LinkButton, Chip, Panel, Stats, Stat, SearchInput, FilterChip, relativeLabel, type PanelState } from '../../../ui';
import { AlertIcon, CheckIcon, InboxIcon, ActivityIcon } from '../today-icons';
import { BusyButton } from '../../shared/BusyButton';
import { resolveVia, signHashFor } from '../../../home/onboarding';
import { commitContribution, recordDecision } from '../../../lib/work-client';
import { askCommand } from '../../../home/ask-command';
import { NewRequestComposer } from './NewRequestComposer';
import { useReEnableInteractions, useMyWork, type OrgWorkBundle, type StaleOrg } from './useWork';
import { LIFECYCLE_LABEL, lifecycleState } from './labels';
import { StatePill } from '../StatePill';
import { RunControls } from '../runs/RunControls';
import { stateOf, runStateLabel, type AwaitingKind } from '../../../home/run-state';
import { BasisLine } from '../BasisLine';

const saOf = (caip: string): string => caip.match(/0x[0-9a-fA-F]{40}$/)?.[0]?.toLowerCase() ?? caip;

function EntryCard({
  entry,
  orgName,
  action,
}: {
  entry: HomeContributionEntryV1;
  orgName?: string;
  action?: React.ReactNode;
}) {
  const detailHref = `/org/${saOf(entry.managingPrincipal)}/work/${encodeURIComponent(entry.endeavorId)}`;
  return (
    <Row
      title={entry.endeavorTitle} titleHref={detailHref}
      meta={<>{orgName ? `${orgName} · ` : ''}{entry.status} · {entry.stepIds.length} plan step{entry.stepIds.length === 1 ? '' : 's'}{entry.planRef.revision > 0 ? ` · plan revision ${entry.planRef.revision}` : ''}{entry.deadline ? ` · due ${new Date(entry.deadline).toLocaleDateString()}` : ''}</>}
      side={action}
    />
  );
}

// Spec 423 §3.3 — the "I don't need this" exit. A per-VIEWER dismissal of a paused org's row: it changes no org
// record (ADR-0055 — a rebuild, not a bereavement), only this person's own Work view. localStorage is the right home
// for a per-viewer convenience like a dismissed row (W1; the spec's vault-resident projection is a later upgrade).
const DISMISS_KEY = (addr: string | null | undefined) => `faithnet:work:paused-dismissed:${(addr ?? 'anon').toLowerCase()}`;
function readDismissed(addr: string | null | undefined): Set<string> {
  try { const raw = localStorage.getItem(DISMISS_KEY(addr)); return new Set(raw ? (JSON.parse(raw) as string[]).map((s) => s.toLowerCase()) : []); } catch { return new Set(); }
}
function writeDismissed(addr: string | null | undefined, set: Set<string>): void {
  try { localStorage.setItem(DISMISS_KEY(addr), JSON.stringify([...set])); } catch { /* private mode / disabled — the dismissal just won't persist across reloads */ }
}

export function MyWorkView() {
  const { session, profile: homeProfile, agentAddress } = useSession();
  const { bundles, staleOrgs, error: loadError, load } = useMyWork(session, agentAddress);
  const [actError, setError] = useState<string | null>(null);
  const error = actError ?? loadError;
  // Per-viewer dismissal of paused-org rows (spec 423 §3.3). Empty on first render (SSR-safe); filled from
  // localStorage once mounted, re-read when the acting person changes.
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  useEffect(() => { setDismissed(readDismissed(agentAddress)); }, [agentAddress]);
  const dismiss = useCallback((org: string) => {
    setDismissed((prev) => { const next = new Set(prev); next.add(org.toLowerCase()); writeDismissed(agentAddress, next); return next; });
  }, [agentAddress]);
  const visibleStale = useMemo(() => staleOrgs.filter((s) => !dismissed.has(s.org.toLowerCase())), [staleOrgs, dismissed]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const reEnable = useReEnableInteractions();

  const runReEnable = useCallback(async (s: StaleOrg) => {
    setBusyId(`reenable:${s.org}`); setError(null);
    const r = await reEnable(s.org as Address);
    if (!r.ok) setError(r.error ?? 'could not re-enable storage');
    else await load();
    setBusyId(null);
  }, [reEnable, load]);

  // Spec 382 W2 — the runs parked on this person's agent, so a commitment can show the ask it became.
  const [parked, setParked] = useState<ParkedRun[]>([]);
  useEffect(() => {
    if (!session || !agentAddress) return;
    let live = true;
    void fetchParkedRuns(session, agentAddress as Address).then((rs) => { if (live) setParked(rs.filter((r) => r.origin?.endeavorId)); }).catch(() => undefined);
    return () => { live = false; };
  }, [session?.token, agentAddress, bundles]);

  // Spec 361 I4 — the withdrawal goes to the Ask as a supplied plan: the organization's agent verifies that this
  // person holds the commitment, asks for their mandate, and they sign there. The screen names the act.
  const withdraw = useCallback((bundle: OrgWorkBundle, entry: HomeContributionEntryV1) => {
    if (!session || !entry.commitmentId) return;
    const reason = typeof window !== 'undefined' ? (window.prompt('Why are you withdrawing? (optional — the organization sees it)') ?? undefined) : undefined;
    askCommand({ toolId: 'coordination.commitment.withdraw', args: { org: bundle.org, endeavorId: entry.endeavorId, commitmentId: entry.commitmentId, ...(reason?.trim() ? { note: reason.trim() } : {}) }, message: `Withdraw my commitment ${entry.commitmentId}${reason?.trim() ? ` — ${reason.trim()}` : ''}` });
  }, [session]);

  const commit = useCallback(async (bundle: OrgWorkBundle, entry: HomeContributionEntryV1) => {
    if (!session || !agentAddress) return;
    const alloc = bundle.allocations.find((a) => a.allocationId === entry.allocationId);
    if (!alloc?.planRef) { setError('This allocation has no adopted plan revision to commit against yet.'); return; }
    setBusyId(entry.allocationId ?? ''); setError(null);
    try {
      const sign = await signHashFor(resolveVia(homeProfile?.credential, session.via), agentAddress, { token: session.token });
      await commitContribution(session.token, bundle.org, {
        endeavorId: entry.endeavorId,
        allocationRef: entry.allocationId ?? '',
        participant: agentAddress,
        planRef: alloc.planRef,
        steps: entry.stepIds,
      }, sign);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusyId(null); }
  }, [session, agentAddress, homeProfile?.credential, load]);

  // Spec 393 — the record carries its rationale; a decision without a reason is refused by the door.
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const decide = useCallback(async (bundle: OrgWorkBundle, card: HomeDecisionCardV1, outcome: 'approved' | 'rejected') => {
    if (!session) return;
    const reason = (reasons[card.decisionId] ?? '').trim();
    if (!reason) { setError('Say why — the reason is kept as the decision\'s record.'); return; }
    setBusyId(card.decisionId); setError(null);
    try {
      await recordDecision(session.token, bundle.org, card.endeavorId, card.decisionId, outcome, reason);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusyId(null); }
  }, [session, load, reasons]);

  const { awaiting, active, decisions, myRequests } = useMemo(() => {
    const all = bundles ?? [];
    return {
      awaiting: all.flatMap((b) => b.entries.filter((e) => e.status === 'allocated').map((e) => ({ b, e }))),
      active: all.flatMap((b) => b.entries.filter((e) => e.status !== 'allocated').map((e) => ({ b, e }))),
      decisions: all.flatMap((b) => b.decisions.map((c) => ({ b, c }))),
      myRequests: all
        .flatMap((b) => b.myRequests.map((q) => ({ b, q })))
        .sort((x, y) => Date.parse(y.q.submittedAt) - Date.parse(x.q.submittedAt)),
    };
  }, [bundles]);

  // The page's own filters: words, an organization, whether finished requests are shown.
  const [q, setQ] = useState('');
  const [orgFilter, setOrgFilter] = useState<string | null>(null);
  const [showDone, setShowDone] = useState(false);
  const orgs = useMemo(() => [...new Map((bundles ?? []).map((b) => [b.org, b.orgName ?? `${b.org.slice(0, 10)}…`])).entries()], [bundles]);
  const needle = q.trim().toLowerCase();
  const matches = (words: string, org: string) => (!needle || words.toLowerCase().includes(needle)) && (!orgFilter || org === orgFilter);
  const requestRows = useMemo(() => myRequests.map(({ b, q: r }) => {
    const endeavorId = r.endeavorId ?? b.endeavors.find((e) => e.requestRef === r.requestId)?.endeavorId;
    const endeavor = endeavorId ? b.endeavors.find((e) => e.endeavorId === endeavorId) : undefined;
    const status = r.status ?? 'pending';
    const lifecycle = endeavor?.lifecycle ?? r.endeavorLifecycle;
    const completed = status === 'adopted' && lifecycle === 'satisfied';
    const done = completed || status === 'declined';
    const href = status === 'adopted' && endeavorId ? `/org/${b.org}/work/${encodeURIComponent(endeavorId)}` : undefined;
    return { b, r, status, lifecycle, completed, done, href };
  }), [myRequests]);
  const openRequests = requestRows.filter((x) => !x.done && matches(x.r.goal, x.b.org));
  const doneRequests = requestRows.filter((x) => x.done && matches(x.r.goal, x.b.org));
  const attention = [...awaiting.map(({ b, e }) => ({ b, key: `attn:${b.org}:${e.allocationId}`, words: e.endeavorTitle })), ...decisions.map(({ b, c }) => ({ b, key: `attn:${b.org}:${c.decisionId}`, words: c.title }))].filter((x) => matches(x.words, x.b.org));
  const committed = active.filter(({ b, e }) => matches(e.endeavorTitle, b.org));
  const loading = bundles === null;
  const st = (n: number): PanelState => (loading ? 'loading' : n ? 'ready' : 'empty');

  if (!session) return <SectionShell title="My Work"><Empty>Not signed in.</Empty></SectionShell>;

  return (
    <SectionShell
      title="My Work"
      description="What you asked for, what you were named to decide, and the steps you committed to — across every organization you belong to."
      actions={
        <Button variant={composerOpen ? 'secondary' : 'primary'} onClick={() => setComposerOpen((v) => !v)}>
          {composerOpen ? 'Close' : 'New request'}
        </Button>
      }
    >
      {error && <ErrorNote>{error}</ErrorNote>}

      {visibleStale.length > 0 && (
        <div className="ui-card" style={{ marginBottom: 'var(--sp-4)', borderColor: 'var(--st-warn-dot)', background: 'var(--st-warn-bg)' }}>
          <p className="ui-note" style={{ color: 'var(--st-warn-fg)' }}>Storage is paused for these organizations — their signing session lapsed, so their work can&rsquo;t load. The organization&rsquo;s authority is unchanged; a steward renews it with one signature.</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {visibleStale.map((s) => (
              <div key={s.org} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={{ fontSize: 'var(--fs-sm)', fontWeight: 600 }}>{s.orgName ?? `${s.org.slice(0, 10)}…`}</span>
                {s.steward ? (
                  <BusyButton busy={busyId === `reenable:${s.org}`} busyLabel="Renewing…" className="ui-btn ui-btn--secondary ui-btn--sm" onClick={() => void runReEnable(s)}>Renew storage</BusyButton>
                ) : <span className="ui-micro">its steward needs to renew it</span>}
                {/* Spec 423 §3.3 — a way OUT, not just a way forward: hide this row from my Work (per-viewer, reversible). */}
                <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" onClick={() => dismiss(s.org)} title="Remove this from my Work (does not change the organization)">I don&rsquo;t need this</button>
              </div>
            ))}
          </div>
        </div>
      )}

      {composerOpen && (
        <div style={{ marginBottom: 'var(--sp-4)' }}>
          <NewRequestComposer onSubmitted={() => void load()} />
        </div>
      )}

      <Stats>
        <Stat label="Needs your decision" value={attention.length} loading={loading} tone={attention.length ? 'warn' : undefined} hint="to sign, approve or commit" href="#work-attention" />
        <Stat label="Open requests" value={openRequests.length} loading={loading} hint="what you asked for, still in motion" href="#work-requests" />
        <Stat label="Committed" value={committed.length} loading={loading} hint="steps you took on" href="#work-committed" />
        <Stat label="Completed" value={doneRequests.filter((x) => x.completed).length} loading={loading} tone="ok" hint="requests that finished" />
      </Stats>

      <div className="ui-toolbar">
        <SearchInput placeholder="Search your work…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search work" />
        {orgs.length > 1 && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <FilterChip active={orgFilter === null} onClick={() => setOrgFilter(null)}>All organizations</FilterChip>
            {orgs.map(([org, name]) => <FilterChip key={org} active={orgFilter === org} onClick={() => setOrgFilter(orgFilter === org ? null : org)}>{name}</FilterChip>)}
          </div>
        )}
      </div>

      <div id="work-attention" />
      <Panel title="Needs your decision" icon={<AlertIcon />} count={attention.length} state={st(attention.length)} rows={2} aside={<BasisLine needs="your signature, as the named approver or the allocated participant" />}
        empty={{ icon: <AlertIcon />, title: 'Nothing is waiting on you', hint: 'Allocations to commit to and decisions you were named for appear here first.' }}>
        <List>
          {awaiting.filter(({ b, e }) => matches(e.endeavorTitle, b.org)).map(({ b, e }) => (
            <EntryCard key={`attn:${b.org}:${e.allocationId}`} entry={e} {...(b.orgName ? { orgName: b.orgName } : {})}
              action={<BusyButton busy={busyId === e.allocationId} busyLabel="Signing…" className="ui-btn ui-btn--primary ui-btn--sm" onClick={() => void commit(b, e)}>Commit to this work</BusyButton>} />
          ))}
          {decisions.filter(({ b, c }) => matches(c.title, b.org)).map(({ b, c }) => (
            <Row key={`attn:${b.org}:${c.decisionId}`} title={c.title}
              meta={<>{b.orgName ? `${b.orgName} · ` : ''}{c.decisionKind}{c.dueAt ? ` · due ${new Date(c.dueAt).toLocaleDateString()}` : ''}</>}
              side={<>
                <input className="input" value={reasons[c.decisionId] ?? ''} onChange={(e) => setReasons((r) => ({ ...r, [c.decisionId]: e.target.value }))} placeholder="Why? (kept as the record)" aria-label="Reason for the decision" style={{ fontSize: 'var(--fs-sm)', padding: '4px 10px', minWidth: '14rem', minHeight: 32, height: 32 }} />
                {c.allowedActions.map((a) => (
                  <BusyButton key={a.actionId} busy={busyId === c.decisionId} busyLabel="…" className={`ui-btn ui-btn--sm ${a.style === 'destructive' ? 'ui-btn--danger' : 'ui-btn--primary'}`} onClick={() => void decide(b, c, a.transition === 'approve' ? 'approved' : 'rejected')}>{a.label}</BusyButton>
                ))}
              </>} />
          ))}
        </List>
      </Panel>

      <div id="work-requests" />
      <Panel title="Your requests" icon={<InboxIcon />} count={openRequests.length} state={st(openRequests.length)} rows={4}
        aside={doneRequests.length > 0 ? <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" onClick={() => setShowDone((v) => !v)}>{showDone ? 'Hide' : 'Show'} {doneRequests.length} finished</button> : undefined}
        empty={{ icon: <InboxIcon />, title: needle || orgFilter ? 'No open request matches' : 'No open requests', hint: needle || orgFilter ? 'Clear the search or the organization filter.' : 'New request states a goal for an organization or a person; what comes of it is tracked here.', action: needle || orgFilter ? undefined : <Button size="sm" variant="secondary" onClick={() => setComposerOpen(true)}>New request</Button> }}>
        <List>
          {openRequests.map(({ b, r, status, lifecycle, href }) => (
            <Row key={`${b.org}:${r.requestId}`} title={r.goal} {...(href ? { titleHref: href } : {})}
              meta={<>{b.orgName ? `${b.orgName} · ` : ''}asked {relativeLabel(r.submittedAt)} ago{status === 'pending' ? ' · awaiting a decision' : ''}</>}
              side={<>
                {status === 'pending' && <Chip tone="warn">pending</Chip>}
                {status === 'adopted' && lifecycle && <StatePill state={lifecycleState(lifecycle)} native={LIFECYCLE_LABEL[lifecycle]} compact />}
                {href && <LinkButton size="sm" href={href}>Open</LinkButton>}
              </>}>
              {r.outcomeSummary && <div className="ui-meta" style={{ marginTop: 4, whiteSpace: 'pre-wrap', color: 'var(--color-text-body)' }}><b>Outcome:</b> {r.outcomeSummary}</div>}
            </Row>
          ))}
        </List>
      </Panel>

      {showDone && doneRequests.length > 0 && (
        <Panel title="Finished requests" icon={<CheckIcon />} count={doneRequests.length} state="ready">
          <List>
            {doneRequests.map(({ b, r, status, completed, href }) => (
              <Row key={`${b.org}:${r.requestId}`} title={r.goal} {...(href ? { titleHref: href } : {})}
                meta={<>{b.orgName ? `${b.orgName} · ` : ''}{new Date(r.submittedAt).toLocaleDateString()}{status === 'declined' ? ` · declined${r.reason ? ` — ${r.reason}` : ''}` : ''}</>}
                side={<>{completed ? <Chip tone="ok">completed</Chip> : <Chip tone="danger">declined</Chip>}{href && <LinkButton size="sm" href={href}>View result</LinkButton>}</>}>
                {r.outcomeSummary && <div className="ui-meta" style={{ marginTop: 4, whiteSpace: 'pre-wrap', color: 'var(--color-text-body)' }}><b>Outcome:</b> {r.outcomeSummary}</div>}
              </Row>
            ))}
          </List>
        </Panel>
      )}

      <div id="work-committed" />
      <Panel title="Work you committed to" icon={<ActivityIcon />} count={committed.length} state={st(committed.length)} rows={2}
        empty={{ icon: <ActivityIcon />, title: 'Nothing committed yet', hint: 'When a coordinator allocates you plan steps and you commit, they appear here with the run that does them.' }}>
        <List>
          {committed.map(({ b, e }) => {
            const run = parked.find((r) => r.origin?.endeavorId === e.endeavorId && e.stepIds.includes(r.origin?.stepId ?? ''));
            return (
              <EntryCard key={`${b.org}:${e.commitmentId ?? e.allocationId}`} entry={e} {...(b.orgName ? { orgName: b.orgName } : {})}
                action={(
                  <span style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                    {run ? (
                      <LinkButton size="sm" href={`/ask?seed=${encodeURIComponent(run.message)}`} data-testid="committed-run-open" title={run.runRef}>
                        Open in Ask{run.awaiting ? ` · ${runStateLabel(stateOf({ kind: 'suspended', awaiting: run.awaiting.kind as AwaitingKind, expired: false }))}` : ''}
                      </LinkButton>
                    ) : <span className="ui-micro">no parked run on your agent yet</span>}
                    {run && agentAddress && <RunControls token={session.token} addressee={agentAddress as Address} runRef={run.runRef} compact onCanceled={() => setParked((p) => p.filter((r) => r.runRef !== run.runRef))} />}
                    {e.commitmentId && (
                      <BusyButton busy={busyId === `withdraw:${e.commitmentId}`} busyLabel="Withdrawing…" className="ui-btn ui-btn--ghost ui-btn--sm" onClick={() => void withdraw(b, e)} disabled={!!busyId}>Withdraw</BusyButton>
                    )}
                  </span>
                )} />
            );
          })}
        </List>
      </Panel>
    </SectionShell>
  );
}
