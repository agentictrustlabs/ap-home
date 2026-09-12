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
import { listRuns, type ParkedRun } from '../../../home/ask';
import { SectionShell } from '../SectionShell';
import { Section, List, Row, Empty, ErrorNote, Button, LinkButton, Chip } from '../../../ui';
import { BusyButton } from '../../shared/BusyButton';
import { Loading } from '../../shared/Loading';
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

export function MyWorkView() {
  const { session, profile: homeProfile, agentAddress } = useSession();
  const { bundles, staleOrgs, error: loadError, load } = useMyWork(session, agentAddress);
  const [actError, setError] = useState<string | null>(null);
  const error = actError ?? loadError;
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
    void listRuns(session, agentAddress as Address).then((rs) => { if (live) setParked(rs.filter((r) => r.origin?.endeavorId)); }).catch(() => undefined);
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

      {staleOrgs.length > 0 && (
        <div className="manage-card" style={{ padding: '0.8rem 1rem', marginBottom: '0.9rem', border: '1px solid var(--color-amber-400)', background: 'var(--color-amber-50)' }}>
          <p style={{ fontSize: '0.83rem', margin: '0 0 0.5rem' }}>
            Storage was upgraded for coordination — these organizations&rsquo; grants must be re-signed before their work loads:
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
            {staleOrgs.map((s) => (
              <div key={s.org} style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={{ fontSize: '0.82rem', fontWeight: 600 }}>{s.orgName ?? `${s.org.slice(0, 10)}…`}</span>
                {s.steward ? (
                  <BusyButton busy={busyId === `reenable:${s.org}`} busyLabel="Re-enabling…" className="btn" style={{ width: 'auto', fontSize: '0.76rem', padding: '0.25rem 0.6rem' }} onClick={() => void runReEnable(s)}>
                    Re-enable storage
                  </BusyButton>
                ) : (
                  <span style={{ fontSize: '0.74rem', opacity: 0.7 }}>ask a steward to re-enable</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {composerOpen && (
        <div style={{ marginBottom: '1rem' }}>
          <NewRequestComposer onSubmitted={() => void load()} />
        </div>
      )}

      {bundles === null ? (
        <Loading label="Loading your work across every organization…" />
      ) : (
        <>
          {/* Action-priority inbox: everything that NEEDS this person, first and unmissable. */}
          {(awaiting.length > 0 || decisions.length > 0) && (
            <Section title="Needs your decision" count={awaiting.length + decisions.length} aside={<BasisLine needs="your signature, as the named approver or the allocated participant" />}>
              <List>
                {awaiting.map(({ b, e }) => (
                  <EntryCard
                    key={`attn:${b.org}:${e.allocationId}`}
                    entry={e}
                    {...(b.orgName ? { orgName: b.orgName } : {})}
                    action={
                      <BusyButton busy={busyId === e.allocationId} busyLabel="Signing…" className="ui-btn ui-btn--primary ui-btn--sm" onClick={() => void commit(b, e)}>
                        Commit to this work
                      </BusyButton>
                    }
                  />
                ))}
                {decisions.map(({ b, c }) => (
                  <Row
                    key={`attn:${b.org}:${c.decisionId}`}
                    title={c.title}
                    meta={<>{b.orgName ? `${b.orgName} · ` : ''}{c.decisionKind}{c.dueAt ? ` · due ${new Date(c.dueAt).toLocaleDateString()}` : ''}</>}
                    side={<>
                      <input
                        className="input"
                        value={reasons[c.decisionId] ?? ''}
                        onChange={(e) => setReasons((r) => ({ ...r, [c.decisionId]: e.target.value }))}
                        placeholder="Why? (kept as the record)"
                        aria-label="Reason for the decision"
                        style={{ fontSize: 'var(--fs-sm)', padding: '4px 8px', minWidth: '12rem', minHeight: 28 }}
                      />
                      {c.allowedActions.map((a) => (
                        <BusyButton
                          key={a.actionId}
                          busy={busyId === c.decisionId}
                          busyLabel="…"
                          className={`ui-btn ui-btn--sm ${a.style === 'destructive' ? 'ui-btn--danger' : 'ui-btn--primary'}`}
                          onClick={() => void decide(b, c, a.transition === 'approve' ? 'approved' : 'rejected')}
                        >
                          {a.label}
                        </BusyButton>
                      ))}
                    </>}
                  />
                ))}
              </List>
            </Section>
          )}

          <Section title="Your requests" count={myRequests.length || undefined}>
          {myRequests.length === 0 ? (
            <Empty>No requests yet — New request states a goal for an organization or a person.</Empty>
          ) : (
            <List>
              {myRequests.map(({ b, q }) => {
                // Adopted → resolve the Endeavor it became (the request row's endeavorId, or the
                // endeavor whose requestRef points back at this request).
                const endeavorId = q.endeavorId ?? b.endeavors.find((e) => e.requestRef === q.requestId)?.endeavorId;
                const endeavor = endeavorId ? b.endeavors.find((e) => e.endeavorId === endeavorId) : undefined;
                const status = q.status ?? 'pending';
                // The requester isn't a participant, so the endeavor rarely appears in b.endeavors —
                // fall back to the lifecycle the serving plane attaches to the request row.
                const lifecycle = endeavor?.lifecycle ?? q.endeavorLifecycle;
                const completed = lifecycle === 'satisfied';
                const href = status === 'adopted' && endeavorId ? `/org/${b.org}/work/${encodeURIComponent(endeavorId)}` : undefined;
                return (
                  <Row
                    key={`${b.org}:${q.requestId}`}
                    title={q.goal} {...(href ? { titleHref: href } : {})}
                    meta={<>
                      {b.orgName ? `${b.orgName} · ` : ''}{new Date(q.submittedAt).toLocaleDateString()}
                      {status === 'pending' && ' · awaiting a decision'}
                      {status === 'declined' && ` · declined${q.reason ? ` — ${q.reason}` : ''}`}
                      {status === 'adopted' && completed && ' · completed'}
                    </>}
                    side={<>
                      {status === 'adopted' && !completed && lifecycle && <StatePill state={lifecycleState(lifecycle)} native={LIFECYCLE_LABEL[lifecycle]} compact />}
                      {status === 'adopted' && completed && <Chip tone="ok">completed</Chip>}
                      {href && <LinkButton size="sm" href={href}>{completed ? 'View result' : 'Open'}</LinkButton>}
                    </>}
                  >
                    {q.outcomeSummary && <div className="ui-meta" style={{ marginTop: 4, whiteSpace: 'pre-wrap', color: 'var(--color-text-body)' }}><b>Outcome:</b> {q.outcomeSummary}</div>}
                  </Row>
                );
              })}
            </List>
          )}
          </Section>

          <Section title="Work you committed to" count={active.length || undefined}>
          {active.length === 0 ? (
            <Empty>Nothing yet — when a coordinator assigns you plan steps and you commit, they appear here.</Empty>
          ) : (
            <List>
              {active.map(({ b, e }) => {
                // Spec 382 W2 — the committed step is a run parked on THIS person's agent: shown beside the
                // commitment, opened in the Ask (it asks for their mandate there), or taken back here.
                const run = parked.find((r) => r.origin?.endeavorId === e.endeavorId && e.stepIds.includes(r.origin?.stepId ?? ''));
                return (
                  <EntryCard key={`${b.org}:${e.commitmentId ?? e.allocationId}`} entry={e} {...(b.orgName ? { orgName: b.orgName } : {})}
                    action={(
                      <span style={{ display: 'flex', gap: '0.4rem', alignItems: 'center', flexWrap: 'wrap' }}>
                        {run ? (
                          <LinkButton size="sm" href={`/ask?seed=${encodeURIComponent(run.message)}`} data-testid="committed-run-open" title={run.runRef}>
                            Open in Ask{run.awaiting ? ` · ${runStateLabel(stateOf({ kind: 'suspended', awaiting: run.awaiting.kind as AwaitingKind, expired: false }))}` : ''}
                          </LinkButton>
                        ) : <span className="ui-micro">no parked run on your agent yet</span>}
                        {run && agentAddress && <RunControls token={session.token} addressee={agentAddress as Address} runRef={run.runRef} compact onCanceled={() => setParked((p) => p.filter((r) => r.runRef !== run.runRef))} />}
                        {e.commitmentId && (
                          <BusyButton busy={busyId === `withdraw:${e.commitmentId}`} busyLabel="Withdrawing…" className="ui-btn ui-btn--ghost ui-btn--sm" onClick={() => void withdraw(b, e)} disabled={!!busyId}>
                            Withdraw
                          </BusyButton>
                        )}
                      </span>
                    )}
                  />
                );
              })}
            </List>
          )}
          </Section>
        </>
      )}
    </SectionShell>
  );
}
