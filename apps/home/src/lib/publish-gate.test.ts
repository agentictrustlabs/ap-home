import { describe, it, expect } from 'vitest';
import { publishBlockedReason } from './publish-gate';

describe('publishBlockedReason', () => {
  it('enables the button when the marked set differs from the chain', () => {
    expect(publishBlockedReason({ total: 2, marked: 1, changed: true })).toBeNull();
  });

  it('tells someone with unpublished capabilities WHAT TO DO, not that there is nothing to do', () => {
    // The reported bug: capabilities added, none marked, and the tooltip said everything was up to date.
    const r = publishBlockedReason({ total: 3, marked: 0, changed: false });
    expect(r).toMatch(/Private pill/);
    expect(r, 'never claim there is nothing to publish when there is').not.toMatch(/up to date/);
  });

  it('says everything is current only when something IS marked and matches the chain', () => {
    expect(publishBlockedReason({ total: 3, marked: 3, changed: false })).toMatch(/up to date/);
  });

  it('asks for a capability when the agent has none', () => {
    expect(publishBlockedReason({ total: 0, marked: 0, changed: false })).toMatch(/Add a capability/);
  });

  it('an override outranks everything — including a state that would otherwise enable the button', () => {
    // A nameless agent cannot publish at all; saying "ready to publish" would be a lie the button then
    // refuses to honour.
    expect(publishBlockedReason({ total: 2, marked: 1, changed: true, override: 'needs a name' })).toBe('needs a name');
  });
});
