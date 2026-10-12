'use client';
// HOW COMPLETE IS WHAT THIS RUN LEFT BEHIND — spec 438 §4, in the Inspector.
//
// FIVE READINGS SIDE BY SIDE, never one badge. The tempting UI is a green tick meaning "fine", and each of
// the five things it would be hiding is a different sentence a person needs:
//
//   coverage      every planned step left a record — or WHICH one did not
//   consistency   the record's own parts agree — or how they disagree
//   origin        the harness saw it, or another agent reported it
//   integrity     how far anyone actually checked the bytes (unchecked is the honest default)
//   assessment    whether anyone has judged it, and unassessed is NOT failed
//
// And cost, which is the one most likely to lie: a provider that reported no usage leaves this
// `unavailable`. It never renders 0, because a zero is a claim and somebody will put it in a budget.
//
// `effect-uncertain` is shown ALONGSIDE the outcome, never instead of it: a step whose external call timed
// out after it may have landed is "unknown — reconciling", and a person needs to see that at the same time
// as seeing the run completed.
import { useEffect, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { fetchRunEvidence, type EvidenceStatusView } from '../../../home/ask';

type Tone = 'good' | 'warn' | 'bad' | 'muted';
const TONE: Record<Tone, string> = { good: '#166534', warn: '#92400e', bad: '#b91c1c', muted: '#64748b' };

function Line({ label, tone, value, detail }: { label: string; tone: Tone; value: string; detail?: string }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '7.5rem minmax(0,1fr)', gap: '0.5rem', padding: '0.3rem 0', alignItems: 'baseline' }}>
      <span style={{ fontSize: '.78rem', textTransform: 'uppercase', letterSpacing: '.04em', opacity: 0.6 }}>{label}</span>
      <span>
        <strong style={{ color: TONE[tone], fontWeight: 600 }}>{value}</strong>
        {detail && <span style={{ opacity: 0.75, marginLeft: '.45rem', fontSize: '.88rem' }}>{detail}</span>}
      </span>
    </div>
  );
}

/** The cost line. `unavailable` and `partial` are said in words — a number here that is not a total is worse
 *  than no number, because nobody re-checks a figure that looks precise. */
function costWords(c: EvidenceStatusView['cost']): { tone: Tone; value: string; detail: string } {
  if (c.state === 'unavailable') {
    return { tone: 'muted', value: 'unavailable', detail: c.modelCalls === 0 ? 'no model call was made' : `${c.modelCalls} call(s), none reported usage — not a cost of zero` };
  }
  const tokens = `${c.tokensIn ?? 0} in · ${c.tokensOut ?? 0} out`;
  if (c.state === 'partial') return { tone: 'warn', value: 'partial', detail: `${tokens} — a floor: ${c.callsMissingUsage} of ${c.modelCalls} call(s) reported nothing` };
  return { tone: 'good', value: tokens, detail: `${c.modelCalls} call(s), all reported` };
}

export function EvidencePanel({ token, addressee, runRef }: { token: string; addressee: Address; runRef: string }) {
  const [ev, setEv] = useState<EvidenceStatusView | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setEv(null); setErr(null);
    void fetchRunEvidence({ token }, addressee, runRef).then((r) => {
      if (!live) return;
      if ('error' in r) setErr(r.error); else setEv(r);
    });
    return () => { live = false; };
  }, [token, addressee, runRef]);

  // An unreadable reading is said, not hidden. A blank panel reads as "nothing to report", which is the one
  // thing it must never mean.
  if (err) return <p className="muted small" style={{ color: TONE.warn }}>The evidence reading could not be made: {err}</p>;
  if (!ev) return <p className="muted small">Reading the evidence…</p>;

  const cov = ev.coverage;
  const con = ev.consistency;
  const cost = costWords(ev.cost);

  return (
    <div style={{ marginTop: '.4rem' }}>
      {ev.effectUncertain && (
        <p style={{ color: TONE.warn, fontWeight: 600, margin: '0 0 .4rem' }}>
          unknown — reconciling: a step&rsquo;s external effect may have happened. This is not a failure, and re-running could do it twice.
        </p>
      )}

      <Line
        label="coverage"
        tone={cov.state === 'complete' ? 'good' : cov.state === 'incomplete' ? 'bad' : 'muted'}
        value={cov.state}
        detail={
          cov.state === 'incomplete'
            ? `no record for ${cov.missing.join(', ')}`
            : cov.state === 'unknown'
              ? 'the run stopped before its plan finished — not the same as a missing record'
              : `${cov.recordedSteps} of ${cov.plannedSteps} planned step(s)${cov.skipped.length ? `, ${cov.skipped.length} skipped by a declared branch` : ''}`
        }
      />

      <Line
        label="consistency"
        tone={con.state === 'conflicting' ? 'bad' : con.state === 'consistent' ? 'good' : 'muted'}
        value={con.state}
        detail={con.state === 'conflicting' ? con.conflicts.join('; ') : con.state === 'unknown' ? 'nothing to compare' : 'the record’s parts agree'}
      />

      <Line
        label="origin"
        tone={ev.origin.state === 'mixed' ? 'warn' : 'good'}
        value={ev.origin.state}
        detail={ev.origin.state === 'mixed' ? `${ev.origin.delegatedSteps.join(', ')} ran at another agent and were reported back` : 'the harness saw every step itself'}
      />

      <Line
        label="integrity"
        tone={ev.integrity.state === 'anchored' ? 'good' : ev.integrity.state === 'unchecked' ? 'muted' : 'good'}
        value={ev.integrity.state}
        detail={ev.integrity.state === 'unchecked' ? 'nobody has recomputed the digest — not the same as invalid' : ev.integrity.anchorDigest ? `digest ${ev.integrity.anchorDigest.slice(0, 12)}…` : ''}
      />

      <Line
        label="assessment"
        tone={ev.assessment.state === 'assessed' ? 'good' : 'muted'}
        value={ev.assessment.state}
        detail={ev.assessment.state === 'assessed' ? `${ev.assessment.count} judgment(s) against stated criteria` : 'nobody has judged this run — which is not a failing grade'}
      />

      <Line label="cost" tone={cost.tone} value={cost.value} detail={cost.detail} />
    </div>
  );
}
