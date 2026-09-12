'use client';
// PAUSE · CANCEL · REVOKE · UNDO ARE FOUR THINGS — spec 398 §5.3. This is the CANCEL control for an unfinished run,
// and it says what it is not: stopping the run does not withdraw authority (that is a delegation's revocation,
// under Security — the next step would be refused, the run itself is not stopped), and it does not undo what
// already happened (an undo is a new intent with its own mandate, offered only where a compensation exists). The
// receipt of a canceled run says "stopped after step N; steps 1–N happened".
import { useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { BusyButton } from '../../shared/BusyButton';
import { cancelRun } from '../../../home/ask';

export function RunControls({ token, addressee, runRef, onCanceled, compact }: {
  token: string; addressee: Address; runRef: string;
  onCanceled?: (r: { stoppedAfter: number; happened: string[] }) => void; compact?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const stop = async () => {
    if (busy) return;
    const note = typeof window !== 'undefined' ? (window.prompt('Stop this run? What already happened stands. A note is kept with the record (optional).') ?? null) : '';
    if (note === null) return;
    setBusy(true);
    const r = await cancelRun({ token }, addressee, runRef, note.trim() || undefined);
    setBusy(false);
    if (!r.ok) { setSaid(r.error); return; }
    setSaid(r.stoppedAfter === 0 ? 'stopped before any step ran' : `stopped after step ${r.stoppedAfter}; step${r.stoppedAfter === 1 ? ' 1' : `s 1–${r.stoppedAfter}`} happened`);
    onCanceled?.(r);
  };
  return (
    <span style={{ display: 'inline-flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }} data-testid="run-controls" onClick={(e) => { e.stopPropagation(); e.preventDefault(); }}>
      {said
        ? <span className="ui-meta">{said}</span>
        : <BusyButton busy={busy} busyLabel="Stopping…" className={`ui-btn ui-btn--secondary${compact ? ' ui-btn--sm' : ''}`} onClick={() => void stop()} data-testid="run-cancel">Stop this run</BusyButton>}
      {!compact && !said && (
        <span className="ui-micro" title="Stopping is not withdrawing authority: to refuse the next step of any run, revoke the delegation under Security. Nothing here undoes what already happened.">
          what happened stands · <a href="/security" onClick={(e) => e.stopPropagation()}>withdraw authority</a>
        </span>
      )}
    </span>
  );
}
