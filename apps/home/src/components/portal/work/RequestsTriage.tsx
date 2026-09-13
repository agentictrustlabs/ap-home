'use client';
// Requests triage list (spec 334 §6) — shared by the Work "Requests" tab and the
// standalone /work/requests route. Steward accept/decline (both recorded); on
// adoption the org's agent drafts a suggested plan for the new endeavor.
import { useCallback, useState } from 'react';
import { useSession } from '../../../context/session';
import { BusyButton } from '../../shared/BusyButton';
import { adoptEndeavorRequest, declineEndeavorRequest, type EndeavorRequestRow } from '../../../lib/work-client';
import { agentLabel, shortId } from '../../../home/use-inbox';

export function RequestsTriage({
  org,
  requests,
  steward,
  names,
  refresh,
}: {
  org: string;
  requests: EndeavorRequestRow[];
  steward: boolean;
  names: Record<string, string>;
  refresh: () => Promise<void>;
}) {
  const { session } = useSession();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [declining, setDeclining] = useState<string | null>(null);
  const [declineReason, setDeclineReason] = useState('');
  const [adoptedNote, setAdoptedNote] = useState<string | null>(null);

  const pending = requests.filter((r) => (r.status ?? 'pending') === 'pending');
  const settled = requests.filter((r) => (r.status ?? 'pending') !== 'pending');

  const adopt = useCallback(async (r: EndeavorRequestRow) => {
    if (!session) return;
    setBusyId(r.requestId); setActionError(null);
    try {
      const out = await adoptEndeavorRequest(session.token, org, r.requestId);
      setAdoptedNote(out.endeavorId ?? null);
      await refresh();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally { setBusyId(null); }
  }, [session, org, refresh]);

  const decline = useCallback(async (r: EndeavorRequestRow) => {
    if (!session) return;
    setBusyId(r.requestId); setActionError(null);
    try {
      await declineEndeavorRequest(session.token, org, r.requestId, declineReason.trim() || undefined);
      setDeclining(null); setDeclineReason('');
      await refresh();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally { setBusyId(null); }
  }, [session, org, declineReason, refresh]);

  return (
    <>
      {actionError && <p style={{ color: 'var(--color-danger)', fontSize: '0.8rem' }}>{actionError}</p>}
      {adoptedNote && (
        <div className="manage-card" style={{ padding: '0.6rem 0.9rem', marginBottom: '0.6rem', border: '1px solid var(--color-sage-500, #5f9b76)', fontSize: '0.82rem' }}>
          Accepted — the organization&rsquo;s agent is drafting a suggested plan.{' '}
          <a href={`/org/${org}/work/${encodeURIComponent(adoptedNote)}`}>Open the endeavor</a> to review it.
        </div>
      )}
      {pending.length === 0 ? (
        <p style={{ opacity: 0.7, fontSize: '0.85rem' }}>No requests waiting for a decision.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.55rem' }}>
          {pending.map((r) => (
            <div key={r.requestId} className="manage-card" style={{ padding: '0.75rem 0.95rem' }}>
              <div style={{ fontSize: '0.88rem', fontWeight: 600 }}>{r.goal}</div>
              <div style={{ fontSize: '0.72rem', opacity: 0.6, margin: '0.25rem 0 0.5rem' }}>
                From {agentLabel(r.requester, names)} · {new Date(r.submittedAt).toLocaleString()} · {shortId(r.requestId)}
              </div>
              {steward ? (
                declining === r.requestId ? (
                  <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', alignItems: 'center' }}>
                    <input
                      placeholder="Reason (optional — recorded with the decline)"
                      value={declineReason}
                      onChange={(e) => setDeclineReason(e.target.value)}
                      style={{ flex: 1, minWidth: 200, fontSize: '0.8rem', padding: '0.32rem 0.5rem', border: '1px solid var(--color-border)', borderRadius: 6 }}
                    />
                    <BusyButton busy={busyId === r.requestId} busyLabel="Declining…" className="ui-btn ui-btn--danger" onClick={() => void decline(r)}>
                      Decline request
                    </BusyButton>
                    <button type="button" className="ui-btn ui-btn--ghost" onClick={() => { setDeclining(null); setDeclineReason(''); }}>Cancel</button>
                  </div>
                ) : (
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <BusyButton busy={busyId === r.requestId} busyLabel="Accepting…" className="btn-primary" style={{ width: 'auto' }} onClick={() => void adopt(r)}>
                      Accept — start an endeavor
                    </BusyButton>
                    <button type="button" className="ui-btn ui-btn--secondary" disabled={busyId !== null} onClick={() => setDeclining(r.requestId)}>
                      Decline
                    </button>
                  </div>
                )
              ) : (
                <div style={{ fontSize: '0.75rem', opacity: 0.65 }}>Awaiting a steward&rsquo;s decision.</div>
              )}
            </div>
          ))}
        </div>
      )}

      {settled.length > 0 && (
        <details style={{ marginTop: '1rem' }}>
          <summary style={{ fontSize: '0.82rem', cursor: 'pointer' }}>Decided ({settled.length})</summary>
          {settled.map((r) => (
            <div key={r.requestId} style={{ padding: '0.4rem 0', borderBottom: '1px solid var(--color-border)', fontSize: '0.8rem' }}>
              <span style={{ opacity: 0.75 }}>{r.goal}</span>
              <span style={{ opacity: 0.55 }}>
                {' '}· {r.status === 'adopted'
                  ? <>accepted{r.endeavorId ? <> — <a href={`/org/${org}/work/${encodeURIComponent(r.endeavorId)}`}>open endeavor</a></> : null}</>
                  : `declined${r.reason ? ` — ${r.reason}` : ''}`}
              </span>
            </div>
          ))}
        </details>
      )}
    </>
  );
}
