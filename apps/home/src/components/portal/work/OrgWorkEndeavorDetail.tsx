'use client';
// Org Work — Endeavor detail (spec 334 §6), PHASE-AWARE: the page derives the
// endeavor's phase (needs-plan → plan-review → execution → completed/closed)
// and the viewer's role, and surfaces exactly ONE "your next action" band; the
// plan is the spine (per-step status + inline actions: offer / commit / mark
// done with evidence); participants, commitments and the activity trail are
// secondary. All facts come from the serving plane's endeavor.get projection —
// nothing here is authority (commit signs, everything else records).
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { useSession } from '../../../context/session';
import { SectionShell } from '../SectionShell';
import { BusyButton } from '../../shared/BusyButton';
import { resolveVia, signHashFor } from '../../../home/onboarding';
import { agentLabel, shortId } from '../../../home/use-inbox';
import {
  adoptPlan,
  allocateContribution,
  closeEndeavor,
  commitContribution,
  completeEndeavor,
  fetchWorkDetail,
  markStepDone,
  offerContribution,
  proposePlan,
  recordDecision,
  type WorkDetailResponse,
} from '../../../lib/work-client';
import { useOrgMemberNames } from './useWork';
import { EVENT_LABEL, LIFECYCLE_LABEL, STEP_KIND_LABEL, StatusPillStyle } from './labels';
import type { EndeavorLifecycle } from '@agenticprimitives/home';

const STEP_KINDS = ['contribution', 'interaction', 'decision', 'aggregation', 'validation'] as const;
type StepKind = (typeof STEP_KINDS)[number];
interface DraftStep { kind: StepKind; description: string }

type Phase = 'needs-plan' | 'plan-review' | 'execution' | 'completed' | 'closed';

function resolvePhase(d: WorkDetailResponse): Phase {
  const lc = d.endeavor?.lifecycle as EndeavorLifecycle | undefined;
  if (lc === 'satisfied') return 'completed';
  if (lc === 'abandoned') return 'closed';
  if (d.plan?.status === 'adopted') return 'execution';
  if ((d.plans ?? []).some((p) => p.status === 'proposed')) return 'plan-review';
  return 'needs-plan';
}

type StepStatus =
  | { kind: 'done' }
  | { kind: 'committed'; who: string }
  | { kind: 'assigned'; who: string }
  | { kind: 'offered'; who: string }
  | { kind: 'open' };

