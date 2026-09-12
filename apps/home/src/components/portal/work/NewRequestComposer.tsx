'use client';
// Home Request composer (spec 334 §5) — goal-first, intent-first (ADR-0044):
// the PRIMARY field is a free-text goal statement; no tool names, plans, or
// call sequences anywhere. The submission produces an EndeavorRequest posted
// to the target principal's serving plane (endeavor.request); it lands as a
// pending row in the target's Requests / Triage view.
import { useCallback, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { useSession } from '../../../context/session';
import { isReEnableError, submitEndeavorRequest } from '../../../lib/work-client';
import { searchAgentsKb, type AgentSearchHit } from '../../../lib/agent-search';
import { BusyButton } from '../../shared/BusyButton';
import { useRelatedOrgs, useReEnableInteractions } from './useWork';
import { BasisLine } from '../BasisLine';

export function NewRequestComposer({
  /** When set (org Work section), the org is the default target. */
  defaultTarget,
  defaultTargetName,
  onSubmitted,
}: {
  defaultTarget?: string;
  defaultTargetName?: string;
  onSubmitted?: (requestId?: string) => void;
}) {
  const { session } = useSession();
  const orgs = useRelatedOrgs(session);
  const [goal, setGoal] = useState('');
  const [target, setTarget] = useState<{ sa: string; label: string } | null>(
    defaultTarget ? { sa: defaultTarget.toLowerCase(), label: defaultTargetName ?? defaultTarget } : null,
  );
  const [personQuery, setPersonQuery] = useState('');
  const [hits, setHits] = useState<AgentSearchHit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  // Stale-grant signal from the target's serving plane (the grant predates the coordination
  // scopes). If THIS viewer stewards the target org, they can re-sign inline and resend.
  const [staleTarget, setStaleTarget] = useState(false);
  const reEnable = useReEnableInteractions();
  const stewardOfTarget = !!target && orgs.some((o) => o.orgAgent === target.sa && o.relationship === 'steward');

  const runSearch = useCallback(async () => {
    if (!personQuery.trim()) return;
    setError(null);
    try { setHits(await searchAgentsKb(personQuery.trim().toLowerCase())); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [personQuery]);

  const submit = useCallback(async () => {
    if (!session || !target || !goal.trim()) return;
    setBusy(true); setError(null); setStaleTarget(false);
    try {
      const r = await submitEndeavorRequest(session.token, target.sa, goal.trim());
      setSent(true);
      setGoal('');
      onSubmitted?.(r.requestId);
    } catch (e) {
      if (isReEnableError(e)) {
        setStaleTarget(true);
        setError(`${target.label}'s storage grant predates coordination — a steward of ${target.label} must re-enable storage before requests can land.`);
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally { setBusy(false); }
  }, [session, target, goal, onSubmitted]);

  const reEnableAndResend = useCallback(async () => {
    if (!target) return;
    setBusy(true); setError(null);
    const r = await reEnable(target.sa as Address);
    if (!r.ok) { setError(r.error ?? 'could not re-enable storage'); setBusy(false); return; }
    setStaleTarget(false); setBusy(false);
    await submit();
  }, [target, reEnable, submit]);

  if (!session) return null;

  if (sent) {
    return (
      <div className="manage-card" style={{ padding: '1rem' }}>
        <p style={{ color: 'var(--color-sage-700, #047857)', fontSize: '0.85rem', margin: 0 }}>
          Request sent to <b>{target?.label}</b>. It appears in their Requests view for triage —
          you&rsquo;ll be notified when it is accepted or declined.
        </p>
        <button type="button" className="ghost" style={{ marginTop: '0.5rem' }} onClick={() => setSent(false)}>
          New request
        </button>
      </div>
    );
  }

  return (
    <div className="manage-card" style={{ padding: '1rem' }}>
      <h3 className="subhead" style={{ marginTop: 0 }}>New request</h3>
      <BasisLine needs="your signature on the request — the target decides whether to adopt it" style={{ marginBottom: '0.4rem' }} />
      <p className="manage-card-blurb" style={{ margin: '0 0 0.7rem' }}>
        Describe what you want done. The target decides whether to adopt your request as an endeavor —
        you state the goal, not the steps.
      </p>

      <textarea
        value={goal}
        onChange={(e) => setGoal(e.target.value)}
        rows={3}
        maxLength={4000}
        placeholder="What should be accomplished? e.g. Organize volunteer transportation for the October event"
        style={{ width: '100%', fontFamily: 'inherit', fontSize: '0.9rem', lineHeight: 1.45, padding: '0.55rem 0.7rem', border: '1px solid var(--color-border)', borderRadius: 8, background: 'var(--color-surface, #fff)', resize: 'vertical', marginBottom: '0.6rem' }}
      />

      <div style={{ fontSize: '0.8rem', marginBottom: '0.35rem' }}>
        To: {target ? (
          <>
            <b>{target.label}</b>{' '}
            <button type="button" className="ghost" style={{ fontSize: '0.72rem', minHeight: 0, padding: '0.1rem 0.4rem' }} onClick={() => setTarget(null)}>
              change
            </button>
          </>
        ) : (
          <span style={{ opacity: 0.65 }}>pick an organization you belong to, or search for a person</span>
        )}
      </div>

      {!target && (
        <div style={{ marginBottom: '0.6rem' }}>
          {orgs.length > 0 && (
            <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap', marginBottom: '0.45rem' }}>
              {orgs.map((o) => (
                <button
                  key={o.orgAgent}
                  type="button"
                  className="badge"
                  style={{ border: '1px solid var(--color-amber-400)', background: 'var(--color-amber-50)', color: 'var(--color-amber-700)', cursor: 'pointer', fontWeight: 600 }}
                  onClick={() => setTarget({ sa: o.orgAgent, label: o.orgName ?? o.orgAgent })}
                >
                  {o.orgName ?? `${o.orgAgent.slice(0, 8)}…`}
                </button>
              ))}
            </div>
          )}
          <div style={{ display: 'flex', gap: '0.4rem' }}>
            <input
              placeholder="Search people…"
              value={personQuery}
              onChange={(e) => setPersonQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void runSearch(); }}
              style={{ flex: 1, padding: '0.4rem 0.7rem', border: '1px solid var(--color-border)', borderRadius: 999 }}
            />
            <button type="button" className="btn" disabled={!personQuery.trim()} onClick={() => void runSearch()}>Search</button>
          </div>
          {hits !== null && (
            hits.length === 0 ? (
              <p style={{ fontSize: '0.78rem', opacity: 0.65, margin: '0.4rem 0 0' }}>No matches.</p>
            ) : (
              hits.map((h) => (
                <button
                  key={h.smartAgent}
                  type="button"
                  onClick={() => { setTarget({ sa: h.smartAgent.toLowerCase(), label: h.displayName ?? h.name }); setHits(null); setPersonQuery(''); }}
                  style={{ display: 'block', width: '100%', textAlign: 'left', border: 'none', background: 'transparent', cursor: 'pointer', padding: '0.35rem 0', borderBottom: '1px solid var(--color-border)', fontSize: '0.83rem' }}
                >
                  <b>{h.displayName ?? h.name}</b>
                  {h.displayName && <span style={{ opacity: 0.6 }}> · {h.name}</span>}
                </button>
              ))
            )
          )}
        </div>
      )}

      <button type="button" className="btn-primary" style={{ width: 'auto' }} disabled={busy || !target || !goal.trim()} onClick={() => void submit()}>
        {busy ? 'Sending…' : 'Send request'}
      </button>
      {error && <p style={{ color: 'var(--color-danger)', fontSize: '0.8rem', margin: '0.4rem 0 0' }}>{error}</p>}
      {staleTarget && stewardOfTarget && (
        <div style={{ marginTop: '0.5rem' }}>
          <BusyButton busy={busy} busyLabel="Re-enabling…" className="btn" style={{ width: 'auto' }} onClick={() => void reEnableAndResend()}>
            Re-enable storage and resend
          </BusyButton>
        </div>
      )}
    </div>
  );
}
