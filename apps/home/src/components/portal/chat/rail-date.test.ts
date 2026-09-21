import { describe, it, expect } from 'vitest';
import { railDate, railGroup } from './rail-date';

const now = new Date(2026, 7, 28, 15, 0, 0); // Fri Aug 28 2026, local

describe('railDate', () => {
  it('shows a time for today', () => {
    expect(railDate(new Date(2026, 7, 28, 9, 5).toISOString(), now)).toMatch(/09:05|9:05/);
  });
  it('shows Yesterday, then the weekday within a week', () => {
    expect(railDate(new Date(2026, 7, 27, 23, 0).toISOString(), now)).toBe('Yesterday');
    expect(railDate(new Date(2026, 7, 26, 1, 0).toISOString(), now)).toBe('Wednesday');
    expect(railDate(new Date(2026, 7, 22, 1, 0).toISOString(), now)).toBe('Saturday');
  });
  it('shows the long ordinal date beyond a week', () => {
    expect(railDate(new Date(2025, 7, 8, 12, 0).toISOString(), now)).toBe('August 8th, 2025');
    expect(railDate(new Date(2026, 0, 1, 12, 0).toISOString(), now)).toBe('January 1st, 2026');
    expect(railDate(new Date(2026, 0, 22, 12, 0).toISOString(), now)).toBe('January 22nd, 2026');
    expect(railDate(new Date(2026, 0, 11, 12, 0).toISOString(), now)).toBe('January 11th, 2026');
  });
  it('is empty for garbage', () => {
    expect(railDate('nope', now)).toBe('');
  });

  it('railGroup — the rail\'s sections: Today · Yesterday · This week · Earlier', () => {
    const now = new Date(2026, 8, 20, 15, 0, 0);
    expect(railGroup(new Date(2026, 8, 20, 9).toISOString(), now)).toBe('Today');
    expect(railGroup(new Date(2026, 8, 19, 23).toISOString(), now)).toBe('Yesterday');
    expect(railGroup(new Date(2026, 8, 15).toISOString(), now)).toBe('This week');
    expect(railGroup(new Date(2026, 8, 1).toISOString(), now)).toBe('Earlier');
    expect(railGroup('garbage', now)).toBe('Earlier');
  });
});
