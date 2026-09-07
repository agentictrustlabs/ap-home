import { describe, expect, it } from 'vitest';
import { labelFromName, CHILD_LABEL_PATTERN } from '../src/harness-run.js';

// Spec 369 — a name is what the person SAID. The typed suffix says the kind, so the kind word is not part
// of the label; spaces become hyphens; a label that is already a label passes through.
describe('the label a spoken name becomes', () => {
  const org = (s: string) => labelFromName(s, 'organization', 'org');
  it('drops the kind word and hyphenates the rest', () => {
    expect(org('abc organization')).toBe('abc');
    expect(org('ABC Organization')).toBe('abc');
    expect(org('abc org')).toBe('abc');
    expect(org('Riverside Fellowship')).toBe('riverside-fellowship');
    expect(labelFromName('the outreach team', 'team', 'team')).toBe('outreach');
    expect(labelFromName("St. Mary's household", 'household', 'household')).toBe('st-marys');
  });
  it('keeps a word that is the whole name, and a label that is already valid', () => {
    expect(org('organization')).toBe('organization');
    expect(org('voice-test-abc')).toBe('voice-test-abc');
    expect(labelFromName('first baptist church', 'organization', 'org')).toBe('first-baptist-church');
  });
  it('yields a label the pattern accepts for ordinary names', () => {
    for (const n of ['abc organization', 'Riverside Fellowship', 'Team 42']) expect(new RegExp(CHILD_LABEL_PATTERN).test(labelFromName(n, 'organization', 'org'))).toBe(true);
  });
});
