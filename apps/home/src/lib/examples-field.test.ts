import { describe, it, expect } from 'vitest';
import { parseExamples, MAX_EXAMPLES } from './examples-field';

describe('parseExamples', () => {
  it('keeps the spaces INSIDE an example — the whole point is a phrase', () => {
    expect(parseExamples('what did this change')).toEqual(['what did this change']);
  });

  it('splits on the pipe and trims around it, not within', () => {
    expect(parseExamples('summarize my spend | what changed last week'))
      .toEqual(['summarize my spend', 'what changed last week']);
  });

  it('drops empty segments so a stray pipe is not an example', () => {
    expect(parseExamples('one || two |')).toEqual(['one', 'two']);
  });

  it('caps at what ARD allows, so a projection cannot over-claim', () => {
    expect(parseExamples(Array.from({ length: 9 }, (_, i) => `q${i}`).join('|'))).toHaveLength(MAX_EXAMPLES);
  });

  it('a half-typed trailing space parses to the word — the FIELD keeps the space, the record does not', () => {
    // Both halves matter: the stored value is trimmed, and (in the component) the text on screen is not.
    // Round-tripping the parsed value back into the input is what ate the space.
    expect(parseExamples('ad ')).toEqual(['ad']);
    expect(parseExamples('ad ').join(' | ')).not.toBe('ad ');
  });
});
