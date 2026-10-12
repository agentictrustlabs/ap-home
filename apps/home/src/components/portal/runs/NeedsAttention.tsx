'use client';
// WHAT NEEDS A PERSON — spec 438 §4, over everything this agent did.
//
// The feed is computed in Ring 0 (`findingsOf` in `@agenticprimitives/harness`) and merely rendered here, so
// a Home, a CLI and a nightly digest all find the same things. This component adds no judgment of its own.
//
// TWO THINGS IT DELIBERATELY DOES NOT DO:
//
//   It does not recommend. Every finding says what was observed and what it means; what to do about it is a
//   decision belonging to whoever holds the authority to act, and this surface does not know who that is. A
//   feed that says "retry" gets clicked through, and then it is the thing it was built to prevent.
//
//   It does not go quiet when it cannot read something. An unreadable record is listed as a finding, because
//   a missing row looks exactly like a clean one and nobody can see an absence.
//
// AND IT GROUPS. The first render of this panel on a real agent printed "waiting for a signature" twenty-six
// times in a row, each with its own Inspect button — technically every finding, practically a wall nobody
// reads, which is the same failure as saying nothing. Findings of one kind are collapsed to one line with a
// count; the runs stay reachable underneath. Grouping changes how many sentences a person reads, never which
// facts they are told.
import { useEffect, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { fetchAttention, type AttentionFindingView } from '../../../home/ask';

const SEVERITY: Record<AttentionFindingView['severity'], { label: string; color: string }> = {
  act: { label: 'act', color: '#b91c1c' },
  review: { label: 'review', color: '#92400e' },
  note: { label: 'note', color: '#64748b' },
};

/** The kinds, in a person's words. The vocabulary is Ring 0's; this is only the reading of it. */
const KIND_LABEL: Record<AttentionFindingView['kind'], string> = {
  'unreadable-record': 'a record could not be read',
  'conflicting-sources': 'the record disagrees with itself',
  'tool-failure': 'a step failed',
  'effect-uncertain': 'unknown — reconciling',
  'export-missing': 'no provenance was written',
  'mandate-not-presented': 'waiting for a signature',
  'commitment-past-deadline': 'a commitment passed its deadline',
};

export function NeedsAttention({ token, addressee, onOpenRun }: { token: string; addressee: Address; onOpenRun?: (runRef: string) => void }) {
  const [state, setState] = useState<{ findings: AttentionFindingView[]; considered: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setState(null); setErr(null);
    void fetchAttention({ token }, addressee).then((r) => {
      if (!live) return;
      if ('error' in r) setErr(r.error); else setState(r);
    });
    return () => { live = false; };
  }, [token, addressee]);

  if (err) return <p className="muted small" style={{ color: '#92400e' }}>The attention feed could not be read: {err}</p>;
  if (!state) return <p className="muted small">Reading what needs you…</p>;

  if (state.findings.length === 0) {
    // Said with its denominator. "Nothing needs you" over zero runs is a different sentence from the same
    // words over two hundred, and a reader deserves to know which one they are being told.
    return <p className="muted small">Nothing needs you across {state.considered} run(s) read.</p>;
  }

  // One group per kind, in the order Ring 0 ranked them (severity first) — the grouping preserves that order
  // by keying off first appearance rather than re-sorting.
  const groups: Array<{ kind: AttentionFindingView['kind']; severity: AttentionFindingView['severity']; detail: string; runRefs: string[] }> = [];
  for (const f of state.findings) {
    const g = groups.find((x) => x.kind === f.kind);
    if (g) { if (f.runRef) g.runRefs.push(f.runRef); }
    else groups.push({ kind: f.kind, severity: f.severity, detail: f.detail, runRefs: f.runRef ? [f.runRef] : [] });
  }

  return (
    <div>
      <p className="muted small" style={{ marginBottom: '.5rem' }}>
        {state.findings.length} finding(s) across {state.considered} run(s) read. Each says what was observed; what to do about it is yours.
      </p>
      <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '.55rem' }}>
        {groups.map((g) => (
          <li key={g.kind} style={{ borderLeft: `3px solid ${SEVERITY[g.severity].color}`, paddingLeft: '.6rem' }}>
            <div style={{ display: 'flex', gap: '.6rem', alignItems: 'baseline' }}>
              <span style={{ fontSize: '.7rem', textTransform: 'uppercase', letterSpacing: '.05em', color: SEVERITY[g.severity].color, minWidth: '3.2rem' }}>
                {SEVERITY[g.severity].label}
              </span>
              <span style={{ minWidth: 0 }}>
                <strong style={{ fontWeight: 600 }}>{KIND_LABEL[g.kind]}</strong>
                {g.runRefs.length > 1 && <span style={{ opacity: 0.7 }}> · {g.runRefs.length} runs</span>}
                <span style={{ opacity: 0.8 }}> — {g.detail}</span>
              </span>
            </div>
            {onOpenRun && g.runRefs.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '.3rem', margin: '.3rem 0 0 3.8rem' }}>
                {/* The runs stay reachable: the group says how many, these open them. Capped so one noisy kind
                    cannot push every other finding off the screen — the count above is the honest total. */}
                {g.runRefs.slice(0, 8).map((rr) => (
                  <button key={rr} type="button" className="btn-ghost" style={{ padding: '.1rem .4rem', fontSize: '.74rem' }} onClick={() => onOpenRun(rr)}>
                    {rr.slice(-8)}
                  </button>
                ))}
                {g.runRefs.length > 8 && <span className="muted small" style={{ alignSelf: 'center' }}>+{g.runRefs.length - 8} more in the log below</span>}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
