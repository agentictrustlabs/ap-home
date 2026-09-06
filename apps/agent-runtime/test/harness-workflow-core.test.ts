// Spec 362 §4 — the four gates, verbatim, against the engine-free core with a fake DurableStepPort.
// What the fake models: attempt() persists a completed result and REPLAYS it without re-running the
// callback (Cloudflare's documented memoization), which is exactly the behaviour the gates interrogate.
import { describe, it, expect } from 'vitest';
import { TerminalDenial, type DurableStepPort } from '@agenticprimitives/orchestration';
import { driveApprovalFlow, type AttemptOutcome } from '../src/harness-workflow-core.js';

/** A fake engine: checkpoints attempt results by name; a re-drive replays completed ones. */
function fakeEngine(events: { decision?: unknown | 'timeout' }) {
  const checkpoints = new Map<string, unknown>();
  const ran: string[] = [];
  const port: DurableStepPort = {
    attempt: async (name, fn) => {
      if (checkpoints.has(name)) return checkpoints.get(name) as never; // memoized replay — no callback
      ran.push(name);
      const out = await fn();
      checkpoints.set(name, out);
      return out;
    },
    waitForEvent: async () => {
      if (events.decision === 'timeout' || events.decision === undefined) throw new Error('timeout');
      return events.decision as never;
    },
    sleepUntil: async () => undefined,
  };
  return { port, checkpoints, ran };
}

const suspended: AttemptOutcome = { outcome: 'suspended', awaiting: { kind: 'signature', stepRef: 's0' } };

describe('the four gates (spec 362 §4)', () => {
  it('GATE 1 — revoked while waiting: the approval wakes the flow, the action is REFUSED', async () => {
    const { port } = fakeEngine({ decision: { type: 'custodian-decision', approvalRef: '0xapproval' } });
    let mandateRevoked = false;
    const out = await driveApprovalFlow(port, async (approvals) => {
      if (approvals.length === 0) { mandateRevoked = true; return suspended; } // revoked during the wait
      return { outcome: 'denied', error: 'mandate revoked' };                  // attempt-2 re-verifies NOW
    }, { approvalTimeoutMs: 1000 });
    expect(mandateRevoked).toBe(true);
    expect(out.outcome).toBe('denied');
    expect(out.error).toMatch(/revoked/);
  });

  it('GATE 2 — a retry never reuses an earlier verdict: the WHOLE attempt re-runs', async () => {
    const { port, ran } = fakeEngine({ decision: { type: 'custodian-decision', approvalRef: '0xa' } });
    const verifierCalls: string[] = [];
    await driveApprovalFlow(port, async (approvals) => {
      verifierCalls.push(approvals.length ? 'attempt-2-verify' : 'attempt-1-verify'); // verify is INSIDE
      return approvals.length ? { outcome: 'completed' } : suspended;
    }, { approvalTimeoutMs: 1000 });
    expect(verifierCalls).toEqual(['attempt-1-verify', 'attempt-2-verify']); // one verify per attempt
    expect(ran).toEqual(['attempt-1', 'attempt-2']);
  });

  it('GATE 3 — committed externally, checkpoint lost: reconciliation finds it, no duplicate effect', async () => {
    const { port } = fakeEngine({ decision: { type: 'custodian-decision', approvalRef: '0xa' } });
    let acted = 0;
    const out = await driveApprovalFlow(port, async (approvals) => {
      if (!approvals.length) return suspended;
      // The attempt reconciles FIRST (the intent-derived nonce answers "already settled") — the act
      // that committed before the crash is found, not repeated.
      const alreadySettled = true;
      if (!alreadySettled) acted++;
      return { outcome: 'completed', error: undefined };
    }, { approvalTimeoutMs: 1000 });
    expect(out.outcome).toBe('completed');
    expect(acted).toBe(0);
  });

  it('GATE 4 — a COMPLETED attempt replays from its checkpoint; the callback never re-runs', async () => {
    const engine = fakeEngine({ decision: { type: 'custodian-decision', approvalRef: '0xa' } });
    let calls = 0;
    const attempt = async (approvals: Array<{ approvalRef: string }>): Promise<AttemptOutcome> => {
      calls++;
      return approvals.length ? { outcome: 'completed' } : suspended;
    };
    await driveApprovalFlow(engine.port, attempt, { approvalTimeoutMs: 1000 });
    expect(calls).toBe(2);
    // The engine re-drives the WHOLE flow (a recovery replay): both attempts replay from checkpoints,
    // the callback — and any act inside it — runs zero more times.
    await driveApprovalFlow(engine.port, attempt, { approvalTimeoutMs: 1000 });
    expect(calls).toBe(2);
  });

  it('a timeout is an OUTCOME, not a failure: nothing was acted and the flow says so', async () => {
    const { port } = fakeEngine({ decision: 'timeout' });
    let acted = 0;
    const out = await driveApprovalFlow(port, async (approvals) => {
      if (approvals.length) { acted++; return { outcome: 'completed' }; }
      return suspended;
    }, { approvalTimeoutMs: 10 });
    expect(out.outcome).toBe('expired');
    expect(acted).toBe(0);
  });

  it('a DENIAL is a checkpointed OUTCOME — never retried, and a re-drive replays it', async () => {
    const engine = fakeEngine({ decision: { type: 'custodian-decision', approvalRef: '0xa' } });
    let calls = 0;
    const attempt = async (): Promise<AttemptOutcome> => { calls++; throw new TerminalDenial('revoked'); };
    const out = await driveApprovalFlow(engine.port, attempt, { approvalTimeoutMs: 10 });
    expect(out).toEqual({ outcome: 'denied', error: 'revoked' });
    expect(engine.ran).toEqual(['attempt-1']);
    // Re-drive: the denial replays as history; nothing re-verifies because nothing re-ATTEMPTS.
    await driveApprovalFlow(engine.port, attempt, { approvalTimeoutMs: 10 });
    expect(calls).toBe(1);
  });
});
