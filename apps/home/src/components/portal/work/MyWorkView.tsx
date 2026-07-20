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
import { validateHomeContributionEntry, validateHomeDecisionCard } from '@agenticprimitives/home';
import { useSession } from '../../../context/session';
import { SectionShell } from '../SectionShell';
import { BusyButton } from '../../shared/BusyButton';
import { resolveVia, signHashFor } from '../../../home/onboarding';
import {
  commitContribution,
  fetchWorkList,
  recordDecision,
  projectAllocationEntry,
  projectCommitmentEntry,
  projectDecisionCard,
  type AllocationRow,
  type EndeavorRequestRow,
  type EndeavorRow,
} from '../../../lib/work-client';
import { NewRequestComposer } from './NewRequestComposer';
import { useRelatedOrgs, useReEnableInteractions } from './useWork';

interface OrgWorkBundle {
  org: string;
  orgName?: string;
  allocations: AllocationRow[];
  entries: HomeContributionEntryV1[];
  decisions: HomeDecisionCardV1[];
  /** Requests THIS viewer submitted to the org (§12 — the requester sees their own). */
  myRequests: EndeavorRequestRow[];
  /** The org's visible endeavors — used to resolve adopted requests to their endeavor. */
  endeavors: EndeavorRow[];
}

/** An org whose interactions grant predates the vault:coordination.* scopes (the serving
 *  plane's 409 needsReEnable signal) — a steward re-signs via the re-enable ceremony. */
interface StaleOrg {
  org: string;
  orgName?: string;
  steward: boolean;
}

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
    <div className="manage-card" style={{ padding: '0.7rem 0.95rem', display: 'flex', justifyContent: 'space-between', gap: '0.6rem', flexWrap: 'wrap', alignItems: 'center' }}>
      <div style={{ minWidth: 0 }}>
        <a href={detailHref} style={{ fontWeight: 600, fontSize: '0.86rem', textDecoration: 'none', color: 'inherit' }}>
          {entry.endeavorTitle}
        </a>
        <div style={{ fontSize: '0.73rem', opacity: 0.65, marginTop: '0.15rem' }}>
          {orgName ? `${orgName} · ` : ''}
          {entry.status} · {entry.stepIds.length} plan step{entry.stepIds.length === 1 ? '' : 's'}
          {entry.planRef.revision > 0 ? ` · plan revision ${entry.planRef.revision}` : ''}
          {entry.deadline ? ` · due ${new Date(entry.deadline).toLocaleDateString()}` : ''}
        </div>
      </div>
      {action}
    </div>
  );
}

