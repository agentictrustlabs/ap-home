import { describe, it, expect } from 'vitest';
import { soleCardTarget, mayPatchDraft } from './publish-to-card';

describe('soleCardTarget', () => {
  const card = (id: string, displayName?: string) =>
    ({ resource: { cardResourceId: id, ...(displayName ? { displayName } : {}) } } as never);

  it('offers the one card, by name', () => {
    expect(soleCardTarget([card('card-1', 'Primary Card')])).toEqual({ cardResourceId: 'card-1', displayName: 'Primary Card' });
  });

  it('falls back to a generic name rather than showing an empty label', () => {
    expect(soleCardTarget([card('card-1')])?.displayName).toBe('your agent card');
  });

  it('offers nothing when there is no card', () => {
    expect(soleCardTarget([])).toBeNull();
  });

  it('offers nothing when there are SEVERAL — guessing is a silent decision about what an agent advertises', () => {
    // "primary" is not a safe stand-in for intent: the person must choose, or not be offered the option.
    expect(soleCardTarget([card('card-1', 'A'), card('card-2', 'B')])).toBeNull();
  });
});

describe('mayPatchDraft', () => {
  it('is the SAME gate the Card Studio uses for the identical edit', () => {
    expect(mayPatchDraft(['agent.card.draft'])).toBe(true);
    expect(mayPatchDraft(['agent.card.read'])).toBe(false);
    expect(mayPatchDraft([])).toBe(false);
  });
});
