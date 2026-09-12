import { describe, it, expect } from 'vitest';
import { retryAffordance } from './retry';
const V = [
  { id: 'kb.question', riskTier: 'informational', ceremonies: [], idempotency: 'replay-safe' as const },
  { id: 'profile.contact.update', riskTier: 'low', ceremonies: [], idempotency: 'one-per-resource-version' as const },
  { id: 'treasury.payment.execute', riskTier: 'high', ceremonies: [], idempotency: 'one-per-request' as const },
  { id: 'legacy.thing', riskTier: 'low', ceremonies: [] },
];
describe('retry affordance (398 §7.2)', () => {
  const failed = { state: 'failed' as const, effectUncertain: false };
  it('a read or an edit may be asked again; a one-per-request act only as a new request', () => {
    expect(retryAffordance(failed, 'kb.question', V).kind).toBe('retry');
    expect(retryAffordance(failed, 'profile.contact.update', V).kind).toBe('retry');
    expect(retryAffordance(failed, 'treasury.payment.execute', V).kind).toBe('new-request');
    expect(retryAffordance(failed, 'legacy.thing', V).kind).toBe('none');
  });
  it('effect-uncertain is never retried on a click; a run that is not over offers nothing', () => {
    expect(retryAffordance({ state: 'running', effectUncertain: true }, 'kb.question', V).kind).toBe('none');
    expect(retryAffordance({ state: 'running', effectUncertain: false }, 'kb.question', V).kind).toBe('none');
  });
});