export function MyWorkView() {
  const { session, profile: homeProfile, agentAddress } = useSession();
  const orgs = useRelatedOrgs(session);
  const [bundles, setBundles] = useState<OrgWorkBundle[] | null>(null);
  const [staleOrgs, setStaleOrgs] = useState<StaleOrg[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const reEnable = useReEnableInteractions();

  const load = useCallback(async () => {
    if (!session || !agentAddress) return;
    const stale: StaleOrg[] = [];
    try {
      const results = await Promise.all(orgs.map(async (o): Promise<OrgWorkBundle | null> => {
        try {
          const r = await fetchWorkList(session.token, o.orgAgent);
          if (r.needsReEnable === true) {
            stale.push({ org: o.orgAgent, ...(o.orgName ? { orgName: o.orgName } : {}), steward: r.steward === true || o.relationship === 'steward' });
            return null;
          }
          if (r.member === false || r.ok === false) return null;
          const allocations = r.mine?.allocations ?? [];
          const entries = [
            ...allocations.map((a) => projectAllocationEntry(o.orgAgent, agentAddress, a)),
            ...(r.mine?.commitments ?? [])
              .filter((c) => c.status === 'active')
              .map((c) => projectCommitmentEntry(o.orgAgent, agentAddress, c)),
            // Allocations may precede plan adoption (no planRef yet) — render them anyway;
            // committed entries must pass the portable contract's fail-closed validation.
          ].filter((e) => e.status === 'allocated' || validateHomeContributionEntry(e).length === 0);
          const decisions = (r.mine?.decisions ?? [])
            .filter((d) => d.status === 'pending')
            .map((d) => projectDecisionCard(o.orgAgent, d))
            .filter((c) => validateHomeDecisionCard(c).length === 0);
          const myRequests = (r.requests ?? []).filter((q) => q.requester.toLowerCase() === agentAddress.toLowerCase());
          return { org: o.orgAgent, ...(o.orgName ? { orgName: o.orgName } : {}), allocations, entries, decisions, myRequests, endeavors: r.endeavors ?? [] };
        } catch { return null; }
      }));
      setBundles(results.filter((b): b is OrgWorkBundle => b !== null));
      setStaleOrgs(stale);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [session, agentAddress, orgs]);

  const runReEnable = useCallback(async (s: StaleOrg) => {
    setBusyId(`reenable:${s.org}`); setError(null);
    const r = await reEnable(s.org as Address);
    if (!r.ok) setError(r.error ?? 'could not re-enable storage');
    else await load();
    setBusyId(null);
  }, [reEnable, load]);

  useEffect(() => { void load(); }, [load]);

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

  const decide = useCallback(async (bundle: OrgWorkBundle, card: HomeDecisionCardV1, outcome: 'approved' | 'rejected') => {
    if (!session) return;
    setBusyId(card.decisionId); setError(null);
    try {
      await recordDecision(session.token, bundle.org, card.endeavorId, card.decisionId, outcome);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusyId(null); }
  }, [session, load]);

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

  if (!session) return <SectionShell title="My Work"><p>Not signed in.</p></SectionShell>;

  return (
    <SectionShell
      title="My Work"
      actions={
        <button type="button" className="btn-primary" style={{ width: 'auto', fontSize: '0.8rem', padding: '0.35rem 0.8rem' }} onClick={() => setComposerOpen((v) => !v)}>
          {composerOpen ? 'Close' : 'New request'}
        </button>
      }
    >
      {error && <p style={{ color: 'var(--color-danger)', fontSize: '0.8rem' }}>{error}</p>}

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
        <p style={{ opacity: 0.6, fontSize: '0.85rem' }}>Loading…</p>
      ) : (
        <>
          <h3 className="subhead">Your requests</h3>
          {myRequests.length === 0 ? (
            <p style={{ fontSize: '0.8rem', opacity: 0.7, marginBottom: '0.9rem' }}>
              No requests yet — use New request to state a goal for an organization or person.
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.45rem', marginBottom: '0.9rem' }}>
              {myRequests.map(({ b, q }) => {
                // Adopted → resolve the Endeavor it became (the request row's endeavorId, or the
                // endeavor whose requestRef points back at this request).
                const endeavorId = q.endeavorId ?? b.endeavors.find((e) => e.requestRef === q.requestId)?.endeavorId;
                const endeavor = endeavorId ? b.endeavors.find((e) => e.endeavorId === endeavorId) : undefined;
                const status = q.status ?? 'pending';
                return (
                  <div key={`${b.org}:${q.requestId}`} className="manage-card" style={{ padding: '0.7rem 0.95rem', display: 'flex', justifyContent: 'space-between', gap: '0.6rem', flexWrap: 'wrap', alignItems: 'center' }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: '0.86rem' }}>{q.goal}</div>
                      <div style={{ fontSize: '0.73rem', opacity: 0.65, marginTop: '0.15rem' }}>
                        {b.orgName ? `${b.orgName} · ` : ''}
                        {new Date(q.submittedAt).toLocaleString()}
                        {status === 'pending' && ' · awaiting triage'}
                        {status === 'declined' && ` · declined${q.reason ? ` — ${q.reason}` : ''}`}
                        {status === 'adopted' && endeavor && ` · adopted — ${endeavor.lifecycle}`}
                        {status === 'adopted' && !endeavor && ' · adopted as an endeavor'}
                      </div>
                    </div>
                    {status === 'adopted' && endeavorId && (
                      <a href={`/org/${b.org}/work/${encodeURIComponent(endeavorId)}`} className="btn" style={{ width: 'auto', fontSize: '0.76rem', textDecoration: 'none' }}>
                        View endeavor
                      </a>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          <h3 className="subhead">Awaiting your commitment</h3>
          {awaiting.length === 0 ? (
            <p style={{ fontSize: '0.8rem', opacity: 0.7, marginBottom: '0.9rem' }}>No allocations awaiting your commitment.</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.45rem', marginBottom: '0.9rem' }}>
              {awaiting.map(({ b, e }) => (
                <EntryCard
                  key={`${b.org}:${e.allocationId}`}
                  entry={e}
                  {...(b.orgName ? { orgName: b.orgName } : {})}
                  action={
                    <BusyButton busy={busyId === e.allocationId} busyLabel="Signing…" className="btn-primary" style={{ width: 'auto' }} onClick={() => void commit(b, e)}>
                      Commit
                    </BusyButton>
                  }
                />
              ))}
            </div>
          )}

          <h3 className="subhead">Decisions awaiting you</h3>
          {decisions.length === 0 ? (
            <p style={{ fontSize: '0.8rem', opacity: 0.7, marginBottom: '0.9rem' }}>No pending decision requests.</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.45rem', marginBottom: '0.9rem' }}>
              {decisions.map(({ b, c }) => (
                <div key={`${b.org}:${c.decisionId}`} className="manage-card" style={{ padding: '0.7rem 0.95rem', display: 'flex', justifyContent: 'space-between', gap: '0.6rem', flexWrap: 'wrap', alignItems: 'center' }}>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: '0.86rem' }}>{c.title}</div>
                    <div style={{ fontSize: '0.73rem', opacity: 0.65 }}>
                      {b.orgName ? `${b.orgName} · ` : ''}{c.decisionKind}
                      {c.dueAt ? ` · due ${new Date(c.dueAt).toLocaleDateString()}` : ''}
                    </div>
                  </div>
                  <span style={{ display: 'flex', gap: '0.4rem' }}>
                    {c.allowedActions.map((a) => (
                      <BusyButton
                        key={a.actionId}
                        busy={busyId === c.decisionId}
                        busyLabel="…"
                        className={a.style === 'destructive' ? 'btn-danger' : 'btn-primary'}
                        style={{ width: 'auto' }}
                        onClick={() => void decide(b, c, a.transition === 'approve' ? 'approved' : 'rejected')}
                      >
                        {a.label}
                      </BusyButton>
                    ))}
                  </span>
                </div>
              ))}
            </div>
          )}

          <h3 className="subhead">Active commitments</h3>
          {active.length === 0 ? (
            <p style={{ fontSize: '0.8rem', opacity: 0.7 }}>No active commitments.</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.45rem' }}>
              {active.map(({ b, e }) => (
                <EntryCard key={`${b.org}:${e.commitmentId ?? e.allocationId}`} entry={e} {...(b.orgName ? { orgName: b.orgName } : {})} />
              ))}
            </div>
          )}
        </>
      )}
    </SectionShell>
  );
}
