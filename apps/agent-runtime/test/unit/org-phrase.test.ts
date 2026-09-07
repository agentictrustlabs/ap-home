import { describe, it, expect } from 'vitest';
import { orgPhraseOf } from '../../src/harness-run.js';
describe('orgPhraseOf', () => {
  it('carries the organization the sentence names', () => {
    expect(orgPhraseOf('how many members are in missio nexus organization')).toBe('missio nexus');
    expect(orgPhraseOf('who are the members of Calvary?')).toBe('Calvary');
    expect(orgPhraseOf('list the members of the ncf team')).toBe('ncf');
    expect(orgPhraseOf('pay every member of missio nexus 1 usdc')).toBe('missio nexus');
  });
  it('names nothing when the sentence names no organization', () => {
    expect(orgPhraseOf('who are the members?')).toBeUndefined();
    expect(orgPhraseOf('members of my org')).toBeUndefined();
    expect(orgPhraseOf('how many members are in this organization')).toBeUndefined();
  });
});
