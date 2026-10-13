// The three states a run's playbook line can be in — the 2026-10-13 incident was the middle one being
// rendered as the last one.
import { describe, it, expect } from 'vitest';
import { playbookSentence } from './playbook-sentence';

const PB = { archetypeId: 'skill:archetypes/person-steward', archetypeVersion: '1.4.0', digest: '0xabc1234567def0123456789abcdef' };

describe('playbookSentence', () => {
  it('names the archetype, its version and a short digest when one reached the planner', () => {
    const s = playbookSentence({ playbook: PB });
    expect(s.kind).toBe('assigned');
    expect(s.text).toBe('person-steward v1.4.0 0xabc12345…cdef');   // the skill: prefix is dropped
    expect(s.title).toBeUndefined();
  });

  it('a read that FAILED says so, and never "bare harness"', () => {
    const s = playbookSentence({ playbook: null, playbookUnreadable: 'storage is not enabled for this agent' });
    expect(s.kind).toBe('unreadable');
    expect(s.text).toMatch(/could not be read \(storage is not enabled for this agent\)/);
    expect(s.text).not.toMatch(/bare harness/);
    expect(s.title).toBe('storage is not enabled for this agent');   // the full reason on hover
  });

  it('A REASON WINS OVER THE DEFAULT — the exact inversion that made the incident invisible', () => {
    // If this ever flips, a cold vault refusal reads as a settled fact about the agent again.
    expect(playbookSentence({ playbook: null, playbookUnreadable: 'vault auth failed' }).kind).toBe('unreadable');
  });

  it('genuinely absent is still the bare harness — a real, documented state, not an error', () => {
    const s = playbookSentence({ playbook: null });
    expect(s.kind).toBe('bare');
    expect(s.text).toBe('none (bare harness)');
    expect(playbookSentence({}).kind).toBe('bare');                   // no field at all reads the same
  });

  it('an empty reason is not a reason', () => {
    // `playbookUnreadable: ''` must not produce "could not be read ()" — an empty string is the absence
    // of a reason, and the honest sentence for it is the plain one.
    expect(playbookSentence({ playbook: null, playbookUnreadable: '' }).kind).toBe('bare');
  });
});
