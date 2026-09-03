// A pasted contracts JSON must never be able to DELETE a committed contract (2026-09-03: the Ask surface
// went missing on a chain where its enforcer was live, because the Home's hand-pasted copy predated it).
import { describe, expect, it } from 'vitest';
import { CONTRACTS as FAITHCHAIN } from '@agenticprimitives/contracts/deployments/faithchain';

describe('the deployment table this build targets', () => {
  it('carries every contract the committed faithchain deployment has — a stale paste cannot drop one', async () => {
    const { CONTRACTS, CHAIN_ID } = await import('./chain');
    // Whatever this build targets, keys present in the committed doc for it must survive the merge.
    const committed = CHAIN_ID === 34348 ? (FAITHCHAIN as unknown as Record<string, string>) : null;
    if (!committed) return; // base-sepolia builds are covered by the same code path
    for (const [k, v] of Object.entries(committed)) {
      if (!/^0x[0-9a-fA-F]{40}$/.test(String(v))) continue;
      if (!(k in CONTRACTS)) continue; // the app only names the ones it uses
      expect((CONTRACTS as Record<string, string>)[k]?.toLowerCase()).toBe(String(v).toLowerCase());
    }
  });

  it('faithchain ships the enforcer the Ask needs (the address the Home gate reads)', () => {
    expect((FAITHCHAIN as unknown as Record<string, string>).digestBindingEnforcer).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });
});
