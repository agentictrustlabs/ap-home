'use client';
// WHAT MY AGENT DID — spec 381 W3, the listing. The runs this person asked of an agent, newest first, each
// with its goal, when it finished, how it ended and how many steps and receipts it left; open one and its
// provenance draws as a timeline (RunTimeline). Read from the agent's own records under the person's session:
// the Worker lists only the runs they asked for, and refuses the rest.
import { useEffect, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { listRunRecords, type RunRecordRow } from '../../../home/ask';
import { RunTimeline } from './RunTimeline';

const OUTCOME_LABEL: Record<string, string> = { completed: 'done', failed: 'failed', refused: 'refused', suspended: 'waiting', cancelled: 'cancelled' };

export function RunHistory({ token, addressee, limit = 25 }: { token: string; addressee: Address; limit?: number }) {
  const [rows, setRows] = useState<RunRecordRow[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void listRunRecords({ token }, addressee).then((r) => { if (live) setRows(r.records.sort((a, b) => b.at - a.at)); }).catch(() => { if (live) setRows([]); });
    return () => { live = false; };
  }, [token, addressee]);
  return (
    <div className="dash-section" style={{ marginTop: '1.5rem' }} data-testid="run-history">
      <h2>What this agent did</h2>
      <p className="manage-card-blurb">
        Every run you asked of it, from its own records: the goal, how it ended, and — opened — each step, how long it took,
        under whose authority, and where it handed work on. The same provenance an exporter would carry; download it from any run.
      </p>
      {rows === null && <p className="muted" style={{ fontSize: '0.8rem' }}>Reading the runs back…</p>}
      {rows !== null && rows.length === 0 && <p className="muted" style={{ fontSize: '0.8rem' }}>No finished runs of yours here yet. Ask something, and it appears.</p>}
      {(rows ?? []).slice(0, limit).map((r) => {
        const goal = r.intent?.goal ?? r.runRef;
        const isOpen = open === r.runRef;
        return (
          <div key={r.runRef} style={{ padding: '0.45rem 0', borderBottom: '1px solid var(--color-border)' }}>
            <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'baseline', fontSize: '0.84rem', flexWrap: 'wrap' }}>
              <span style={{ flex: 'none', opacity: 0.6, fontSize: '0.74rem' }}>{new Date(r.at).toLocaleString()}</span>
              <span style={{ flex: 1, minWidth: 200 }}>{goal.length > 140 ? `${goal.slice(0, 137)}…` : goal}</span>
              <span className="badge" style={{ flex: 'none', fontSize: '0.64rem', border: '1px solid var(--color-border)', color: r.outcome === 'completed' ? 'var(--color-sage-700, #047857)' : 'var(--color-text-muted)' }}>{OUTCOME_LABEL[r.outcome] ?? r.outcome}</span>
              <span style={{ flex: 'none', fontSize: '0.72rem', opacity: 0.7 }}>{r.steps} step{r.steps === 1 ? '' : 's'} · {r.receipts} receipt{r.receipts === 1 ? '' : 's'}{r.export?.ok ? ' · in the vault' : ''}</span>
              <button type="button" className="ghost" style={{ flex: 'none', fontSize: '0.74rem' }} onClick={() => setOpen(isOpen ? null : r.runRef)}>{isOpen ? 'Close' : 'Open'}</button>
            </div>
            {isOpen && <RunTimeline token={token} addressee={addressee} runRef={r.runRef} open />}
          </div>
        );
      })}
    </div>
  );
}
