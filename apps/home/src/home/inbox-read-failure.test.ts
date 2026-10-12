import { describe, expect, it } from 'vitest';

import { classifyInboxReadFailure } from './use-inbox';

// THE BUG THIS PINS (live, 2026-10-12). faith-town.workspace's records were being written into its vault
// every hour — the town's own log said `ok: true` — and its Messages page said "Your messages could not be
// read just now — session_leaf_required …. Trying again." forever, re-polling a 409 every five seconds. The
// state needed ONE act from the person and the page described it as weather.
describe('classifyInboxReadFailure', () => {
  const leaf = { error: 'session_leaf_required — interactions vault access needs a re-enable to custody the DEL-001 session leaf (server-mint retired — CRIT-2)' };

  it('a missing session leaf is actionable, not transient — and says where the messages are', () => {
    const v = classifyInboxReadFailure(409, leaf, false);
    expect(v).toMatchObject({ needsEnable: true, stopPolling: true });
    expect(v.said).toContain('in your vault');
    expect(v.said).toContain('signing session needs renewing');
    expect(v.said).not.toContain('Trying again');
  });

  it('recognises it from the code or the flag, not only the message', () => {
    expect(classifyInboxReadFailure(409, { code: 'session_leaf_required' }, false).needsEnable).toBe(true);
    expect(classifyInboxReadFailure(409, { needsEnable: true }, false).needsEnable).toBe(true);
    expect(classifyInboxReadFailure(409, { error: 'interactions storage not enabled' }, false).needsEnable).toBe(true);
  });

  it('a refusal is still a refusal, and says whose inbox it is', () => {
    expect(classifyInboxReadFailure(403, { error: 'not authorized for that agent inbox' }, true)).toMatchObject({ needsEnable: false, stopPolling: true });
    expect(classifyInboxReadFailure(403, { error: 'not authorized for that agent inbox' }, true).said).toContain('those who steward it');
    expect(classifyInboxReadFailure(401, {}, false).said).toContain('sign in again');
  });

  it('anything else is transient and keeps polling — unchanged', () => {
    const v = classifyInboxReadFailure(502, { error: 'upstream timeout' }, false);
    expect(v).toMatchObject({ needsEnable: false, stopPolling: false });
    expect(v.said).toContain('Trying again');
    expect(v.said).toContain('upstream timeout');
  });

  it('an empty body is transient, never mistaken for something the person can fix', () => {
    expect(classifyInboxReadFailure(500, {}, false)).toMatchObject({ needsEnable: false, stopPolling: false });
  });
});