export function OrgWorkEndeavorDetail({ org, endeavorId }: { org: Address; endeavorId: string }) {
  const { session, profile: homeProfile, agentAddress } = useSession();
  const communityId = org.toLowerCase();
  const [detail, setDetail] = useState<WorkDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const names = useOrgMemberNames(session, communityId);
  const [draftSteps, setDraftSteps] = useState<DraftStep[]>([{ kind: 'contribution', description: '' }]);
  const [offerSteps, setOfferSteps] = useState<Record<string, boolean>>({});
  const [doneFor, setDoneFor] = useState<string | null>(null); // stepId with the evidence prompt open
  const [doneNote, setDoneNote] = useState('');
  const [closing, setClosing] = useState(false);
  const [closeReason, setCloseReason] = useState('');
  const [showActivity, setShowActivity] = useState(false);

  const load = useCallback(async () => {
    if (!session) return;
    try {
      const d = await fetchWorkDetail(session.token, communityId, endeavorId);
      if (d.ok === false && d.error) { setError(d.error); return; }
      setDetail(d); setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [session, communityId, endeavorId]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const t = setInterval(() => void load(), 12000);
    return () => clearInterval(t);
  }, [load]);

  const label = useCallback((who: string): string => agentLabel(who, names), [names]);

  const me = (agentAddress ?? '').toLowerCase();
  const phase = detail ? resolvePhase(detail) : null;
  const isSteward = detail?.steward === true;
  const iParticipate = (detail?.participations ?? []).some((p) => p.participant.toLowerCase().endsWith(me));

  const myAllocations = (detail?.allocations ?? []).filter(
    (a) => a.participant.toLowerCase().endsWith(me) &&
      (a as { status?: string }).status !== 'committed' &&
      !(detail?.commitments ?? []).some((c) => c.allocationRef === a.allocationId && c.status === 'active'),
  );
  const myPendingDecisions = (detail?.decisions ?? []).filter(
    (d) => d.status === 'pending' && d.approver.toLowerCase().endsWith(me),
  );
  const myCommittedSteps = useMemo(() => {
    const set = new Set<string>();
    for (const c of detail?.commitments ?? []) {
      if (c.status === 'active' && c.participant.toLowerCase().endsWith(me)) c.steps.forEach((s) => set.add(s));
    }
    return set;
  }, [detail, me]);

  /** Per-step status derived from satisfied facts + commitments + allocations + open offers. */
  const stepStatus = useCallback((stepId: string, satisfied: boolean): StepStatus => {
    if (satisfied) return { kind: 'done' };
    const c = (detail?.commitments ?? []).find((x) => x.status === 'active' && x.steps.includes(stepId));
    if (c) return { kind: 'committed', who: c.participant };
    const a = (detail?.allocations ?? []).find((x) => x.steps.includes(stepId) && (x as { status?: string }).status !== 'committed');
    if (a) return { kind: 'assigned', who: a.participant };
    const p = (detail?.proposals ?? []).find((x) => x.status === 'open' && x.steps.includes(stepId));
    if (p) return { kind: 'offered', who: p.proposer };
    return { kind: 'open' };
  }, [detail]);

  const allDone = !!detail?.plan && detail.plan.steps.length > 0 && detail.plan.steps.every((s) => s.satisfied);
  const iOfferedAlready = (detail?.proposals ?? []).some((p) => p.status === 'open' && p.proposer.toLowerCase().endsWith(me));

  // ── Actions ──
  const run = useCallback(async (id: string, fn: () => Promise<unknown>) => {
    if (!session) return;
    setBusyId(id); setError(null);
    try { await fn(); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusyId(null); }
  }, [session, load]);

  const commit = useCallback((allocationId: string, steps: string[]) => run(allocationId, async () => {
    if (!session || !agentAddress || !detail?.plan) throw new Error('no adopted plan to commit against');
    const sign = await signHashFor(resolveVia(homeProfile?.credential, session.via), agentAddress, { token: session.token });
    await commitContribution(session.token, communityId, {
      endeavorId,
      allocationRef: allocationId,
      participant: agentAddress,
      planRef: { planId: detail.plan.planId, revision: detail.plan.revision, hash: detail.plan.contentHash },
      steps,
    }, sign);
  }), [run, session, agentAddress, homeProfile?.credential, detail, communityId, endeavorId]);

  const submitPlan = useCallback(() => run('plan', async () => {
    if (!session) return;
    const steps = draftSteps
      .filter((s) => s.description.trim())
      .map((s, i) => ({ stepId: `step_${i + 1}_${crypto.randomUUID().slice(0, 8)}`, kind: s.kind, description: s.description.trim() }));
    if (steps.length === 0) throw new Error('Add at least one plan step with a description.');
    const r = await proposePlan(session.token, communityId, endeavorId, steps);
    if (isSteward && r.planId && r.revision && r.contentHash) {
      await adoptPlan(session.token, communityId, endeavorId, { planId: r.planId, revision: r.revision, hash: r.contentHash });
    }
    setDraftSteps([{ kind: 'contribution', description: '' }]);
  }), [run, session, communityId, endeavorId, draftSteps, isSteward]);

  const latestProposed = useMemo(() => {
    const proposed = (detail?.plans ?? []).filter((p) => p.status === 'proposed');
    return proposed.sort((a, b) => b.revision - a.revision)[0];
  }, [detail]);
  const proposedByAgent = !!latestProposed && (latestProposed.proposedBy ?? '').toLowerCase() === communityId;

  const adoptProposed = useCallback(() => run('adoptPlan', async () => {
    if (!session || !latestProposed) return;
    await adoptPlan(session.token, communityId, endeavorId, {
      planId: latestProposed.planId, revision: latestProposed.revision, hash: latestProposed.contentHash,
    });
  }), [run, session, communityId, endeavorId, latestProposed]);

  const offer = useCallback(() => run('offer', async () => {
    if (!session || !detail?.plan) return;
    const steps = Object.entries(offerSteps).filter(([, v]) => v).map(([k]) => k);
    if (steps.length === 0) throw new Error('Select at least one open step to help with.');
    await offerContribution(session.token, communityId, endeavorId, {
      planId: detail.plan.planId, revision: detail.plan.revision, hash: detail.plan.contentHash,
    }, steps);
    setOfferSteps({});
  }), [run, session, communityId, endeavorId, detail, offerSteps]);

  const allocate = useCallback((proposalId: string, participant: string, steps: string[]) =>
    run(proposalId, async () => {
      if (!session) return;
      await allocateContribution(session.token, communityId, endeavorId, proposalId, participant, steps);
    }), [run, session, communityId, endeavorId]);

  const decide = useCallback((decisionId: string, outcome: 'approved' | 'rejected') =>
    run(decisionId, async () => {
      if (!session) return;
      await recordDecision(session.token, communityId, endeavorId, decisionId, outcome);
    }), [run, session, communityId, endeavorId]);

  const markDone = useCallback((stepId: string) => run(`done:${stepId}`, async () => {
    if (!session) return;
    const note = doneNote.trim();
    if (!note) throw new Error('Say briefly what was done — it becomes the completion evidence.');
    await markStepDone(session.token, communityId, endeavorId, stepId, note);
    setDoneFor(null); setDoneNote('');
  }), [run, session, communityId, endeavorId, doneNote]);

  const complete = useCallback(() => run('complete', async () => {
    if (!session) return;
    await completeEndeavor(session.token, communityId, endeavorId);
  }), [run, session, communityId, endeavorId]);

  const close = useCallback(() => run('close', async () => {
    if (!session) return;
    await closeEndeavor(session.token, communityId, endeavorId, closeReason.trim() || undefined);
    setClosing(false); setCloseReason('');
  }), [run, session, communityId, endeavorId, closeReason]);

  if (!session) return <SectionShell title="Endeavor"><p>Not signed in.</p></SectionShell>;

  const e = detail?.endeavor;
  const stepsTotal = e?.stepsTotal ?? 0;
  const stepsDone = e?.stepsSatisfied ?? 0;
  const outcomeSummary = (detail?.outcomeSummary ?? '').trim();
  const isSatisfied = e?.lifecycle === 'satisfied';
  const hasDeliverables = !!detail?.plan?.steps.some((s) => s.satisfied && !!s.evidence);

  // ── The ONE next-action band, per role × phase ──
  const nextAction = ((): { text: string; strong?: boolean } | null => {
    if (!detail || !e || phase === null) return null;
    if (phase === 'completed') return { text: 'This endeavor is complete. The activity below is its permanent record.' };
    if (phase === 'closed') return { text: 'This endeavor was closed without completing.' };
    if (myPendingDecisions.length > 0) return { text: 'A decision is waiting on you — respond below.', strong: true };
    if (myAllocations.length > 0) return { text: 'Work was assigned to you — review the steps and commit below.', strong: true };
    if (phase === 'needs-plan') {
      return isSteward
        ? { text: "No plan yet. Draft the steps below — the organization's agent may also suggest a draft shortly after adoption.", strong: true }
        : { text: 'No plan yet. You can propose the steps below; a steward then adopts the plan.' };
    }
    if (phase === 'plan-review') {
      return isSteward
        ? { text: proposedByAgent ? "The organization's agent suggested a plan — review it, then adopt (or draft your own below)." : 'A plan draft is waiting for your review — adopt it, or draft an alternative below.', strong: true }
        : { text: 'A plan draft awaits steward adoption.' };
    }
    // execution
    const myOpen = detail.plan?.steps.filter((s) => !s.satisfied && myCommittedSteps.has(s.stepId)) ?? [];
    if (myOpen.length > 0) return { text: `You committed to ${myOpen.length} open step${myOpen.length === 1 ? '' : 's'} — mark each done as you finish it.`, strong: true };
    if (isSteward && allDone) return { text: 'Every step is done — mark the endeavor complete.', strong: true };
    if (!iOfferedAlready && (detail.plan?.steps.some((s) => stepStatus(s.stepId, !!s.satisfied).kind === 'open') ?? false)) {
      return { text: 'Open steps need people — pick the ones you can help with and offer below.' };
    }
    return { text: 'Work is in progress. Watch the plan below — each step shows who has it and its status.' };
  })();

  return (
    <SectionShell
      title={e?.title ?? 'Endeavor'}
      actions={<a href={`/org/${communityId}/work`} className="ghost" style={{ textDecoration: 'none', fontSize: '0.8rem' }}>← Work</a>}
    >
      {error && <p style={{ color: 'var(--color-danger)', fontSize: '0.8rem' }}>{error}</p>}
      {detail === null ? (
        <p style={{ opacity: 0.6, fontSize: '0.85rem' }}>Loading…</p>
      ) : !e ? (
        <p style={{ opacity: 0.7, fontSize: '0.85rem' }}>This endeavor is not visible to you.</p>
      ) : (
        <>
          {/* ── Header: status + progress + outcome ── */}
          <div className="manage-card" style={{ padding: '0.85rem 1rem', marginBottom: '0.8rem' }}>
            <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={StatusPillStyle(e.lifecycle as EndeavorLifecycle)}>{LIFECYCLE_LABEL[e.lifecycle as EndeavorLifecycle] ?? e.lifecycle}</span>
              {stepsTotal > 0 && (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.45rem', fontSize: '0.76rem', color: 'var(--color-text-muted)' }}>
                  <span style={{ width: 90, height: 6, borderRadius: 999, background: 'var(--color-surface-sunken, #eee)', overflow: 'hidden', display: 'inline-block' }}>
                    <span style={{ display: 'block', height: '100%', width: `${Math.round((stepsDone / stepsTotal) * 100)}%`, background: 'var(--color-sage-500, #5f9b76)' }} />
                  </span>
                  {stepsDone}/{stepsTotal} steps done
                </span>
              )}
              <span style={{ fontSize: '0.72rem', opacity: 0.5, marginLeft: 'auto' }}>{shortId(e.endeavorId)}</span>
            </div>
            {(e.outcome?.criteria ?? []).length > 0 && (
              <div style={{ marginTop: '0.55rem', fontSize: '0.82rem' }}>
                <span style={{ fontWeight: 600 }}>Success looks like:</span>
                <ul style={{ margin: '0.25rem 0 0', paddingLeft: '1.2rem' }}>
                  {e.outcome!.criteria!.map((c, i) => <li key={i}>{c}</li>)}
                </ul>
              </div>
            )}
            {/* Steward lifecycle acts */}
            {isSteward && phase === 'execution' && (
              <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.65rem', flexWrap: 'wrap', alignItems: 'center' }}>
                {allDone && (
                  <BusyButton busy={busyId === 'complete'} busyLabel="Completing…" className="btn-primary" style={{ width: 'auto' }} onClick={() => void complete()}>
                    Mark complete
                  </BusyButton>
                )}
                {closing ? (
                  <>
                    <input
                      placeholder="Why close it? (recorded)"
                      value={closeReason}
                      onChange={(ev) => setCloseReason(ev.target.value)}
                      style={{ flex: 1, minWidth: 180, fontSize: '0.8rem', padding: '0.3rem 0.5rem', border: '1px solid var(--color-border)', borderRadius: 6 }}
                    />
                    <BusyButton busy={busyId === 'close'} busyLabel="Closing…" className="btn-danger" style={{ width: 'auto' }} onClick={() => void close()}>Close endeavor</BusyButton>
                    <button type="button" className="ghost" onClick={() => setClosing(false)}>Cancel</button>
                  </>
                ) : (
                  <button type="button" className="ghost" style={{ fontSize: '0.78rem' }} onClick={() => setClosing(true)}>Close without completing…</button>
                )}
              </div>
            )}
          </div>

          {/* ── Your next action ── */}
          {nextAction && (
            <div
              className={nextAction.strong ? 'chat-attention' : 'manage-card'}
              style={{ padding: '0.7rem 1rem', marginBottom: '0.8rem', fontSize: '0.85rem', ...(nextAction.strong ? {} : { color: 'var(--color-text-muted)' }) }}
            >
              <span style={{ fontWeight: 600, marginRight: '0.4rem' }}>{nextAction.strong ? 'Your next action:' : 'Status:'}</span>
              {nextAction.text}
            </div>
          )}

          {/* ── Outcome — the requester-facing result (agent summary + per-step deliverables) ── */}
          {(outcomeSummary || hasDeliverables) && (
            <div className="manage-card" style={{ padding: '0.75rem 0.95rem', marginBottom: '0.8rem', borderLeft: '3px solid var(--color-sage-500, #5f9b76)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.45rem' }}>
                <h3 className="subhead" style={{ margin: 0 }}>Outcome</h3>
                {isSatisfied && (
                  <span className="badge" style={{ fontSize: '0.64rem', color: 'var(--color-sage-700, #047857)', border: '1px solid var(--color-sage-500, #5f9b76)' }}>Completed</span>
                )}
              </div>
              {outcomeSummary ? (
                <p style={{ margin: 0, fontSize: '0.86rem', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{outcomeSummary}</p>
              ) : (
                <p style={{ margin: 0, fontSize: '0.82rem', color: 'var(--color-text-muted)' }}>
                  In progress — the deliverables recorded so far are shown under each step below.
                </p>
              )}
              {hasDeliverables && (
                <details style={{ marginTop: '0.55rem' }}>
                  <summary style={{ cursor: 'pointer', fontSize: '0.78rem', color: 'var(--color-text-muted)' }}>
                    What the agent produced ({detail.plan!.steps.filter((s) => s.satisfied && s.evidence).length})
                  </summary>
                  <ul style={{ margin: '0.45rem 0 0', paddingLeft: '1.1rem', display: 'grid', gap: '0.5rem' }}>
                    {detail.plan!.steps.filter((s) => s.satisfied && s.evidence).map((s) => (
                      <li key={s.stepId} style={{ fontSize: '0.82rem' }}>
                        <div style={{ fontWeight: 600 }}>{s.description}</div>
                        <div style={{ color: 'var(--color-text-muted)', whiteSpace: 'pre-wrap', marginTop: '0.15rem' }}>{s.evidence}</div>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}

          {/* Decisions addressed to THIS approver */}
          {myPendingDecisions.length > 0 && (
            <div className="chat-attention" style={{ marginBottom: '0.8rem' }}>
              <div style={{ fontWeight: 700, fontSize: '0.85rem', marginBottom: '0.4rem' }}>Decisions awaiting you</div>
              {myPendingDecisions.map((d) => (
                <div key={d.decisionId} style={{ display: 'flex', justifyContent: 'space-between', gap: '0.6rem', flexWrap: 'wrap', alignItems: 'center', padding: '0.45rem 0' }}>
                  <span style={{ fontSize: '0.83rem' }}>{d.title ?? d.decisionKind ?? 'Decision requested'}</span>
                  <span style={{ display: 'flex', gap: '0.4rem' }}>
                    <BusyButton busy={busyId === d.decisionId} busyLabel="…" className="btn-primary" style={{ width: 'auto' }} onClick={() => void decide(d.decisionId, 'approved')}>Approve</BusyButton>
                    <BusyButton busy={busyId === d.decisionId} busyLabel="…" className="btn-danger" style={{ width: 'auto' }} onClick={() => void decide(d.decisionId, 'rejected')}>Reject</BusyButton>
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* Work assigned to THIS participant, awaiting their signed commitment */}
          {myAllocations.length > 0 && detail.plan?.status === 'adopted' && (
            <div className="chat-attention" style={{ marginBottom: '0.8rem' }}>
              <div style={{ fontWeight: 700, fontSize: '0.85rem', marginBottom: '0.4rem' }}>Assigned to you</div>
              {myAllocations.map((a) => (
                <div key={a.allocationId} style={{ padding: '0.45rem 0' }}>
                  <ul style={{ margin: '0 0 0.45rem', paddingLeft: '1.2rem', fontSize: '0.82rem' }}>
                    {a.steps.map((sid) => {
                      const st = detail.plan!.steps.find((s) => s.stepId === sid);
                      return <li key={sid}>{st?.description ?? sid}</li>;
                    })}
                  </ul>
                  <BusyButton busy={busyId === a.allocationId} busyLabel="Signing…" className="btn-primary" style={{ width: 'auto' }} onClick={() => void commit(a.allocationId, a.steps)}>
                    Commit to this work
                  </BusyButton>
                  <span style={{ fontSize: '0.72rem', opacity: 0.65, marginLeft: '0.5rem' }}>
                    Signs your acceptance of exactly these steps on plan revision {detail.plan!.revision}. It grants no authority.
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* ── The plan — the spine ── */}
          <h3 className="subhead">Plan</h3>
          {detail.plan && detail.plan.status === 'adopted' ? (
            <div className="manage-card" style={{ padding: '0.75rem 0.95rem', marginBottom: '0.8rem' }}>
              <div style={{ fontSize: '0.72rem', color: 'var(--color-text-muted)', marginBottom: '0.45rem' }}>
                Revision {detail.plan.revision} · adopted{(detail.plan.proposedBy ?? '').toLowerCase() === communityId ? " · drafted by the organization's agent" : ''}
              </div>
              {detail.plan.steps.map((s) => {
                const st = stepStatus(s.stepId, !!s.satisfied);
                const canMarkDone = !s.satisfied && phase === 'execution' && (myCommittedSteps.has(s.stepId) || isSteward);
                const canOffer = st.kind === 'open' && phase === 'execution';
                return (
                  <div key={s.stepId} style={{ padding: '0.45rem 0', borderBottom: '1px solid var(--color-border)' }}>
                    <div style={{ display: 'flex', gap: '0.55rem', alignItems: 'baseline', fontSize: '0.84rem' }}>
                      {/* Leading status marker — ALWAYS a clean glyph: ✓ done, ○ still to do.
                          Offering help is a separate, explicitly-labelled control on the right, so an
                          open step never shows a bare/ambiguous checkbox in the marker slot. */}
                      <span
                        aria-hidden
                        style={{ flex: 'none', width: 16, textAlign: 'center', fontSize: '0.95rem', lineHeight: 1, color: s.satisfied ? 'var(--color-sage-700, #047857)' : 'var(--color-text-faint)' }}
                      >
                        {s.satisfied ? '✓' : '○'}
                      </span>
                      <span style={{ flex: 1, ...(s.satisfied ? { textDecoration: 'line-through', opacity: 0.6 } : {}) }}>{s.description}</span>
                      <span className="badge" style={{ flex: 'none', fontSize: '0.64rem', border: '1px solid var(--color-border)', color: 'var(--color-text-muted)' }}>
                        {STEP_KIND_LABEL[s.kind] ?? s.kind}
                      </span>
                      <span style={{ flex: 'none', fontSize: '0.72rem', fontWeight: st.kind === 'done' ? 600 : 400, color: st.kind === 'done' ? 'var(--color-sage-700, #047857)' : 'var(--color-text-muted)' }}>
                        {st.kind === 'done' ? 'Done'
                          : st.kind === 'committed' ? `${label(st.who)} committed`
                          : st.kind === 'assigned' ? `assigned to ${label(st.who)}`
                          : st.kind === 'offered' ? `${label(st.who)} offered`
                          : 'To do'}
                      </span>
                      {canOffer && (
                        <label style={{ flex: 'none', display: 'inline-flex', gap: '0.28rem', alignItems: 'center', fontSize: '0.72rem', color: 'var(--color-text-muted)', cursor: 'pointer', whiteSpace: 'nowrap' }} title="Select to offer help with this step">
                          <input
                            type="checkbox"
                            checked={offerSteps[s.stepId] === true}
                            onChange={(ev) => setOfferSteps((cur) => ({ ...cur, [s.stepId]: ev.target.checked }))}
                          />
                          offer
                        </label>
                      )}
                      {canMarkDone && doneFor !== s.stepId && (
                        <button type="button" className="ghost" style={{ flex: 'none', fontSize: '0.74rem' }} onClick={() => { setDoneFor(s.stepId); setDoneNote(''); }}>
                          Mark done
                        </button>
                      )}
                    </div>
                    {canMarkDone && doneFor === s.stepId && (
                      <div style={{ display: 'flex', gap: '0.4rem', marginTop: '0.4rem', alignItems: 'center' }}>
                        <input
                          autoFocus
                          placeholder="What was done? (recorded as completion evidence)"
                          value={doneNote}
                          onChange={(ev) => setDoneNote(ev.target.value)}
                          style={{ flex: 1, fontSize: '0.8rem', padding: '0.32rem 0.5rem', border: '1px solid var(--color-border)', borderRadius: 6 }}
                        />
                        <BusyButton busy={busyId === `done:${s.stepId}`} busyLabel="Saving…" className="btn-primary" style={{ width: 'auto' }} onClick={() => void markDone(s.stepId)}>
                          Done
                        </BusyButton>
                        <button type="button" className="ghost" onClick={() => setDoneFor(null)}>Cancel</button>
                      </div>
                    )}
                  </div>
                );
              })}
              {phase === 'execution' && Object.values(offerSteps).some(Boolean) && (
                <div style={{ marginTop: '0.55rem' }}>
                  <BusyButton busy={busyId === 'offer'} busyLabel="Offering…" className="btn-primary" style={{ width: 'auto' }} onClick={() => void offer()}>
                    Offer to help ({Object.values(offerSteps).filter(Boolean).length} step{Object.values(offerSteps).filter(Boolean).length === 1 ? '' : 's'})
                  </BusyButton>
                  <span style={{ fontSize: '0.72rem', opacity: 0.6, marginLeft: '0.5rem' }}>
                    The coordinator then assigns the work to you, and you confirm by committing.
                  </span>
                </div>
              )}
            </div>
          ) : latestProposed ? (
            <div className="manage-card" style={{ padding: '0.75rem 0.95rem', marginBottom: '0.8rem', border: '1px solid var(--color-amber-400)', background: 'var(--color-amber-50, #fffbeb)' }}>
              <div style={{ fontSize: '0.76rem', marginBottom: '0.45rem', display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                <span className="badge" style={{ border: '1px solid var(--color-amber-400)', color: 'var(--color-amber-700, #b45309)', fontSize: '0.66rem' }}>
                  {proposedByAgent ? "Suggested by the organization's agent" : `Draft by ${label(latestProposed.proposedBy ?? '')}`}
                </span>
                <span style={{ color: 'var(--color-text-muted)' }}>Revision {latestProposed.revision} — awaiting adoption</span>
              </div>
              {latestProposed.steps.map((s, i) => (
                <div key={s.stepId} style={{ display: 'flex', gap: '0.55rem', alignItems: 'baseline', padding: '0.32rem 0', borderBottom: '1px solid var(--color-border)', fontSize: '0.84rem' }}>
                  <span style={{ flex: 'none', width: 14, textAlign: 'center', color: 'var(--color-text-faint)' }}>{i + 1}.</span>
                  <span style={{ flex: 1 }}>{s.description}</span>
                  <span className="badge" style={{ flex: 'none', fontSize: '0.64rem', border: '1px solid var(--color-border)', color: 'var(--color-text-muted)' }}>
                    {STEP_KIND_LABEL[s.kind] ?? s.kind}
                  </span>
                </div>
              ))}
              {isSteward ? (
                <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.55rem', alignItems: 'center' }}>
                  <BusyButton busy={busyId === 'adoptPlan'} busyLabel="Adopting…" className="btn-primary" style={{ width: 'auto' }} onClick={() => void adoptProposed()}>
                    Adopt this plan
                  </BusyButton>
                  <span style={{ fontSize: '0.72rem', opacity: 0.65 }}>Adoption locks this exact revision — or draft an alternative below.</span>
                </div>
              ) : (
                <p style={{ fontSize: '0.74rem', opacity: 0.65, margin: '0.45rem 0 0' }}>A steward adopts the plan; work then starts against its steps.</p>
              )}
            </div>
          ) : null}

          {/* Step composer — needs-plan always; plan-review as the steward's alternative-draft path */}
          {(phase === 'needs-plan' || (phase === 'plan-review' && isSteward)) && (
            <div className="manage-card" style={{ padding: '0.75rem 0.95rem', marginBottom: '0.8rem' }}>
              <div style={{ fontSize: '0.8rem', fontWeight: 600, marginBottom: '0.45rem' }}>
                {phase === 'plan-review' ? 'Draft an alternative plan' : 'Draft the plan'}
              </div>
              {draftSteps.map((s, i) => (
                <div key={i} style={{ display: 'flex', gap: '0.4rem', marginBottom: '0.4rem', alignItems: 'center' }}>
                  <select
                    value={s.kind}
                    onChange={(ev) => setDraftSteps((cur) => cur.map((x, j) => (j === i ? { ...x, kind: ev.target.value as StepKind } : x)))}
                    style={{ flex: 'none', fontSize: '0.78rem', padding: '0.3rem 0.4rem', border: '1px solid var(--color-border)', borderRadius: 6 }}
                  >
                    {STEP_KINDS.map((k) => <option key={k} value={k}>{STEP_KIND_LABEL[k] ?? k}</option>)}
                  </select>
                  <input
                    placeholder={`Step ${i + 1} — what gets done`}
                    value={s.description}
                    onChange={(ev) => setDraftSteps((cur) => cur.map((x, j) => (j === i ? { ...x, description: ev.target.value } : x)))}
                    style={{ flex: 1, fontSize: '0.82rem', padding: '0.35rem 0.55rem', border: '1px solid var(--color-border)', borderRadius: 6 }}
                  />
                  {draftSteps.length > 1 && (
                    <button type="button" className="ghost" title="Remove step" onClick={() => setDraftSteps((cur) => cur.filter((_, j) => j !== i))}>✕</button>
                  )}
                </div>
              ))}
              <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.2rem' }}>
                <button type="button" className="btn" style={{ width: 'auto' }} onClick={() => setDraftSteps((cur) => [...cur, { kind: 'contribution', description: '' }])}>
                  ＋ Add step
                </button>
                <BusyButton busy={busyId === 'plan'} busyLabel="Proposing…" className="btn-primary" style={{ width: 'auto' }} onClick={() => void submitPlan()}>
                  {isSteward ? 'Propose + adopt plan' : 'Propose plan'}
                </BusyButton>
              </div>
            </div>
          )}

          {/* Offers awaiting the coordinator's assignment */}
          {(detail.proposals ?? []).filter((p) => p.status === 'open').length > 0 && (
            <>
              <h3 className="subhead">Offers to help</h3>
              <div className="manage-card" style={{ padding: '0.6rem 0.95rem', marginBottom: '0.8rem' }}>
                {(detail.proposals ?? []).filter((p) => p.status === 'open').map((p) => (
                  <div key={p.proposalId} style={{ display: 'flex', justifyContent: 'space-between', gap: '0.6rem', flexWrap: 'wrap', alignItems: 'center', padding: '0.35rem 0', borderBottom: '1px solid var(--color-border)', fontSize: '0.83rem' }}>
                    <span>
                      <b>{label(p.proposer)}</b>
                      <span style={{ opacity: 0.65 }}> · {p.steps.length} step{p.steps.length === 1 ? '' : 's'}{p.note ? ` — ${p.note}` : ''}</span>
                    </span>
                    {isSteward && (
                      <BusyButton busy={busyId === p.proposalId} busyLabel="Assigning…" className="btn-primary" style={{ width: 'auto' }} onClick={() => void allocate(p.proposalId, p.proposer, p.steps)}>
                        Assign to {label(p.proposer)}
                      </BusyButton>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}

          {/* ── Secondary rails ── */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '0.8rem', marginBottom: '0.8rem' }}>
            <div>
              <h3 className="subhead">People</h3>
              <div className="manage-card" style={{ padding: '0.6rem 0.95rem' }}>
                {(detail.participations ?? []).length === 0 ? (
                  <p style={{ fontSize: '0.8rem', opacity: 0.7, margin: 0 }}>No participants yet.</p>
                ) : (detail.participations ?? []).map((p) => (
                  <div key={p.participationId} style={{ display: 'flex', gap: '0.5rem', padding: '0.25rem 0', fontSize: '0.83rem' }}>
                    <b>{p.participantName ?? label(p.participant)}</b>
                    <span style={{ opacity: 0.6 }}>· {p.role}</span>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <h3 className="subhead">Commitments</h3>
              <div className="manage-card" style={{ padding: '0.6rem 0.95rem' }}>
                {(detail.commitments ?? []).length === 0 ? (
                  <p style={{ fontSize: '0.8rem', opacity: 0.7, margin: 0 }}>None signed yet.</p>
                ) : (detail.commitments ?? []).map((c) => (
                  <div key={c.commitmentId} style={{ padding: '0.28rem 0', fontSize: '0.82rem' }}>
                    <b>{label(c.participant)}</b>
                    <span style={{ opacity: 0.65 }}>
                      {' '}· {c.steps.length} step{c.steps.length === 1 ? '' : 's'} · {c.status}
                      {c.bounds?.deadline ? ` · due ${new Date(c.bounds.deadline).toLocaleDateString()}` : ''}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Activity — the ordered event log (spec 332 §7 provenance), collapsed by default */}
          <h3 className="subhead" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            Activity
            <button type="button" className="ghost" style={{ fontSize: '0.74rem' }} onClick={() => setShowActivity((v) => !v)}>
              {showActivity ? 'Hide' : `Show (${(detail.events ?? []).length})`}
            </button>
          </h3>
          {showActivity && (
            (detail.events ?? []).length === 0 ? (
              <p style={{ fontSize: '0.8rem', opacity: 0.7 }}>No events recorded.</p>
            ) : (
              <div className="manage-card" style={{ padding: '0.6rem 0.95rem' }}>
                {(detail.events ?? []).map((ev, i) => (
                  <div key={i} style={{ display: 'flex', gap: '0.6rem', padding: '0.3rem 0', borderBottom: '1px solid var(--color-border)', fontSize: '0.8rem' }}>
                    <span style={{ flex: 'none', opacity: 0.55, minWidth: 130 }}>{new Date(ev.at).toLocaleString()}</span>
                    <span style={{ flex: 1 }}>
                      <b>{EVENT_LABEL[ev.type] ?? ev.type}</b>
                      {ev.summary && <span style={{ opacity: 0.7 }}> — {ev.summary}</span>}
                      {ev.actor && <span style={{ opacity: 0.55 }}> · {ev.actor.toLowerCase() === communityId ? "the organization's agent" : label(ev.actor)}</span>}
                    </span>
                  </div>
                ))}
              </div>
            )
          )}
        </>
      )}
    </SectionShell>
  );
}
