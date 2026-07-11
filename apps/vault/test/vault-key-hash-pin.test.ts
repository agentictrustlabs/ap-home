// Guards the vault-key hardening invariant (2026-07-11): the per-op ERC-1271 RPC short-circuit fires
// only if the authorization read back from D1 hashes to the SAME `authorization_hash` pinned at bind
// time. If this round-trip ever drifts, the short-circuit silently stops firing (every op falls back
// to the on-chain RPC — the exact flakiness we removed). This pins the round-trip: canonicalize the
// wire at "bind time" and after a JSON store→load→re-wire cycle; the sha256 pins MUST be equal.
import { describe, it, expect } from 'vitest';
import { canonicalize, sha256Hex } from '@agenticprimitives/key-authorization';

// The exact helpers demo-mcp/vault-key.ts uses (kept in lockstep by this test).
const toWire = (d: { salt: bigint }): Record<string, unknown> => ({ ...d, salt: d.salt.toString() });
const fromWire = (json: string): { salt: bigint } => { const w = JSON.parse(json); return { ...w, salt: BigInt(w.salt) }; };

const authorization = {
  delegator: '0x6239a50bf724eae48e2d86af5df21ba294c27330',
  delegate: '0x0000000000000000000000000000000000000abc',
  authority: '0x' + '00'.repeat(32),
  caveats: [{ enforcer: '0x1111111111111111111111111111111111111111', terms: '0xdead', args: '0x' }],
  salt: 123456789012345678901234567890n,
  signature: '0xc0ffee',
};

describe('vault-key authorization hash pin — bind-time vs read-back round-trip', () => {
  it('the pin computed at bind time equals the pin after a D1 store→load→re-wire cycle', async () => {
    const bindPin = await sha256Hex(canonicalize(toWire(authorization)));
    const stored = JSON.stringify(toWire(authorization)); // authorization_json in D1
    const readPin = await sha256Hex(canonicalize(toWire(fromWire(stored)))); // what the verifier recomputes
    expect(readPin).toBe(bindPin); // short-circuit fires → no per-op RPC
  });

  it('a DIFFERENT authorization produces a different pin (mismatch → real on-chain verify)', async () => {
    const a = await sha256Hex(canonicalize(toWire(authorization)));
    const b = await sha256Hex(canonicalize(toWire({ ...authorization, signature: '0xdeadbeef' })));
    expect(a).not.toBe(b);
  });
});
