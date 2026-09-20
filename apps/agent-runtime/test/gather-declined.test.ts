import { describe, it, expect } from 'vitest';
import { playbookDeclinesGather } from '../src/endeavor-work-skill.js';

describe('a playbook may decline the gather phase', () => {
  it('honours a `Gather: none` line wherever it sits, with words after it', () => {
    expect(playbookDeclinesGather('# Agent\n\nGather: none — the facts arrive with the question as Reference attention.\n')).toBe(true);
    expect(playbookDeclinesGather('gather:none')).toBe(true);
    expect(playbookDeclinesGather('  GATHER : NONE')).toBe(true);
  });
  it('is not fooled by prose that merely mentions gathering', () => {
    expect(playbookDeclinesGather('Stale gathering (~21 days) informs ranking.')).toBe(false);
    expect(playbookDeclinesGather('Gather: the claims record and the attestations.')).toBe(false);
    expect(playbookDeclinesGather('Gather: nonetheless read the claims')).toBe(false);
    expect(playbookDeclinesGather(undefined)).toBe(false);
  });
});
