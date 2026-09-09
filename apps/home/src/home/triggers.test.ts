import { describe, expect, it } from 'vitest';
import { triggerSourceLabel } from './ask';

describe('triggerSourceLabel — what fires a row, in words', () => {
  it('names each kind\'s source', () => {
    expect(triggerSourceLabel({ triggerId: 'd', kind: 'schedule', every: 'PT24H', ask: 'x' })).toBe('every day');
    expect(triggerSourceLabel({ triggerId: 'w', kind: 'schedule', every: 'P7D', ask: 'x' })).toBe('every week');
    expect(triggerSourceLabel({ triggerId: 'e', kind: 'event', on: { event: 'ContributionCommitted' }, ask: 'x' })).toMatch(/when ContributionCommitted is committed/);
    expect(triggerSourceLabel({ triggerId: 'm', kind: 'message', on: { profile: 'dm' }, ask: 'x' })).toMatch(/direct message is admitted/);
    expect(triggerSourceLabel({ triggerId: 'h', kind: 'webhook', ask: 'x' }, 'https://x/hooks/a/h')).toMatch(/https:\/\/x\/hooks\/a\/h is called with this row's token/);
    expect(triggerSourceLabel({ triggerId: 'legacy', ask: 'x' })).toBe('on a schedule');
  });
});
