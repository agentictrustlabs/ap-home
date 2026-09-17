/**
 * RULES FIRST, A MODEL ONLY WHEN THE RULES CANNOT DECIDE.
 *
 * `selectPlanner` reaches the deterministic planner only when NO provider is configured, so on any
 * credentialed deployment every intent cost a model call — including the machine-written ones that are not
 * questions. An app driving this at volume was paying a planner turn to be told what a regular expression
 * already knew.
 */
import { describe, expect, it } from 'vitest';
import { OrchestrationError, type Plan, type Planner } from '@agenticprimitives/orchestration';
import { ORCHESTRATION_TOOLS, preplanEnabled, rulesFirst } from '../src/orchestration';

/** A model that records having been asked, so "did this cost a call" is a fact and not an inference. */
const spyModel = () => {
  const asked: string[] = [];
  const planner: Planner = {
    async plan({ intent }) {
      asked.push(intent.goal);
      return { steps: [{ toolId: 'get_pii', args: {} }], rationale: 'model' } satisfies Plan;
    },
  };
  return { planner, asked };
};
const plan = (p: Planner, goal: string) => p.plan({ intent: { goal, context: {} }, tools: ORCHESTRATION_TOOLS });

describe('a goal the rules already answer never reaches the model', () => {
  it('plans an anchored, app-written goal deterministically and asks nothing', async () => {
    const m = spyModel();
    const got = await plan(rulesFirst(m.planner), 'read vault record cardroom.hand');
    expect(got.steps).toEqual([{ toolId: 'get_vault_record', args: { recordType: 'cardroom.hand' } }]);
    expect(got.rationale).toMatch(/rule-based/);
    expect(m.asked).toEqual([]);
  });

  it('plans a bare list the same way', async () => {
    const m = spyModel();
    const got = await plan(rulesFirst(m.planner), 'list vault records');
    expect(got.steps).toEqual([{ toolId: 'list_vault_record', args: {} }]);
    expect(m.asked).toEqual([]);
  });

  /**
   * THE LINE. The fuzzy keyword rules exist to give a MODELLESS deployment something reasonable, and they are
   * too eager to sit in front of a model: /profile|pii|personal/ would swallow a goal a single tool call
   * cannot answer. Only the anchored, machine-written ones short-circuit.
   */
  it('sends a real question to the model, however many rule words it contains', async () => {
    const m = spyModel();
    const goal = 'summarise my profile and draft an introduction for the club';
    const got = await plan(rulesFirst(m.planner), goal);
    expect(got.rationale).toBe('model');
    expect(m.asked).toEqual([goal]);
  });

  it('is off when the deployment says so, and on by default', async () => {
    expect(preplanEnabled({})).toBe(true);
    expect(preplanEnabled({ ORCHESTRATION_PREPLAN: 'off' })).toBe(false);
    expect(preplanEnabled({ ORCHESTRATION_PREPLAN: 'OFF' })).toBe(false);
    const m = spyModel();
    await plan(rulesFirst(m.planner, false), 'list vault records');
    expect(m.asked).toEqual(['list vault records']);
  });

  /** A matched rule that cannot build a plan is the model's turn, not an error. */
  it('falls through to the model when the rule matches but its tool is not exposed', async () => {
    const m = spyModel();
    const narrow: Planner = rulesFirst(m.planner);
    const got = await narrow.plan({ intent: { goal: 'list vault records', context: {} }, tools: [] });
    expect(got.rationale).toBe('model');
    expect(m.asked).toEqual(['list vault records']);
  });

  it('propagates a planner error that is not "no plan"', async () => {
    const boom: Planner = { async plan() { throw new OrchestrationError('tool_failed', 'upstream down'); } };
    await expect(plan(rulesFirst(boom), 'anything at all')).rejects.toThrow(/upstream down/);
  });
});
