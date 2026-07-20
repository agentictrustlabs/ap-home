'use client';
// Person My Work (spec 334 §7): the principal's own coordination facts across
// every org they belong to — allocations awaiting their signed commitment
// (with a Commit action posting endeavor.commit), active commitments, and
// pending decision requests. Entries are projected through the portable
// @agenticprimitives/home contracts (HomeContributionEntryV1 /
// HomeDecisionCardV1) and rendered as action-card-style rows: pressing an
// action only PROPOSES a signed lifecycle transition — it grants nothing.
import { useCallback, useEffect, useMemo, useState } from 'react';
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
} from '../../../lib/work-client';
import { NewRequestComposer } from './NewRequestComposer';
import { useRelatedOrgs } from './useWork';

interface OrgWorkBundle {
  org: string;
  orgName?: string;
  allocations: AllocationRow[];
  entries: HomeContributionEntryV1[];
  decisions: HomeDecisionCardV1[];
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
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);

  const load = useCallback(async () => {
    if (!session || !agentAddress) return;
    try {
      const results = await Promise.all(orgs.map(async (o): Promise<OrgWorkBundle | null> => {
        try {
          const r = await fetchWorkList(session.token, o.orgAgent);
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
          return { org: o.orgAgent, ...(o.orgName ? { orgName: o.orgName } : {}), allocations, entries, decisions };
        } catch { return null; }
      }));
      setBundles(results.filter((b): b is OrgWorkBundle => b !== null));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [session, agentAddress, orgs]);

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

  const { awaiting, active, decisions } = useMemo(() => {
    const all = bundles ?? [];
    return {
      awaiting: all.flatMap((b) => b.entries.filter((e) => e.status === 'allocated').map((e) => ({ b, e }))),
      active: all.flatMap((b) => b.entries.filter((e) => e.status !== 'allocated').map((e) => ({ b, e }))),
      decisions: all.flatMap((b) => b.decisions.map((c) => ({ b, c }))),
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

      {composerOpen && (
        <div style={{ marginBottom: '1rem' }}>
          <NewRequestComposer onSubmitted={() => void load()} />
        </div>
      )}

      {bundles === null ? (
        <p style={{ opacity: 0.6, fontSize: '0.85rem' }}>Loading…</p>
      ) : (
        <>
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
