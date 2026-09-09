// The planner is shown the playbook's DOCTRINE, never the per-act execution bodies the compiler appends.
import { describe, expect, it } from 'vitest';
import { plannerDoctrineOf, ACT_SECTIONS_HEADING } from '../src/harness-run.js';

const doctrine = 'You are a **Person Steward**.\n\n## Whose agent you are\n\n- One person.\n\n## How you answer\n\n- From your tools.';
const acts = '### person-treasury-fund — Funds a treasury\n\nlong body\n\n### treasury-payment-execute — Moves value\n\nlonger body';

describe('plannerDoctrineOf', () => {
  it('keeps everything before the compiler\'s act sections and records the share', () => {
    const whole = `${doctrine}${ACT_SECTIONS_HEADING}\nOne section per act.\n\n${acts}`;
    const out = plannerDoctrineOf(whole);
    expect(out.text).toBe(doctrine);
    expect(out.text).not.toContain('person-treasury-fund');
    expect(out).toMatchObject({ chars: doctrine.length, of: whole.length });
  });
  it('renders an instructions document without the heading WHOLE — nothing is cut by a budget', () => {
    const out = plannerDoctrineOf(doctrine);
    expect(out.text).toBe(doctrine);
    expect(out.chars).toBe(out.of);
  });
  it('splits on the heading as a line, not on the words inside prose', () => {
    const prose = 'The section called "How each act is done" is for the executor.';
    expect(plannerDoctrineOf(prose).text).toBe(prose);
  });
});
