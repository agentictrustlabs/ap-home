'use client';
// THIS AGENT'S RECORD — spec 438 §13: the five stages, joined, above the list of individual runs.
//
//   intent → execution → evidence → evaluation → continuation
//
// Everything here was already held somewhere. What was missing was the join, and the two rules that make a
// join like this safe to put beside an agent's name.
//
// ── NO SCORE, AND THE REASON IS NOT STYLISTIC ────────────────────────────────────────────────────────
// This panel shows pairs of counts and never a ratio. A success rate over these buckets would FALL WHENEVER
// THE AUTHORITY PLANE WORKS: an agent that correctly declines what it is not authorized to do raises its
// `denied` count, and a number that drops when the system behaves correctly is a number somebody will
// eventually optimise against. And an unassessed run is not a failed one — most runs nobody has judged are
// runs nobody has stated criteria for, so a denominator would turn the absence of a judge into a verdict.
// The reader may do the division in their head; what they may not be handed is the quotient.
//
// ── A JUDGMENT IS ABOUT A DOCUMENT ───────────────────────────────────────────────────────────────────
// An assessment cites the digest of the record it judged, and a run record grows after the fact. So a
// judgment of an earlier version is shown as STALE, in its own line, and never counted among the judgments of
// what the reader is looking at. Hiding it would be worse than either: a stale assessment is real evidence
// that somebody looked, and that the thing they looked at has since changed.
//
// ── AND "WE COULD NOT LOOK" IS NOT "NOBODY JUDGED" ───────────────────────────────────────────────────
// When the vault could not be surveyed the panel says so. The two render identically if you let them, and
// they mean opposite things.
import { useEffect, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { fetchAgentRecord, type AgentRecordView } from '../../../home/ask';

const ENDING_WORDS: Record<keyof AgentRecordView['endings'], string> = {
  completed: 'completed',
  failed: 'failed',
  denied: 'refused — the authority plane working',
  'authority-required': 'waiting for a signature',
  suspended: 'waiting for an answer',
  canceled: 'stopped by a person',
  unknown: 'ended in a way this build does not name',
};

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '9rem minmax(0,1fr)', gap: '.5rem', padding: '.25rem 0', alignItems: 'baseline' }}>
      <span style={{ fontSize: '.78rem', textTransform: 'uppercase', letterSpacing: '.04em', opacity: 0.6 }}>{label}</span>
      <span>{children}</span>
    </div>
  );
}

export function AgentRecord({ token, addressee }: { token: string; addressee: Address }) {
  const [v, setV] = useState<Awaited<ReturnType<typeof fetchAgentRecord>> | null>(null);

  useEffect(() => {
    let live = true; setV(null);
    void fetchAgentRecord({ token }, addressee).then((r) => { if (live) setV(r); });
    return () => { live = false; };
  }, [token, addressee]);

  if (v === null) return <p className="muted small">Reading this agent&rsquo;s record…</p>;
  if ('error' in v) return <p className="muted small">This agent&rsquo;s record could not be read: {v.error}</p>;

  const { record: r, read, assessmentsRead, unreadable } = v;
  const endings = (Object.keys(ENDING_WORDS) as Array<keyof AgentRecordView['endings']>).filter((k) => r.endings[k] > 0);

  if (r.total === 0) {
    return <p className="muted small">No run of this agent has been recorded yet. That is an empty record, not an absent one.</p>;
  }

  return (
    <div style={{ marginTop: '.4rem' }}>
      <Row label="execution">
        <strong>{r.total}</strong> run(s) read
        {endings.length > 0 && <span style={{ opacity: 0.8 }}> — {endings.map((k) => `${r.endings[k]} ${ENDING_WORDS[k]}`).join(', ')}</span>}
        {r.lastEndedAt && <span className="muted small" style={{ marginLeft: '.4rem' }}>last on {r.lastEndedAt.slice(0, 10)}</span>}
      </Row>

      <Row label="evidence">
        <strong>{r.evidence.complete}</strong> complete · {r.evidence.incomplete} incomplete · {r.evidence.unknown} stopped before the plan finished
        {r.evidence.unreported > 0 && <> · {r.evidence.unreported} not read</>}
        {r.evidence.effectUncertain > 0 && (
          <span className="muted small" style={{ marginLeft: '.4rem' }}>
            {r.evidence.effectUncertain} with an external effect still being reconciled
          </span>
        )}
      </Row>

      <Row label="evaluation">
        {!assessmentsRead ? (
          <span className="muted small">
            The vault could not be surveyed, so whether anyone has judged these runs is unknown rather than none.
          </span>
        ) : r.assessment.current === 0 ? (
          <span className="muted small">
            Nobody has judged these runs. That is not a failing grade: an assessment needs criteria stated before the
            run it judges, and none has been.
          </span>
        ) : (
          <>
            <strong>{r.assessment.runsAssessed}</strong> of {r.total} run(s) have a standing judgment, by{' '}
            {r.assessment.evaluators.length} evaluator(s) against {r.assessment.criteria.length} stated
            criteri{r.assessment.criteria.length === 1 ? 'on' : 'a'}.
            <span className="muted small" style={{ marginLeft: '.4rem' }}>
              {(Object.entries(r.assessment.outcomes) as Array<[string, number]>).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}`).join(' · ')}
            </span>
          </>
        )}
      </Row>

      {r.assessment.stale > 0 && (
        <Row label="stale">
          <span style={{ color: '#92400e' }}>{r.assessment.stale}</span> assessment(s) examined a different version of
          their run and are not counted as current.
          <span className="muted small" style={{ marginLeft: '.4rem' }}>
            the record changed after they were made — real evidence that somebody looked, and that what they looked at has moved
          </span>
        </Row>
      )}
      {r.assessment.orphaned > 0 && (
        <Row label="orphaned">{r.assessment.orphaned} assessment(s) name a run not in this record. Counted, never dropped.</Row>
      )}
      {r.assessment.superseded > 0 && (
        <Row label="corrected">
          {r.assessment.superseded} earlier judgment(s) were superseded and stay readable. A correction is a new
          assessment, never an edit.
        </Row>
      )}

      <Row label="work">
        {r.work.runsWithWork > 0 ? (
          <>
            <strong>{r.work.runsWithWork}</strong> run(s) attached to {r.work.endeavors.length} endeavour(s)
            {r.work.continuations > 0 && <> · {r.work.continuations} continued an earlier run</>}
          </>
        ) : (
          <span className="muted small">
            No run here names work. Nothing is inferred: a run joins an endeavour when somebody attaches it, never
            because it followed another one.
          </span>
        )}
      </Row>

      <p className="muted small" style={{ margin: '.5rem 0 0' }}>
        Counts over {read} run(s) read{unreadable?.length ? `, ${unreadable.length} of which could not be re-read` : ''}.
        Never a score: a rate over these would fall whenever this agent correctly refused something, and an unassessed
        run is not a failed one.
      </p>
    </div>
  );
}
