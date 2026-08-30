'use client';
// History (flow-redesign.md §6): every version of the card, what happened to it, and the two things you can do
// to a live one — retire it, or withdraw it with a reason. Audit detail (ids, digests, approvers) sits behind a
// disclosure per entry: true, and not what a steward reads first.
import { useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { BusyButton } from '../shared/BusyButton';
import { deprecateRelease, newMutation, revokeRelease, type CardDetail, type DelegationWire } from '../../studio-client';
import { studioErrorSentence } from '../../lib/studio-view';
import { Chip, ErrorLine, inputStyle } from './ui';
import { notifyCardChanged } from './useStudio';

export function HistoryFlow({ delegation, detail, onReload }: { delegation: DelegationWire; detail: CardDetail; onReload(): void }) {
  const [revokeReason, setRevokeReason] = useState('');
  const [historyBusy, setHistoryBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <div>
      <ErrorLine error={error} />
        <section className="manage-card" aria-label="History">
          <h2 className="subhead" style={{ marginTop: 0 }}>History</h2>
          {detail.releases.length === 0 && <p className="manage-card-blurb">Nothing published yet.</p>}
          <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: '.5rem' }}>
            {[...detail.releases].reverse().map((r) => (
              <li key={r.releaseId} style={{ borderLeft: '3px solid var(--c-g200)', paddingLeft: '.6rem' }}>
                <div style={{ fontSize: '.82rem', fontWeight: 700 }}>
                  Version {r.releaseNumber} · {r.state}
                  {r.smartAgentBinding && <Chip tone="good" style={{ marginLeft: '.4rem' }}>custodian-signed</Chip>}
                </div>
                <div className="manage-card-blurb" style={{ margin: 0 }}>
                  created {new Date(r.createdAt).toLocaleString()}
                  {r.publication && <> · published {new Date(r.publication.publishedAt).toLocaleString()} at <a href={r.publication.uri} target="_blank" rel="noreferrer">{r.publication.uri}</a></>}
                </div>
                <details style={{ fontSize: '.7rem', marginTop: '.2rem' }}>
                  <summary>Audit detail</summary>
                  <div style={{ wordBreak: 'break-all' }}>
                    id {r.releaseId} · unsigned {r.unsignedContentDigest}{r.signedContentDigest ? ` · signed ${r.signedContentDigest}` : ''}
                    {r.approvals.map((a) => <div key={a.approvalId}>approved by {a.approver} at {a.approvedAt}</div>)}
                    {r.revocation && <div>revoked: {r.revocation.reason} ({r.revocation.revokedAt})</div>}
                  </div>
                </details>
                {r.state === 'published' && (
                  <div style={{ display: 'flex', gap: '.4rem', alignItems: 'center', marginTop: '.3rem', flexWrap: 'wrap' }}>
                    <BusyButton busy={historyBusy === `dep-${r.releaseId}`} busyLabel="Retiring…" className="btn-ghost" onClick={() => { setHistoryBusy(`dep-${r.releaseId}`); void deprecateRelease(delegation, detail.resource.cardResourceId, r.releaseId, newMutation()).then(() => { notifyCardChanged(); onReload(); }).catch((e) => setError(studioErrorSentence(String(e)))).finally(() => setHistoryBusy(null)); }}>Retire this version</BusyButton>
                    <input placeholder="Reason (required to withdraw)" value={revokeReason} onChange={(e) => setRevokeReason(e.target.value)} style={{ ...inputStyle, maxWidth: 260 }} />
                    <BusyButton busy={historyBusy === `rev-${r.releaseId}`} busyLabel="Withdrawing…" className="btn-ghost" disabled={!revokeReason.trim()} onClick={() => { setHistoryBusy(`rev-${r.releaseId}`); void revokeRelease(delegation, detail.resource.cardResourceId, r.releaseId, { ...newMutation(), reason: revokeReason.trim() }).then(() => { notifyCardChanged(); onReload(); }).catch((e) => setError(studioErrorSentence(String(e)))).finally(() => setHistoryBusy(null)); }}>Withdraw</BusyButton>
                  </div>
                )}
              </li>
            ))}
          </ol>
        </section>

    </div>
  );
}
