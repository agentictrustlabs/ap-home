'use client';
// Org Work — Requests / Triage (spec 334 §6). Pending EndeavorRequests with
// explicit steward accept / decline: accept runs endeavor.create (adopting the
// request as an Endeavor); decline runs the decline command. Both are audited
// by the serving plane — never silent. Members see their own requests' status;
// triage actions are steward-only (re-verified server-side).
import { useCallback, useMemo, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { useSession } from '../../../context/session';
import { SectionShell } from '../SectionShell';
import { BusyButton } from '../../shared/BusyButton';
import { adoptEndeavorRequest, declineEndeavorRequest, type EndeavorRequestRow } from '../../../lib/work-client';
import { agentLabel, shortId } from '../../../home/use-inbox';
import { useWorkList } from './useWork';

export function OrgWorkRequestsView({ org }: { org: Address }) {
  const { session } = useSession();
  const communityId = org.toLowerCase();
  const { data, member, steward, error, refresh } = useWorkList(session, communityId);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [declining, setDeclining] = useState<string | null>(null);
  const [declineReason, setDeclineReason] = useState('');

  const requests = useMemo(() => data?.requests ?? [], [data]);
  const pending = requests.filter((r) => (r.status ?? 'pending') === 'pending');
  const settled = requests.filter((r) => (r.status ?? 'pending') !== 'pending');

  const adopt = useCallback(async (r: EndeavorRequestRow) => {
    if (!session) return;
    setBusyId(r.requestId); setActionError(null);
    try {
      await adoptEndeavorRequest(session.token, communityId, r.requestId);
      await refresh();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally { setBusyId(null); }
  }, [session, communityId, refresh]);

  const decline = useCallback(async (r: EndeavorRequestRow) => {
    if (!session) return;
    setBusyId(r.requestId); setActionError(null);
    try {
      await declineEndeavorRequest(session.token, communityId, r.requestId, declineReason.trim() || undefined);
      setDeclining(null); setDeclineReason('');
      await refresh();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally { setBusyId(null); }
  }, [session, communityId, declineReason, refresh]);

  if (!session) return <SectionShell title="Requests"><p>Not signed in.</p></SectionShell>;
  if (member === false) {
    return (
      <SectionShell title="Requests">
        <p style={{ fontSize: '0.85rem', opacity: 0.75 }}>Requests are visible to members of this organization.</p>
      </SectionShell>
    );
  }

  return (
    <SectionShell
      title="Requests"
      actions={<a href={`/org/${communityId}/work`} className="ghost" style={{ textDecoration: 'none', fontSize: '0.8rem' }}>← Work</a>}
    >
      {(error || actionError) && <p style={{ color: 'var(--color-danger)', fontSize: '0.8rem' }}>{actionError ?? error}</p>}

      {data === null ? (
        <p style={{ opacity: 0.6, fontSize: '0.85rem' }}>Loading…</p>
      ) : pending.length === 0 ? (
        <p style={{ opacity: 0.7, fontSize: '0.85rem' }}>No pending requests to triage.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.55rem' }}>
          {pending.map((r) => (
            <div key={r.requestId} className="manage-card" style={{ padding: '0.75rem 0.95rem' }}>
              <div style={{ fontSize: '0.88rem' }}>{r.goal}</div>
              <div style={{ fontSize: '0.72rem', opacity: 0.6, margin: '0.25rem 0 0.5rem' }}>
                From {agentLabel(r.requester)} · via {r.entryPoint} · {new Date(r.submittedAt).toLocaleString()} · request {shortId(r.requestId)}
              </div>
              {steward ? (
                declining === r.requestId ? (
                  <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', alignItems: 'center' }}>
                    <input
                      placeholder="Reason (optional — recorded with the decline)"
                      value={declineReason}
                      onChange={(e) => setDeclineReason(e.target.value)}
                      style={{ flex: 1, minWidth: 200 }}
                    />
                    <BusyButton busy={busyId === r.requestId} busyLabel="Declining…" className="btn-danger" style={{ width: 'auto' }} onClick={() => void decline(r)}>
                      Decline request
                    </BusyButton>
                    <button type="button" className="ghost" onClick={() => { setDeclining(null); setDeclineReason(''); }}>Cancel</button>
                  </div>
                ) : (
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <BusyButton busy={busyId === r.requestId} busyLabel="Adopting…" className="btn-primary" style={{ width: 'auto' }} onClick={() => void adopt(r)}>
                      Accept as endeavor
                    </BusyButton>
                    <button type="button" className="btn" style={{ width: 'auto' }} disabled={busyId !== null} onClick={() => setDeclining(r.requestId)}>
                      Decline
                    </button>
                  </div>
                )
              ) : (
                <div style={{ fontSize: '0.75rem', opacity: 0.65 }}>Awaiting steward triage.</div>
              )}
            </div>
          ))}
        </div>
      )}

      {settled.length > 0 && (
        <details style={{ marginTop: '1rem' }}>
          <summary style={{ fontSize: '0.82rem', cursor: 'pointer' }}>Triaged ({settled.length})</summary>
          {settled.map((r) => (
            <div key={r.requestId} style={{ padding: '0.4rem 0', borderBottom: '1px solid var(--color-border)', fontSize: '0.8rem' }}>
              <span style={{ opacity: 0.75 }}>{r.goal}</span>
              <span style={{ opacity: 0.55 }}> · {r.status === 'adopted' ? 'adopted as an endeavor' : 'declined'}</span>
            </div>
          ))}
        </details>
      )}
    </SectionShell>
  );
}
