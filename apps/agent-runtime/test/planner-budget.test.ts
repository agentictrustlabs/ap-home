// A provider's prompt budget is met by dropping WHOLE named parts in a fixed order, every drop recorded.
import { describe, expect, it } from 'vitest';
import { fitPlannerPrompt, estimatePromptTokens, utteranceExamples } from '../src/harness-run.js';

const doctrine = 'You are a steward.\n\n## Whose agent you are\n\n' + 'x'.repeat(4000) + '\n\n## How you answer\n\n' + 'y'.repeat(4000);
const contract = (turns: number) => `RULES\nRECENT (${turns} turns): ${'r'.repeat(turns * 300)}`;
const tools = [{ id: 'a.b', description: 'd'.repeat(300), inputSchema: { type: 'object', properties: { x: { type: 'string', description: 'e'.repeat(200) } } } }];
const contractTools = [
  { id: 'a.b', utterances: [{ says: 'do a', args: { x: '1' } }, { says: 'do a again', args: { x: '2' } }, { says: 'not a', isNot: 'a question' }] },
  { id: 'c.d', utterances: [{ says: 'do c' }, { says: 'do c twice' }] },
];
const examples = (positives?: number) => utteranceExamples(contractTools, positives);
const parts = { doctrine, contract, examples };

describe('fitPlannerPrompt', () => {
  it('sends everything when it fits, and records no drop', () => {
    const out = fitPlannerPrompt(parts, tools, 'Goal: do a', 100_000);
    expect(out.trimmed).toEqual([]);
    expect(out.text).toContain('do a again');
    expect(out.text).toContain('## How you answer');
  });
  it('drops in order: extra positives, then conversation, then doctrine sections, then all positives', () => {
    const full = estimatePromptTokens(fitPlannerPrompt(parts, tools, 'g', 100_000).text, tools, 'g');
    const one = fitPlannerPrompt(parts, tools, 'g', full - 1);
    expect(one.trimmed).toEqual(['examples:one-positive-per-tool']);
    expect(one.text).toContain('"do a" →'); expect(one.text).not.toContain('do a again'); expect(one.text).toContain('NOT a.b');
    const tight = fitPlannerPrompt(parts, tools, 'g', 900);
    expect(tight.trimmed).toEqual(['examples:one-positive-per-tool', 'conversation:2-turns', 'doctrine:opening-only']);
    expect(tight.text.startsWith('You are a steward.')).toBe(true);
    expect(tight.text).not.toContain('## Whose agent you are');
    expect(tight.text).toContain('(2 turns)');
    expect(tight.estimated).toBeLessThanOrEqual(900);
  });
  it('says over-budget rather than pretending, and still keeps the negatives', () => {
    const out = fitPlannerPrompt(parts, tools, 'g', 10);
    expect(out.trimmed.at(-1)).toBe('over-budget');
    expect(out.text).toContain('NOT a.b');
    expect(out.text).not.toContain('"do a" →');
  });
});

describe('utteranceExamples under a cap', () => {
  it('keeps every negative and the first N positives per tool', () => {
    expect((utteranceExamples(contractTools).match(/^- /gm) ?? []).length).toBe(5);
    const capped = utteranceExamples(contractTools, 1);
    expect((capped.match(/^- /gm) ?? []).length).toBe(3);
    expect(capped).toContain('NOT a.b');
    expect(utteranceExamples(contractTools, 0)).not.toContain('→ a.b {');
  });
});
