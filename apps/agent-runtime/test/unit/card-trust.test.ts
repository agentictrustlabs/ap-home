// RUN-16 (spec 445) — the runtime's binding of a2a's `verifyCardSignature` to agent-profile's on-chain verifier fails closed.
import { describe, expect, it } from 'vitest';
import { cardTrustFor } from '../../src/card-trust.js';

const CARD = JSON.stringify({ name: 'Clock', signatures: [] });
const base = { chainId: 84532, verifyHash: async () => true, fetch: (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch };

describe('cardTrustFor', () => {
  it('relies on the card, and only through a verifier', () => {
    const t = cardTrustFor({ ...base, addrOf: async () => '0x' + '11'.repeat(20) }, 'clock.svc', 'https://clock.example/.well-known/agent-card.json');
    expect(t.relyOnCard).toBe(true);
    expect(typeof t.verifyCardSignature).toBe('function');
  });
  it('a name with no on-chain addr record verifies nothing', async () => {
    const t = cardTrustFor({ ...base, addrOf: async () => null }, 'clock.svc', 'https://clock.example/c.json');
    expect(await t.verifyCardSignature!({}, CARD)).toBe(false);
  });
  it('a host that publishes no binding / keys verifies nothing — even with an agent on chain and a validator that says yes', async () => {
    const t = cardTrustFor({ ...base, addrOf: async () => '0x' + '11'.repeat(20) }, 'clock.svc', 'https://clock.example/c.json');
    expect(await t.verifyCardSignature!({}, CARD)).toBe(false);
  });
});
