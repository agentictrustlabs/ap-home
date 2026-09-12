// Spec 398 §5.1 — the TABLE TEST: every native word a Home surface can hand the projection has a row, and the
// projection is the same set wherever it is asked. A word without a row renders as `failed` with the native
// word kept (never a blank, never a plausible guess).
import { describe, it, expect, vi } from 'vitest';
import { stateOf, nativeWord, runStateLabel, STATE_TONE, stateTone, RUN_STATES } from './run-state';
import { lifecycleState, LIFECYCLE_LABEL } from '../components/portal/work/labels';

describe('one state vocabulary (398 §5.1)', () => {
  it('a finished run (350 RunOutcome) — RunHistory', () => {
    expect(stateOf({ kind: 'run', outcome: 'completed' }).state).toBe('completed');
    expect(stateOf({ kind: 'run', outcome: 'failed' }).state).toBe('failed');
    expect(stateOf({ kind: 'run', outcome: 'denied' }).state).toBe('failed');
    expect(stateOf({ kind: 'run', outcome: 'authority-required' }).state).toBe('awaiting-approval');
    expect(stateOf({ kind: 'run', outcome: 'suspended', awaiting: 'data' }).state).toBe('awaiting-input');
    expect(stateOf({ kind: 'run', outcome: 'suspended', awaiting: 'signature' }).state).toBe('awaiting-approval');
  });

  it('a parked run (350 W3) — MyWorkView', () => {
    expect(runStateLabel(stateOf({ kind: 'suspended', awaiting: 'signature', expired: false }))).toBe('waiting for a signature');
    expect(runStateLabel(stateOf({ kind: 'suspended', awaiting: 'data', expired: false }))).toBe('waiting for an answer');
    expect(stateOf({ kind: 'suspended', awaiting: 'commitment', expired: false }).state).toBe('blocked');
    expect(stateOf({ kind: 'suspended', awaiting: 'data', expired: true }).state).toBe('expired');
  });

  it('every endeavor lifecycle (334) the Work screens show — OrgWorkView, MyWorkView, the detail', () => {
    const expected: Record<keyof typeof LIFECYCLE_LABEL, string> = {
      proposed: 'drafted', adopted: 'queued', active: 'running', suspended: 'blocked', satisfied: 'completed', abandoned: 'canceled',
    };
    for (const [lc, want] of Object.entries(expected)) {
      const p = lifecycleState(lc);
      expect(p.state, lc).toBe(want);
      expect(p.unknownNative, lc).toBeUndefined();
    }
  });

  it("every trigger outcome (375) the schedule shows — TriggersPanel", () => {
    expect(stateOf({ kind: 'trigger', lastOutcome: 'answered' }).state).toBe('completed');
    expect(stateOf({ kind: 'trigger', lastOutcome: 'parked' }).state).toBe('awaiting-approval');
    expect(stateOf({ kind: 'trigger', lastOutcome: 'failed' }).state).toBe('failed');
    expect(stateOf({ kind: 'trigger', lastOutcome: 'answered', paused: true }).state).toBe('blocked');
  });

  it('effect-uncertain is never collapsed into failed (T10)', () => {
    const p = stateOf({ kind: 'run', outcome: 'failed' }, { effectUncertain: true });
    expect(p.state).not.toBe('failed');
    expect(p.effectUncertain).toBe(true);
    expect(runStateLabel(p)).toBe('unknown — reconciling');
    expect(stateTone(p)).toBe('uncertain');
  });

  it('a word nobody mapped renders as failed WITH the native word, and says so', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const p = stateOf({ kind: 'endeavor', lifecycle: 'vibing' });
    expect(p.state).toBe('failed');
    expect(p.unknownNative).toBe('vibing');
    expect(err).toHaveBeenCalledOnce();
    err.mockRestore();
  });

  it('every projected state has a tone and a label; the native word survives for the tooltip', () => {
    for (const s of RUN_STATES) {
      expect(STATE_TONE[s]).toBeTruthy();
      expect(runStateLabel({ state: s, effectUncertain: false })).toBeTruthy();
    }
    expect(nativeWord({ kind: 'endeavor', lifecycle: 'adopted' })).toBe('adopted');
    expect(nativeWord({ kind: 'run', outcome: 'suspended', awaiting: 'signature' })).toBe('suspended (signature)');
    expect(nativeWord({ kind: 'trigger', lastOutcome: 'answered', paused: true })).toBe('paused');
  });
});
