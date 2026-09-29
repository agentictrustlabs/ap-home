import { describe, it, expect } from 'vitest';
import { orgPhraseOf } from '../../src/harness-run.js';
describe('orgPhraseOf', () => {
  it('carries the organization the sentence names', () => {
    expect(orgPhraseOf('how many members are in missio nexus organization')).toBe('missio nexus');
    expect(orgPhraseOf('who are the members of Calvary?')).toBe('Calvary');
    expect(orgPhraseOf('list the members of the ncf team')).toBe('ncf');
    expect(orgPhraseOf('pay every member of missio nexus 1 usdc')).toBe('missio nexus');
  });
  it('carries a TYPED name whole — the dot is part of the name, not the end of the sentence (spec 366 R3)', () => {
    // Excluding the dot meant no typed name ever reached the step, and the roster read fell to the
    // addressee: bob's own empty roster was narrated as alice-home-church's.
    expect(orgPhraseOf('who are the members of alice-home-church.impact')).toBe('alice-home-church.impact');
    expect(orgPhraseOf('who are the members of calvary.org?')).toBe('calvary.org');
    expect(orgPhraseOf('who are the members of calvary.org.')).toBe('calvary.org');
    expect(orgPhraseOf('pay every member of missio-nexus.org 1 usdc')).toBe('missio-nexus.org');
  });
  it('names nothing when the sentence names no organization', () => {
    expect(orgPhraseOf('who are the members?')).toBeUndefined();
    expect(orgPhraseOf('members of my org')).toBeUndefined();
    expect(orgPhraseOf('how many members are in this organization')).toBeUndefined();
  });
});

describe('the phrasings the compiled roster read catches (live 2026-09-29)', () => {
  it.each([
    ['who belongs to missio nexus?', 'missio nexus'],
    ['Who belongs to Missio Nexus', 'Missio Nexus'],
    ['who is in the youth team?', 'youth'],
    ["who's part of calvary.org?", 'calvary.org'],
    ['who is a member of missio nexus', 'missio nexus'],
  ])('%s → %s', (q, want) => expect(orgPhraseOf(q)).toBe(want));
  it('still names nothing for "who belongs to us" / "who belongs here"', () => {
    expect(orgPhraseOf('who belongs to our org')).toBeUndefined();
    expect(orgPhraseOf('who belongs here?')).toBeUndefined();
  });
});
