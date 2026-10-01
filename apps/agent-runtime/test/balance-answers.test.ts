// A FACT WORD HAS TO BE ONE ONLY A MONEY QUESTION USES. `treasury.balance.read` declares the words a balance question
// names its fact with, and spec 371's admission rule refuses a plan that answers such a question with some other read.
// Live 2026-10-01 (held-out 8, every run of both arms): "do a disparate impact review of the scholarship ranking tool —
// who is affected and by how much" was refused with "use treasury.balance.read for that" — the bare "how much" matched.
// The money forms must still match; the bare quantifier must not.
import { describe, it, expect } from 'vitest';
import { questionAnsweredByRead } from '@agenticprimitives/orchestration';
import { BALANCE_READ_TOOL } from '../src/balance-read.js';

const FAIRNESS = { id: 'cic.governance.fairness', description: 'disparate impact review', inputSchema: { type: 'object', properties: {} } } as const;
const run = (goal: string) => questionAnsweredByRead({ intent: { goal }, plan: { steps: [{ toolId: FAIRNESS.id, args: {} }] }, tools: [BALANCE_READ_TOOL, FAIRNESS as never] });

describe('treasury.balance.read answers', () => {
  it('does not claim a fairness review that asks "by how much"', async () => {
    expect(await run('Do a disparate impact review of the scholarship ranking tool — who is affected and by how much.')).toEqual([]);
    expect(await run('How much did the ranking tool change acceptance rates for rural applicants?')).toEqual([]);
  });
  it('still claims a money question a different read would answer wrongly', async () => {
    for (const q of ['how much money do we have', 'what is the balance', 'how much is in the missio nexus treasury?', 'how much do we have in our treasury']) {
      const v = await run(q);
      expect(v.map((x) => x.code), q).toEqual(['QUESTION_NOT_ANSWERED']);
      expect(v[0]!.toolId).toBe('treasury.balance.read');
    }
  });
});
