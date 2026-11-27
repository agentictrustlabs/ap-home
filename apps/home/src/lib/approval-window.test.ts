import { describe, expect, it, vi } from 'vitest';
import { finishApprovalWindow, type ApprovalWindow } from './approval-window';

const now = (run: () => void) => { run(); };
function fakeWindow(o: { opener?: boolean; openerClosed?: boolean; refuseClose?: boolean } = {}) {
  const posted: Array<{ message: unknown; origin: string }> = [];
  const w = {
    closed: false,
    opener: o.opener === false ? null : { closed: !!o.openerClosed, postMessage: (message: unknown, origin: string) => posted.push({ message, origin }) },
    close: vi.fn(() => { if (!o.refuseClose) w.closed = true; }),
  };
  return { w: w as ApprovalWindow & { close: ReturnType<typeof vi.fn> }, posted };
}

describe('a focused approval window finishes by itself', () => {
  it('tells the app (its origin only) and closes', () => {
    const { w, posted } = fakeWindow();
    const stillOpen = vi.fn();
    expect(finishApprovalWindow(w, { targetOrigin: 'https://ap-family.faithnet.io', message: { type: 'ap-household-setup', attempt: 'a' }, onStillOpen: stillOpen, schedule: now })).toBe(true);
    expect(posted).toEqual([{ message: { type: 'ap-household-setup', attempt: 'a' }, origin: 'https://ap-family.faithnet.io' }]);
    expect(w.close).toHaveBeenCalledOnce();
    expect(w.closed).toBe(true);
    expect(stillOpen).not.toHaveBeenCalled();
  });
  it('says "you can close this window" when the browser refuses to close it', () => {
    const { w } = fakeWindow({ refuseClose: true });
    const stillOpen = vi.fn();
    finishApprovalWindow(w, { targetOrigin: 'https://x.test', message: {}, onStillOpen: stillOpen, schedule: now });
    expect(w.close).toHaveBeenCalledOnce();
    expect(stillOpen).toHaveBeenCalledOnce();
  });
  it('a page opened as a tab (no opener, or the app closed) closes nothing and keeps its own way back', () => {
    for (const o of [{ opener: false }, { openerClosed: true }]) {
      const { w, posted } = fakeWindow(o);
      expect(finishApprovalWindow(w, { targetOrigin: 'https://x.test', message: {}, onStillOpen: vi.fn(), schedule: now })).toBe(false);
      expect(posted).toEqual([]);
      expect(w.close).not.toHaveBeenCalled();
    }
  });
  it('waits for the done state to show before closing', () => {
    const { w } = fakeWindow();
    const waits: number[] = [];
    finishApprovalWindow(w, { targetOrigin: 'https://x.test', message: {}, onStillOpen: vi.fn(), delayMs: 1200, schedule: (run, ms) => { waits.push(ms); run(); } });
    expect(waits[0]).toBe(1200);
  });
});
