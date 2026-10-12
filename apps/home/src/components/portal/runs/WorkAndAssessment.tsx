'use client';
// THE WORK A RUN WAS PART OF, AND WHO HAS JUDGED IT — spec 438 §3 and §5, in the Inspector.
//
// ── WHY ATTACHING IS A BUTTON AND NOT A GUESS ─────────────────────────────────────────────────────
// Everything needed to guess which endeavour a run belongs to is already on the record: the asker, the
// time, the conversation id, the retry it followed. Guessing would be right most of the time, and the times
// it was wrong would be indistinguishable from the times a person said so — so the record would stop
// meaning anything. Attaching is therefore an act with an author: the Ask carries `coordination.run.attach`
// through the same gates as every other act, and a retry does not join its predecessor's work until
// somebody attaches it.
//
// ── WHY "NO ASSESSMENT" IS NOT A GRADE ────────────────────────────────────────────────────────────
// An unassessed run is not a bad one. It is a run nobody has judged — usually because nobody has stated
// criteria for it yet — and the panel says exactly that rather than rendering an empty score.
import { useEffect, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { askCommand } from '../../../home/ask-command';
import { fetchRunEvidence, type EvidenceStatusView } from '../../../home/ask';

export function WorkAndAssessment({
  token, addressee, runRef, work, org,
}: {
  token: string;
  addressee: Address;
  runRef: string;
  /** From the run's own record. Absent means the run named no work — which is a fact, not a gap. */
  work?: { endeavorId: string; commitmentId?: string; planStepId?: string };
  /** The organization whose endeavors this person may attach to, when the surface knows one. */
  org?: string;
}) {
  const [assessment, setAssessment] = useState<EvidenceStatusView['assessment'] | null>(null);
  const [endeavorId, setEndeavorId] = useState('');

  useEffect(() => {
    let live = true;
    void fetchRunEvidence({ token }, addressee, runRef).then((r) => {
      if (live && !('error' in r)) setAssessment(r.assessment);
    });
    return () => { live = false; };
  }, [token, addressee, runRef]);

  return (
    <div style={{ marginTop: '.3rem' }}>
      {work?.endeavorId ? (
        <p style={{ margin: '0 0 .4rem' }}>
          Part of <strong>{work.endeavorId}</strong>
          {work.planStepId && <> · step <code>{work.planStepId}</code></>}
          {work.commitmentId && <> · commitment <code>{work.commitmentId}</code></>}
          <span className="muted small" style={{ marginLeft: '.4rem' }}>a reference — being part of work grants nothing</span>
        </p>
      ) : (
        <div style={{ marginBottom: '.5rem' }}>
          <p className="muted small" style={{ margin: '0 0 .3rem' }}>
            This run names no work. Nothing has been inferred: a run joins an endeavour when somebody attaches it, never
            because it followed another one.
          </p>
          {org ? (
            <div style={{ display: 'flex', gap: '.4rem', alignItems: 'center', flexWrap: 'wrap' }}>
              <input
                value={endeavorId}
                onChange={(e) => setEndeavorId(e.target.value)}
                placeholder="end_… (from Work)"
                aria-label="The endeavour to attach this run to"
                style={{ padding: '.25rem .45rem', fontSize: '.84rem', minWidth: '14rem' }}
              />
              <button
                type="button"
                className="btn-ghost"
                style={{ padding: '.2rem .55rem', fontSize: '.82rem' }}
                disabled={!endeavorId.trim().startsWith('end_')}
                onClick={() =>
                  askCommand({
                    toolId: 'coordination.run.attach',
                    args: { org, endeavorId: endeavorId.trim(), runRef },
                    message: `Attach run ${runRef} to ${endeavorId.trim()}`,
                  })
                }
              >
                Attach to work
              </button>
            </div>
          ) : (
            <p className="muted small" style={{ margin: 0 }}>Open this run from an organization&rsquo;s page to attach it to one of its endeavours.</p>
          )}
        </div>
      )}

      {assessment === null ? (
        <p className="muted small" style={{ margin: 0 }}>Reading whether anyone has judged this run…</p>
      ) : assessment.state === 'assessed' ? (
        <p style={{ margin: 0 }}>
          <strong>{assessment.count}</strong> assessment{assessment.count === 1 ? '' : 's'} against stated criteria.
          <span className="muted small" style={{ marginLeft: '.4rem' }}>
            each is a separate signed record — the run below is unchanged by any of them
          </span>
        </p>
      ) : (
        <p className="muted small" style={{ margin: 0 }}>
          Nobody has judged this run. That is not a failing grade — an assessment needs criteria stated before the run it
          judges, and none has been.
        </p>
      )}
    </div>
  );
}
