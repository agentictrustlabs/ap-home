// Spec 382 W2 as Ask capabilities — the Work family's execution parity (361 I4 / 398 G1): the two acts the Home's
// Work screen could only reach through its own /connect/work route become tools of the organization's agent, so
// the screen and the Ask run the same op under the same standing. The invoker maps the tool's arguments onto the
// InteractionsDO op the route already called; the reducer's gates (only the participant withdraws; only a steward
// reallocates) are the DO's, unchanged.
import { describe, it, expect } from 'vitest';
import {
  COMMITMENT_REALLOCATE_CAPABILITY, COMMITMENT_REALLOCATE_TOOL, COMMITMENT_WITHDRAW_CAPABILITY, COMMITMENT_WITHDRAW_TOOL,
  COORDINATION_ACTION_TOOLS, endeavorActInvoker,
} from '../../src/coordination-bindings.js';

const ORG = '0x00000000000000000000000000000000000000aa' as `0x${string}`;
const ME = '0x00000000000000000000000000000000000000bb' as `0x${string}`;
const CAROL = '0x00000000000000000000000000000000000000cc' as `0x${string}`;

function harness() {
  const calls: Array<{ principal: string; op: string; body: Record<string, unknown> }> = [];
  const deps = {
    addresseeKind: 'org',
    interactionsOp: async (principal: `0x${string}`, op: string, body: Record<string, unknown>) => {
      calls.push({ principal, op, body });
      return op === 'endeavor.reallocate' ? { ok: true, allocationId: 'alloc_new', commitmentId: body.commitmentId } : { ok: true, commitmentId: body.commitmentId };
    },
    // No stewardship wire in this test: the DO decides; the invoker forwards the session and nothing else.
    readSubjectRecord: async () => null,
  } as never;
  return { calls, invoke: endeavorActInvoker(deps, ORG, ME, 'sess-token') };
}

describe('coordination.commitment.withdraw / reallocate — the Work screen\'s acts as tools', () => {
  it('both are offered among the coordination acts, on the org as resource and authority', () => {
    for (const t of [COMMITMENT_WITHDRAW_TOOL, COMMITMENT_REALLOCATE_TOOL]) {
      expect(COORDINATION_ACTION_TOOLS).toContain(t);
      expect(t.capability).toMatchObject({ resourceArg: 'org', authorityArg: 'org' });
      expect(t.risk).toBe('medium');
      expect(t.establishes).toBe('authoritative');
    }
  });

  it('withdraw maps to the DO\'s endeavor.withdrawCommitment with the reason, under the person\'s session', async () => {
    const { calls, invoke } = harness();
    const out = await invoke(COMMITMENT_WITHDRAW_CAPABILITY, { org: ORG, endeavorId: 'end_1', commitmentId: 'commit_9', note: 'travelling that week' }, {} as never) as Record<string, unknown>;
    expect(calls).toEqual([{ principal: ORG, op: 'endeavor.withdrawCommitment', body: { session: 'sess-token', endeavorId: 'end_1', commitmentId: 'commit_9', reason: 'travelling that week' } }]);
    expect(out.commitmentId).toBe('commit_9');
    expect(String(out.note)).toMatch(/back in the pool/);
  });

  it('reallocate maps to endeavor.reallocate with a RESOLVED participant, and refuses a name', async () => {
    const { calls, invoke } = harness();
    await expect(invoke(COMMITMENT_REALLOCATE_CAPABILITY, { org: ORG, endeavorId: 'end_1', commitmentId: 'commit_9', participant: 'carol' }, {} as never)).rejects.toThrow(/resolved agent/);
    expect(calls).toEqual([]);
    const out = await invoke(COMMITMENT_REALLOCATE_CAPABILITY, { org: ORG, endeavorId: 'end_1', commitmentId: 'commit_9', participant: CAROL }, {} as never) as Record<string, unknown>;
    expect(calls[0]).toEqual({ principal: ORG, op: 'endeavor.reallocate', body: { session: 'sess-token', endeavorId: 'end_1', commitmentId: 'commit_9', participant: CAROL } });
    expect(out.allocationId).toBe('alloc_new');
    expect(String(out.note)).toMatch(/nothing was granted/);
  });
});
