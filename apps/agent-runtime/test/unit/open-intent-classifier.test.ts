// Spec 410 §6 — the Ask's classifier over the PUBLISHED outcome table: the sentence the spec's fixture uses ("organize
// the gathering for under two thousand") is recognised from the ontology's own words, its bounds read, and the stated
// outcome is what `outcomeConformance` then judges the plan against. A closed intent is never stamped.
import { describe, expect, it } from 'vitest';
import { classifyOpenIntent, outcomeConformance, planAdmission } from '@agenticprimitives/orchestration';
import { OUTCOME_CLASSES, outcomeClassOf } from '@agenticprimitives/ontology';
import { HARNESS_ACTION_TOOLS } from '../../src/harness-run.js';

describe('the Ask classifies an open intent from the ontology\'s words', () => {
  it('"organize the gathering for under $2,000 at the hall" → OrganizedGathering, budget 2000, venue "the hall"', () => {
    const stated = classifyOpenIntent('organize the gathering for under $2,000 at the hall', OUTCOME_CLASSES);
    expect(stated).toEqual({ class: 'https://agenticprimitives.dev/ns/intent#OrganizedGathering', bounds: { budget: 2000, venue: 'the hall' } });
  });
  it('a closed ask is not an outcome: "pay alice 10 usdc", "invite sarah to missio nexus"', () => {
    expect(classifyOpenIntent('pay alice 10 usdc', OUTCOME_CLASSES)).toBeNull();
    expect(classifyOpenIntent('invite sarah to missio nexus', OUTCOME_CLASSES)).toBeNull();
  });
  it('the stated outcome bounds the plan: a deposit above the budget, or an effect the gathering does not entail, is refused before any signature', async () => {
    const stated = classifyOpenIntent('organize the gathering for under $2,000 at the hall', OUTCOME_CLASSES)!;
    const intent = { goal: 'organize the gathering for under $2,000 at the hall', constraints: { outcome: stated } };
    const tools = HARNESS_ACTION_TOOLS;
    const admission = planAdmission([outcomeConformance(outcomeClassOf)]);
    const over = await admission.admit({ intent, tools, plan: { steps: [{ toolId: 'treasury.payment.execute', args: { payer: '0x0a60000000000000000000000000000000000001', payee: 'venue.treasury', usdc: '2500', amount: '2500' } }] } } as never);
    expect(over.admitted).toBe(false);
    if (!over.admitted) expect(JSON.stringify(over.violations)).toMatch(/OUTCOME_BOUND_EXCEEDED/);
    const foreign = await admission.admit({ intent, tools, plan: { steps: [{ toolId: 'organization.membership.invite', args: { org: '0x0a60000000000000000000000000000000000002', invitee: 'sarah' } }] } } as never);
    expect(foreign.admitted).toBe(false);
    if (!foreign.admitted) expect(JSON.stringify(foreign.violations)).toMatch(/OUTCOME_NOT_ENTAILED/);
  });
});
