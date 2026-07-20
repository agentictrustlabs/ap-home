'use client';
// Org Work — Endeavor detail (spec 334 §6): outcome specification, adopted
// plan steps with per-step satisfied status (the seven-state facts projected
// honestly — allocated ≠ committed ≠ performing ≠ satisfied), participants +
// roles, commitments, and the Provenance trail — the event log (request →
// adoption → plan revisions → commitments → satisfied steps) rendered in
// order. Commit is the PARTICIPANT's own signed act binding the exact adopted
// plan revision hash (spec 332 §9.2); it grants nothing.
import { useCallback, useEffect, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { useSession } from '../../../context/session';
import { SectionShell } from '../SectionShell';
import { BusyButton } from '../../shared/BusyButton';
import { resolveVia, signHashFor } from '../../../home/onboarding';
import { agentLabel, shortId } from '../../../home/use-inbox';
import {
  commitContribution,
  fetchWorkDetail,
  recordDecision,
  type WorkDetailResponse,
} from '../../../lib/work-client';

const EVENT_LABEL: Record<string, string> = {
  EndeavorRequestSubmitted: 'Request submitted',
  EndeavorRequestDeclined: 'Request declined',
  EndeavorAdopted: 'Adopted as an endeavor',
  OutcomeRevised: 'Outcome specification revised',
  PlanProposed: 'Plan revision proposed',
  PlanAdopted: 'Plan revision adopted',
  PlanRejected: 'Plan revision rejected',
  ParticipationInvited: 'Participant invited',
  ParticipationAsserted: 'Participation asserted',
  ParticipationWithdrawn: 'Participation withdrawn',
  ContributionProposed: 'Contribution proposed',
  ContributionAllocated: 'Contribution allocated',
  ContributionCommitted: 'Commitment signed',
  CommitmentWithdrawn: 'Commitment withdrawn',
  ContributionReallocated: 'Contribution reallocated',
  PlanStepSatisfied: 'Plan step satisfied',
  MilestoneAchieved: 'Milestone achieved',
  EndeavorSatisfied: 'Endeavor satisfied',
  EndeavorAbandoned: 'Endeavor abandoned',
};

export function OrgWorkEndeavorDetail({ org, endeavorId }: { org: Address; endeavorId: string }) {
  const { session, profile: homeProfile, agentAddress } = useSession();
  const communityId = org.toLowerCase();
  const [detail, setDetail] = useState<WorkDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

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

  const me = (agentAddress ?? '').toLowerCase();
  const myAllocations = (detail?.allocations ?? []).filter(
    (a) => a.participant.toLowerCase().endsWith(me) &&
      !(detail?.commitments ?? []).some((c) => c.allocationRef === a.allocationId && c.status === 'active'),
  );
  const myPendingDecisions = (detail?.decisions ?? []).filter(
    (d) => d.status === 'pending' && d.approver.toLowerCase().endsWith(me),
  );

  // The participant signs the commitment digest with their own credential —
  // the serving plane verifies it fail-closed against the adopted plan hash.
  const commit = useCallback(async (allocationId: string, steps: string[]) => {
    if (!session || !agentAddress || !detail?.plan) return;
    setBusyId(allocationId); setError(null);
    try {
      const sign = await signHashFor(resolveVia(homeProfile?.credential, session.via), agentAddress, { token: session.token });
      await commitContribution(session.token, communityId, {
        endeavorId,
        allocationRef: allocationId,
        participant: agentAddress,
        planRef: { planId: detail.plan.planId, revision: detail.plan.revision, hash: detail.plan.contentHash },
        steps,
      }, sign);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusyId(null); }
  }, [session, agentAddress, homeProfile?.credential, detail, communityId, endeavorId, load]);

  const decide = useCallback(async (decisionId: string, outcome: 'approved' | 'rejected') => {
    if (!session) return;
    setBusyId(decisionId); setError(null);
    try {
      await recordDecision(session.token, communityId, endeavorId, decisionId, outcome);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusyId(null); }
  }, [session, communityId, endeavorId, load]);

  if (!session) return <SectionShell title="Endeavor"><p>Not signed in.</p></SectionShell>;

  const e = detail?.endeavor;

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
          <div className="manage-card" style={{ padding: '0.8rem 1rem', marginBottom: '0.8rem' }}>
            <div style={{ fontSize: '0.78rem', opacity: 0.65, marginBottom: '0.3rem' }}>
              {e.lifecycle} · endeavor {shortId(e.endeavorId)}
            </div>
            <div style={{ fontSize: '0.86rem' }}>
              <b>Outcome:</b> {e.outcome?.description ?? 'No outcome specification recorded yet.'}
            </div>
            {(e.outcome?.criteria ?? []).length > 0 && (
              <ul style={{ margin: '0.35rem 0 0', paddingLeft: '1.2rem', fontSize: '0.8rem' }}>
                {e.outcome!.criteria!.map((c, i) => <li key={i}>{c}</li>)}
              </ul>
            )}
          </div>

          {/* Pending decisions addressed to THIS approver (spec 333) */}
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

          {/* Allocations offered to THIS participant, awaiting their signed commitment */}
          {myAllocations.length > 0 && detail.plan?.status === 'adopted' && (
            <div className="chat-attention" style={{ marginBottom: '0.8rem' }}>
              <div style={{ fontWeight: 700, fontSize: '0.85rem', marginBottom: '0.4rem' }}>Allocated to you — commitment awaited</div>
              {myAllocations.map((a) => (
                <div key={a.allocationId} style={{ display: 'flex', justifyContent: 'space-between', gap: '0.6rem', flexWrap: 'wrap', alignItems: 'center', padding: '0.45rem 0' }}>
                  <span style={{ fontSize: '0.83rem' }}>
                    {a.steps.length} plan step{a.steps.length === 1 ? '' : 's'} · plan revision {detail.plan!.revision}
                  </span>
                  <BusyButton busy={busyId === a.allocationId} busyLabel="Signing…" className="btn-primary" style={{ width: 'auto' }} onClick={() => void commit(a.allocationId, a.steps)}>
                    Sign commitment
                  </BusyButton>
                </div>
              ))}
              <p style={{ fontSize: '0.7rem', opacity: 0.6, margin: '0.3rem 0 0' }}>
                Committing signs your acceptance against this exact plan revision. It grants no authority.
              </p>
            </div>
          )}

          {/* Adopted plan steps + satisfied status */}
          <h3 className="subhead">Plan</h3>
          {detail.plan ? (
            <div className="manage-card" style={{ padding: '0.7rem 0.95rem', marginBottom: '0.8rem' }}>
              <div style={{ fontSize: '0.74rem', opacity: 0.6, marginBottom: '0.4rem' }}>
                Revision {detail.plan.revision} · {detail.plan.status} · hash {detail.plan.contentHash.slice(0, 10)}…
              </div>
              {detail.plan.steps.map((s) => (
                <div key={s.stepId} style={{ display: 'flex', gap: '0.5rem', alignItems: 'baseline', padding: '0.3rem 0', borderBottom: '1px solid var(--color-border)', fontSize: '0.83rem' }}>
                  <span className="badge" style={{ flex: 'none', fontSize: '0.66rem', border: '1px solid var(--color-border)' }}>{s.kind}</span>
                  <span style={{ flex: 1 }}>{s.description}</span>
                  <span style={{ flex: 'none', fontSize: '0.72rem', color: s.satisfied ? 'var(--color-sage-700, #047857)' : 'var(--color-text-muted)' }}>
                    {s.satisfied ? 'satisfied' : 'open'}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p style={{ fontSize: '0.8rem', opacity: 0.7, marginBottom: '0.8rem' }}>No plan adopted yet.</p>
          )}

          {/* Participants + roles */}
          <h3 className="subhead">Participants</h3>
          {(detail.participations ?? []).length === 0 ? (
            <p style={{ fontSize: '0.8rem', opacity: 0.7, marginBottom: '0.8rem' }}>No participants yet.</p>
          ) : (
            <div className="manage-card" style={{ padding: '0.6rem 0.95rem', marginBottom: '0.8rem' }}>
              {(detail.participations ?? []).map((p) => (
                <div key={p.participationId} style={{ display: 'flex', gap: '0.5rem', padding: '0.25rem 0', fontSize: '0.83rem' }}>
                  <b>{p.participantName ?? agentLabel(p.participant)}</b>
                  <span style={{ opacity: 0.6 }}>· {p.role}</span>
                </div>
              ))}
            </div>
          )}

          {/* Commitments — the signed facts, distinct from allocations */}
          <h3 className="subhead">Commitments</h3>
          {(detail.commitments ?? []).length === 0 ? (
            <p style={{ fontSize: '0.8rem', opacity: 0.7, marginBottom: '0.8rem' }}>No commitments signed yet.</p>
          ) : (
            <div className="manage-card" style={{ padding: '0.6rem 0.95rem', marginBottom: '0.8rem' }}>
              {(detail.commitments ?? []).map((c) => (
                <div key={c.commitmentId} style={{ padding: '0.3rem 0', borderBottom: '1px solid var(--color-border)', fontSize: '0.82rem' }}>
                  <b>{agentLabel(c.participant)}</b>
                  <span style={{ opacity: 0.65 }}>
                    {' '}· {c.steps.length} step{c.steps.length === 1 ? '' : 's'} · plan revision {c.planRef.revision} · {c.status}
                    {c.bounds?.deadline ? ` · due ${new Date(c.bounds.deadline).toLocaleDateString()}` : ''}
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* Activity trail — the ordered event log (spec 332 §7 provenance) */}
          <h3 className="subhead">Provenance trail</h3>
          {(detail.events ?? []).length === 0 ? (
            <p style={{ fontSize: '0.8rem', opacity: 0.7 }}>No events recorded.</p>
          ) : (
            <div className="manage-card" style={{ padding: '0.6rem 0.95rem' }}>
              {(detail.events ?? []).map((ev, i) => (
                <div key={i} style={{ display: 'flex', gap: '0.6rem', padding: '0.3rem 0', borderBottom: '1px solid var(--color-border)', fontSize: '0.8rem' }}>
                  <span style={{ flex: 'none', opacity: 0.55, minWidth: 130 }}>{new Date(ev.at).toLocaleString()}</span>
                  <span style={{ flex: 1 }}>
                    <b>{EVENT_LABEL[ev.type] ?? ev.type}</b>
                    {ev.summary && <span style={{ opacity: 0.7 }}> — {ev.summary}</span>}
                    {ev.actor && <span style={{ opacity: 0.55 }}> · {agentLabel(ev.actor)}</span>}
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </SectionShell>
  );
}
