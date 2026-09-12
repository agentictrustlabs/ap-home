// ONE STATE VOCABULARY, EVERYWHERE — spec 398 §5.1 (APUX-024). A Home surface never renders a record's NATIVE state
// (a run's `outcome`, a task's `input-required`, an endeavor's `adopted`, a trigger's `answered`): it renders the
// projection `@agenticprimitives/harness/run-state` makes — the same pure table the runtime's `/harness/runs` and
// the Home MCP project from — so "waiting for a signature" is one phrase wherever a person meets it. What this
// module adds is only the Home's side: the tone a pill takes, and the native word kept as a TOOLTIP (the domain's
// own term — "Planning", "Requested" — is still worth seeing; it is just not the state).
//
// `effect-uncertain` is orthogonal and never collapsed into `failed` (T10): the pill says "unknown — reconciling"
// and no retry is offered on it. Nothing here is authority: a state is a word for a person; no gate reads it.
import { projectRunState, runStateLabel, RUN_STATES, type AwaitingKind, type ProjectedRunStateV1, type RunStateSource, type RunStateV1 } from '@agenticprimitives/harness/run-state';

export { projectRunState, runStateLabel, RUN_STATES };
export type { AwaitingKind, ProjectedRunStateV1, RunStateSource, RunStateV1 };

/** The tone a pill takes — five, not eleven: a person reads the colour before the word. */
export type StateTone = 'idle' | 'active' | 'attention' | 'done' | 'bad';

export const STATE_TONE: Record<RunStateV1, StateTone> = {
  drafted: 'idle',
  queued: 'idle',
  running: 'active',
  recovering: 'active',
  'awaiting-input': 'attention',
  'awaiting-approval': 'attention',
  blocked: 'attention',
  completed: 'done',
  failed: 'bad',
  canceled: 'idle',
  expired: 'idle',
};

/** `effect-uncertain` is its own tone: neither running nor failed, and never the colour of either. */
export function stateTone(p: ProjectedRunStateV1): StateTone | 'uncertain' {
  return p.effectUncertain ? 'uncertain' : STATE_TONE[p.state];
}

/** Project, refusing nothing at render time: a word the table does not know renders as `failed` WITH the native
 *  word in the tooltip and a console error — a screen must not blank on one unknown row, and the unknown must
 *  not pass as a plausible state either. */
export function stateOf(source: RunStateSource, opts: { effectUncertain?: boolean } = {}): ProjectedRunStateV1 & { unknownNative?: string } {
  try {
    return projectRunState(source, opts);
  } catch (e) {
    const native = nativeWord(source);
    console.error(`[run-state] ${e instanceof Error ? e.message : String(e)} — rendered as failed`);
    return { state: 'failed', effectUncertain: false, unknownNative: native };
  }
}

/** The record's own word, for the tooltip. */
export function nativeWord(source: RunStateSource): string {
  switch (source.kind) {
    case 'run': return source.canceled ? 'canceled' : source.expired ? 'expired' : source.awaiting ? `${source.outcome} (${source.awaiting})` : source.outcome;
    case 'suspended': return source.expired ? 'expired' : `suspended${source.awaiting ? ` (${source.awaiting})` : ''}`;
    case 'task': return source.state;
    case 'recovering': return 'recovering';
    case 'trigger': return source.paused ? 'paused' : source.lastOutcome;
    case 'endeavor': return source.lifecycle;
    case 'step': return source.status;
  }
}
