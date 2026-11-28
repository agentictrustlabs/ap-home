import { it, expect } from 'vitest';
import { decodeAllowedTargetsTerms, decodeAllowedMethodsTerms, methodSelector } from '@agenticprimitives/delegation';
import { issueServicePeerSessionDelegation } from './delegation';
import { CONTRACTS } from './chain';

// The peer session (2026-11-27): one peer, harness.ask only, 90 days — never the identity itself, never a list.
it('a peer session targets exactly the named peer, allows only harness.ask, and is bounded', async () => {
  const ws = '0x37407683b224e15029fdae24ad0b7509681af17c', key = '0xf503de74f373a70a3abade08c50b9dc618245059', peer = '0x5decc6adcc8f72fad1ccadb87edbb5b3ed9c5392';
  const d = await issueServicePeerSessionDelegation(ws, key, peer, async () => '0xab');
  expect(d.delegator).toBe(ws); expect(d.delegate).toBe(key); expect(d.signature).toBe('0xab');
  const by = (e: string) => d.caveats.find((c) => c.enforcer.toLowerCase() === e.toLowerCase())!;
  expect(decodeAllowedTargetsTerms(by(CONTRACTS.allowedTargetsEnforcer).terms).map((a) => a.toLowerCase())).toEqual([peer]);
  expect(decodeAllowedMethodsTerms(by(CONTRACTS.allowedMethodsEnforcer).terms).map((m) => m.toLowerCase())).toEqual([methodSelector('harness.ask').toLowerCase()]);
  const until = Number(BigInt('0x' + by(CONTRACTS.timestampEnforcer).terms.slice(66, 130)));
  expect(until - Date.now() / 1000).toBeGreaterThan(89 * 86400);
  await expect(issueServicePeerSessionDelegation(ws, key, ws, async () => '0xab')).rejects.toThrow(/another agent/);
});
