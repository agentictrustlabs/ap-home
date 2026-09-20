// A minted delegation token is a BUDGETED grant (300s TTL, usageLimit 10, accounted in D1 by demo-mcp),
// and every mint costs a GCP KMS signature. Reusing one within its budget is the mechanism working as
// specified — but a cache that hands the WRONG token to a caller would hand it the wrong authority, so
// the key's behaviour is pinned here rather than trusted.
//
// The first version of this cache keyed on `JSON.stringify(struct)` and threw "Do not know how to
// serialize a BigInt" against every real delegation — caught in the browser, not by a test. Hence the
// BigInt fields below: the fixture is shaped like the real thing on purpose.
import { describe, it, expect, beforeEach } from 'vitest';
import { budgetedDelegationToken, forgetBudgetedToken } from '../src/index.js';

const DELEGATOR = '0x3D653CbAB0C99B1513439758eb2eAc2039caa6E1';
const DELEGATE = '0x1dba4a27c53d7babda99513080223fb3bfc4bad1';
const SIGNER = '0x2a903aa73946df0f8da663902f84b8f4cea05703';

function delegation(overrides: Record<string, unknown> = {}) {
  return {
    delegator: DELEGATOR,
    delegate: DELEGATE,
    authority: `0x${'00'.repeat(32)}`,
    // The shapes that broke the first cache key: real delegations carry BigInts.
    salt: 42n,
    caveats: [{ enforcer: '0x8759c1a6cEBF1D5069e9434EF46327Bf2ef69975', terms: '0xdead', args: '0x' }],
    signature: `0x${'ab'.repeat(65)}`,
    ...overrides,
  } as never;
}

let mints: number;
const args = (d = delegation()) => ({
  delegation: d,
  signerAddress: SIGNER as `0x${string}`,
  signMessage: async () => { mints += 1; return `0x${'cd'.repeat(65)}` as `0x${string}`; },
  auditSink: { write: async () => {} } as never,
  correlationId: 'test',
});

// The cache lives for the isolate's lifetime, which in a test file means ACROSS cases — so every case
// works on a salt of its own rather than pretending the module was reloaded.
describe('the minted delegation token is reused within its budget', () => {
  beforeEach(() => { mints = 0; });

  it('mints once for repeated calls on the SAME delegation — a BigInt in the struct is not fatal', async () => {
    const d = delegation({ salt: 101n });
    const a = await budgetedDelegationToken(args(d));
    const b = await budgetedDelegationToken(args(d));
    expect(a).toBe(b);
    expect(mints).toBe(1);
  });

  it('never serves one delegation the token minted for another', async () => {
    const a = await budgetedDelegationToken(args(delegation({ salt: 102n })));
    const b = await budgetedDelegationToken(args(delegation({ salt: 102n, delegate: '0xb0d11ce19b756a682e78b4904cd8d832303b3d11' })));
    expect(a).not.toBe(b);
    expect(mints).toBe(2);
  });

  it('a differing BigInt is a different grant, not the same one', async () => {
    const a = await budgetedDelegationToken(args(delegation({ salt: 103n })));
    const b = await budgetedDelegationToken(args(delegation({ salt: 104n })));
    expect(a).not.toBe(b);
    expect(mints).toBe(2);
  });

  it('stops spending a token before it reaches the limit demo-mcp accounts against', async () => {
    // 6 safe uses of a limit of 10: the margin is what keeps a concurrent burst from being rejected.
    const d = delegation({ salt: 105n });
    for (let i = 0; i < 6; i++) await budgetedDelegationToken(args(d));
    expect(mints).toBe(1);
    await budgetedDelegationToken(args(d));
    expect(mints).toBe(2);
  });

  it('concurrent callers share ONE mint instead of racing to sign', async () => {
    await Promise.all([0, 1, 2, 3].map(() => budgetedDelegationToken(args(delegation({ salt: 106n })))));
    expect(mints).toBe(1);
  });

  it('every sharer of an in-flight mint is a USE — a wave of seven cannot spend the token past its limit', async () => {
    // Seven concurrent hops: one mint, seven presentations. With six safe uses, the ledger is already
    // over its margin, so the very next hop mints again rather than presenting the same jti an eighth time.
    const d = delegation({ salt: 107n });
    await Promise.all([0, 1, 2, 3, 4, 5, 6].map(() => budgetedDelegationToken(args(d))));
    expect(mints).toBe(1);
    await budgetedDelegationToken(args(d));
    expect(mints).toBe(2);
  });

  it('a token demo-mcp refused is forgotten, so the next hop mints afresh', async () => {
    const d = delegation({ salt: 108n });
    const t = await budgetedDelegationToken(args(d));
    forgetBudgetedToken(t);
    await budgetedDelegationToken(args(d));
    expect(mints).toBe(2);
  });
});
