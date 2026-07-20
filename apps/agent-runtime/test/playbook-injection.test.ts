// spec 327 §4b / 334 §6 — the org's steward-authored playbook now reaches the COORDINATION turns
// (plan-draft + work + synthesis), not just the discussion assistant. The prompt-assembly invariant
// is what makes that safe: the org's guidance is prepended AS CONTEXT, and the turn's non-negotiable
// tool contract is kept AFTER it so the must-call-the-tool / never-prose guarantee always wins.
import { describe, expect, it } from 'vitest';

import { withPlaybook } from '../src/orchestration.js';

const CONTRACT = 'Call draft_plan exactly once. Never answer in prose.';

describe('withPlaybook — coordination playbook injection', () => {
  it('returns the contract unchanged when no playbook is authored (backward compatible)', () => {
    expect(withPlaybook(undefined, CONTRACT)).toBe(CONTRACT);
    expect(withPlaybook('', CONTRACT)).toBe(CONTRACT);
    expect(withPlaybook('   \n  ', CONTRACT)).toBe(CONTRACT);
  });

  it('prepends the org playbook and keeps the contract LAST (contract wins)', () => {
    const playbook = 'We track unreached people groups. Never state a figure as fact.';
    const out = withPlaybook(playbook, CONTRACT);
    expect(out).toContain(playbook);
    expect(out.indexOf(playbook)).toBeLessThan(out.indexOf(CONTRACT));
    // The contract is the final instruction the model reads.
    expect(out.endsWith(CONTRACT)).toBe(true);
  });

  it('trims surrounding whitespace on the authored playbook', () => {
    const out = withPlaybook('  hello  ', CONTRACT);
    expect(out).toContain('\nhello\n');
    expect(out).not.toContain('  hello  ');
  });
});
