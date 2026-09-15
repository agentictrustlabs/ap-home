import { describe, it, expect } from 'vitest';
import { parseRoutineSentence, timeOfDay, nextAt, routineWords } from '../src/routine-sentence.js';

const NOW = Date.parse('2026-09-14T15:00:00Z'); // a Monday, 09:00 in Denver
const TZ = 'America/Denver';

describe('a routine from a sentence (spec 402 W3)', () => {
  it('reads the clock words and leaves the ask verbatim', () => {
    const r = parseRoutineSentence("every Monday at 8, tell me what's on my calendar and any unanswered mail from the elders", { now: NOW, tz: TZ });
    if ('error' in r) throw new Error(r.error);
    expect(r.every).toBe('7d'); expect(r.ask).toBe("what's on my calendar and any unanswered mail from the elders");
    // 09:00 Monday now → next Monday 08:00 Denver (14:00Z), seven days out
    expect(new Date(r.firstAt).toISOString()).toBe('2026-09-21T14:00:00.000Z');
    expect(routineWords(r, TZ)).toContain('every week, starting Monday, Sep 21');
  });
  it('the clock may trail; a day routine due later today fires today', () => {
    const r = parseRoutineSentence('check for mail from the pastor every day at 5pm', { now: NOW, tz: TZ });
    if ('error' in r) throw new Error(r.error);
    expect(r.ask).toBe('check for mail from the pastor'); expect(r.every).toBe('1d');
    expect(new Date(r.firstAt).toISOString()).toBe('2026-09-14T23:00:00.000Z');
  });
  it('intervals, evenings, weekly, and the floor', () => {
    const h = parseRoutineSentence('every 2 hours look for unread mail', { now: NOW, tz: TZ });
    if ('error' in h) throw new Error(h.error);
    expect(h.every).toBe('2h'); expect(h.firstAt).toBe(NOW + 2 * 3600_000);
    const e = parseRoutineSentence('every evening summarize my day', { now: NOW, tz: TZ });
    if ('error' in e) throw new Error(e.error);
    expect(new Date(e.firstAt).toISOString()).toBe('2026-09-15T00:00:00.000Z'); // 18:00 Denver today
    expect('error' in parseRoutineSentence('every 5 minutes ping', { now: NOW })).toBe(true);
    expect('error' in parseRoutineSentence('tell me the news', { now: NOW })).toBe(true);
    expect('error' in parseRoutineSentence('every day at 25:00 x', { now: NOW })).toBe(true);
  });
  it('times of day', () => {
    expect(timeOfDay('8')).toBe(480); expect(timeOfDay('8pm')).toBe(20 * 60); expect(timeOfDay('12am')).toBe(0); expect(timeOfDay('noon')).toBe(720); expect(timeOfDay('17:30')).toBe(17 * 60 + 30); expect(timeOfDay('x')).toBeNull();
    expect(nextAt(NOW, 8 * 60, TZ, 1)).toBe(Date.parse('2026-09-21T14:00:00Z'));
  });
});

describe('connector triggers (spec 402 W3b)', () => {
  it('"when mail arrives from the pastor about the retreat, summarize it" → a Gmail poll', () => {
    const r = parseRoutineSentence('when mail arrives from the pastor about the retreat, summarize it', { now: NOW, tz: TZ });
    if ('error' in r) throw new Error(r.error);
    expect(r.connector).toEqual({ connector: 'google-gmail', query: 'from:pastor retreat newer_than:2d' });
    expect(r.every).toBe('15m'); expect(r.ask).toBe('summarize it');
    expect(routineWords(r, TZ)).toContain('whenever mail matching');
  });
  it('"15 minutes before each meeting, tell me who is coming" → a calendar poll with a lead', () => {
    const r = parseRoutineSentence('15 minutes before each meeting, tell me who is coming', { now: NOW, tz: TZ });
    if ('error' in r) throw new Error(r.error);
    expect(r.connector).toEqual({ connector: 'google-calendar', leadMinutes: 15 });
    expect(r.every).toBe('5m'); expect(r.ask).toBe('who is coming');
    const h = parseRoutineSentence('draft a note to the organizer 1 hour before every event', { now: NOW, tz: TZ });
    if ('error' in h) throw new Error(h.error);
    expect(h.connector).toEqual({ connector: 'google-calendar', leadMinutes: 60 });
  });
});
