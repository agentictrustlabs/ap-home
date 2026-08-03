// Verification-receipt wiring (spec 303 W2) — untested until now.
//
// Two properties carry this module, and both are ADR-0013 shaped:
//
//   ONE SIGNER, SELECTED BY CONFIGURATION. KMS EIP-191 when a key is configured (counterparty-
//   verifiable offline via ecrecover), else demo-hmac (host-verifiable only), else UNSIGNED. Never a
//   runtime fallback between them — a receipt that quietly downgraded from asymmetric to symmetric
//   would still verify for us and stop verifying for anyone else, which is the worst version of this
//   failure because nothing looks broken locally.
//
//   THE STORE IS FAIL-SOFT, THE DECISION IS NOT. A receipt is EVIDENCE, not the authorization, so a
//   failed D1 write must not fail the request. That is the opposite of the audit trail's fail-closed
//   classes, and conflating the two in either direction is a real mistake: fail-closed here would let
//   a storage outage deny reads; fail-soft in the audit path would lose the record that matters.
//
// Detail residency is the third: when the principal has a per-person vault-key binding (spec 278) the
// PRIVATE detail is sealed into THEIR vault and D1 keeps only a pointer.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const PRINCIPAL = '0x1111111111111111111111111111111111111111';
const AUDIENCE = 'https://mcp.example.test/mcp';

const vaultWrites = new Map<string, { classification?: string; data: unknown }>();
let hasBinding = true;

vi.mock('../src/vault-key', () => ({
  resolvePersonVault: async (_env: unknown, owner: string) =>
    hasBinding
      ? { vault: { async write(a: { resource: string; classification?: string; data: unknown }) {
          vaultWrites.set(`${owner}|${a.resource}`, { classification: a.classification, data: a.data });
        } } }
      : null,
}));

const { buildReceiptsConfig } = await import('../src/receipts.js');

// ─── D1 + fetch fakes ────────────────────────────────────────────────────────

interface Insert { sql: string; bound: unknown[] }
function fakeDb(opts: { failWrite?: boolean } = {}) {
  const inserts: Insert[] = [];
  return {
    inserts,
    prepare(sql: string) {
      let bound: unknown[] = [];
      const api = {
        bind(...args: unknown[]) { bound = args; return api; },
        async run() {
          if (opts.failWrite) throw new Error('D1 unavailable');
          inserts.push({ sql, bound });
          return { success: true };
        },
      };
      return api;
    },
  } as unknown as D1Database & { inserts: Insert[] };
}

const env = (over: Record<string, unknown> = {}) => ({
  DB: fakeDb(), RPC_URL: 'https://rpc.example.test', MCP_AUDIENCE: AUDIENCE, ...over,
}) as never;

const minted = (over: Record<string, unknown> = {}) => ({
  receipt: { receiptId: 'rcpt_1', receiptHash: 'sha256:' + 'a'.repeat(64) },
  detail: { principal: PRINCIPAL, values: { email: 'a@b.test' }, receiptKey: 'secret-opening-key' },
  ...over,
}) as never;

beforeEach(() => {
  vaultWrites.clear();
  hasBinding = true;
  globalThis.fetch = (async () => new Response(
    JSON.stringify({ result: { number: '0x10', hash: `0x${'bb'.repeat(32)}` } }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )) as typeof fetch;
});

describe('ONE signer, selected by configuration (ADR-0013)', () => {
  it('is UNSIGNED when neither a KMS key nor a secret is configured', () => {
    const { receipts } = buildReceiptsConfig(env(), {});
    expect(receipts.sign).toBeUndefined();
  });

  it('uses demo-hmac when only the secret is configured', async () => {
    const { receipts } = buildReceiptsConfig(env({ VERIFICATION_RECEIPT_SECRET: 's3cret' }), {});
    const proof = await receipts.sign!('sha256:' + 'a'.repeat(64) as never);
    expect(proof.type).toBe('demo-hmac');
    expect(proof.signature).toMatch(/^hmac-sha256:[0-9a-f]{64}$/);
  });

  // Precedence, not fallback: with BOTH configured the asymmetric signer wins and the symmetric one is
  // never consulted. A receipt that silently downgraded would still verify for the host and stop
  // verifying for every counterparty — the failure that looks fine locally.
  it('prefers the KMS signer when BOTH are configured, and does not fall back', async () => {
    const { receipts } = buildReceiptsConfig(
      env({ VERIFICATION_RECEIPT_SECRET: 's3cret', VERIFICATION_RECEIPT_KMS_KEY: 'projects/p/k/1', GCP_SERVICE_ACCOUNT_JSON: '{"client_email":"a@b","private_key":"x"}' }),
      {},
    );
    // The KMS signer is selected; invoking it here would need a real KMS, so the assertion is that the
    // HMAC path was NOT chosen — a `demo-hmac` proof would mean the downgrade happened.
    await expect(receipts.sign!('sha256:' + 'a'.repeat(64) as never)).rejects.toBeDefined();
  });

  // A KMS key with no service account is INCOMPLETE config, and falls to the next configured mechanism
  // rather than half-using the first. Recorded because it is the one place selection is compound.
  it('needs BOTH the KMS key and the service account before selecting KMS', async () => {
    const { receipts } = buildReceiptsConfig(
      env({ VERIFICATION_RECEIPT_KMS_KEY: 'projects/p/k/1', VERIFICATION_RECEIPT_SECRET: 's3cret' }),
      {},
    );
    const proof = await receipts.sign!('sha256:' + 'a'.repeat(64) as never);
    expect(proof.type).toBe('demo-hmac');
  });

  it('treats a whitespace-only secret as unset', () => {
    expect(buildReceiptsConfig(env({ VERIFICATION_RECEIPT_SECRET: '   ' }), {}).receipts.sign).toBeUndefined();
  });

  // The signature is over the receipt HASH, so the same hash always signs the same and a different one
  // does not. That is what makes the proof bind to the receipt rather than to the request.
  it('signs the receipt hash deterministically, and differently per hash', async () => {
    const { receipts } = buildReceiptsConfig(env({ VERIFICATION_RECEIPT_SECRET: 's3cret' }), {});
    const a = await receipts.sign!('sha256:' + 'a'.repeat(64) as never);
    const b = await receipts.sign!('sha256:' + 'a'.repeat(64) as never);
    const c = await receipts.sign!('sha256:' + 'c'.repeat(64) as never);
    expect(a.signature).toBe(b.signature);
    expect(a.signature).not.toBe(c.signature);
  });
});

describe('the config names the verifier and pins a policy version', () => {
  it('carries the audience as verifier and a versioned policy', () => {
    const { receipts } = buildReceiptsConfig(env(), {});
    expect(receipts.verifier).toBe(AUDIENCE);
    expect(receipts.policyVersion).toBe('demo-mcp/mcp-v2/1');
  });
});

describe('status evidence is real, and memoized rather than amplified', () => {
  it('reads the latest block and normalizes the number out of hex', async () => {
    const { receipts } = buildReceiptsConfig(env(), {});
    const ev = await receipts.statusEvidence!();
    expect(ev.blockNumber).toBe('16'); // 0x10
    expect(ev.blockHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  // Memoized per isolate for the chain-state freshness window, so receipts carry duty-3 evidence
  // without a chain read per call. The second read must not hit the network.
  it('does not re-read the chain within the freshness window', async () => {
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return new Response(
      JSON.stringify({ result: { number: '0x20', hash: `0x${'cc'.repeat(32)}` } }), { status: 200 }); }) as typeof fetch;
    const { receipts } = buildReceiptsConfig(env(), {});
    await receipts.statusEvidence!();
    const before = calls;
    await receipts.statusEvidence!();
    expect(calls).toBe(before);
  });
});

describe('detail residency (spec 278 / spec 303)', () => {
  const store = async (e: never, outcome: 'allow' | 'deny' = 'allow') => {
    const { receipts, holder } = buildReceiptsConfig(e, { correlationId: 'corr_1' });
    await receipts.onReceipt!(minted(), { outcome, correlationId: 'corr_1', toolName: 'read_pii' } as never);
    return holder;
  };

  it('seals the PRIVATE detail into the principal vault, leaving D1 a pointer', async () => {
    const db = fakeDb();
    await store(env({ DB: db }) as never);
    const sealed = vaultWrites.get(`${PRINCIPAL}|verification-receipt:rcpt_1`);
    expect(sealed?.classification).toBe('receipt.private');

    const detailColumn = JSON.parse(String((db as unknown as { inserts: Insert[] }).inserts[0]!.bound[6]));
    expect(detailColumn).toEqual({ vaultResource: 'verification-receipt:rcpt_1', owner: PRINCIPAL });
    // The opening key must NOT be the thing left in D1 — that is the point of the split.
    expect(JSON.stringify(detailColumn)).not.toContain('secret-opening-key');
  });

  // No binding ⇒ the documented D1 interim. Worth pinning as the deliberate choice it is: it is no
  // worse than the audit rows, and the erasure path (delete the row) still holds.
  it('keeps the D1 interim when the principal has no vault-key binding', async () => {
    hasBinding = false;
    const db = fakeDb();
    await store(env({ DB: db }) as never);
    expect(vaultWrites.size).toBe(0);
    expect(String((db as unknown as { inserts: Insert[] }).inserts[0]!.bound[6])).toContain('secret-opening-key');
  });

  // A DENY has no authenticated principal to seal under, so it takes the interim path too.
  it('does not attempt a vault seal for a deny', async () => {
    await store(env() as never, 'deny');
    expect(vaultWrites.size).toBe(0);
  });
});

describe('the store is fail-soft — a receipt is evidence, not the decision', () => {
  // The load-bearing asymmetry. A D1 outage must not fail the request; the audit trail's fail-closed
  // classes are a DIFFERENT path (spec 291 §5) and must not be conflated with this one.
  it('does not throw when the D1 write fails', async () => {
    const { receipts } = buildReceiptsConfig(env({ DB: fakeDb({ failWrite: true }) }), { correlationId: 'c' });
    await expect(
      receipts.onReceipt!(minted(), { outcome: 'allow', correlationId: 'c', toolName: 'read_pii' } as never),
    ).resolves.toBeUndefined();
  });

  it('still surfaces the PUBLIC receipt to the endpoint when storage failed', async () => {
    const { receipts, holder } = buildReceiptsConfig(env({ DB: fakeDb({ failWrite: true }) }), { correlationId: 'c' });
    await receipts.onReceipt!(minted(), { outcome: 'allow', correlationId: 'c', toolName: 'read_pii' } as never);
    expect(holder.receipt).toMatchObject({ receiptId: 'rcpt_1' });
  });

  // A vault-seal failure ALSO degrades to the D1 interim rather than dropping the receipt — the same
  // fail-soft rule one layer in.
  it('falls back to the D1 interim when the vault seal throws', async () => {
    hasBinding = true;
    const db = fakeDb();
    const throwing = { vault: { async write() { throw new Error('vault down'); } } };
    const mod = await import('../src/vault-key');
    const spy = vi.spyOn(mod, 'resolvePersonVault').mockResolvedValue(throwing as never);
    const { receipts } = buildReceiptsConfig(env({ DB: db }) as never, { correlationId: 'c' });
    await receipts.onReceipt!(minted(), { outcome: 'allow', correlationId: 'c', toolName: 'read_pii' } as never);
    expect(String((db as unknown as { inserts: Insert[] }).inserts[0]!.bound[6])).toContain('secret-opening-key');
    spy.mockRestore();
  });

  it('records the outcome, tool and correlation id on the row', async () => {
    const db = fakeDb();
    const { receipts } = buildReceiptsConfig(env({ DB: db }) as never, { correlationId: 'corr_9' });
    await receipts.onReceipt!(minted(), { outcome: 'deny', correlationId: 'corr_9', toolName: 'read_pii' } as never);
    const row = (db as unknown as { inserts: Insert[] }).inserts[0]!;
    expect(row.bound[1]).toBe('corr_9');
    expect(row.bound[2]).toBe('deny');
    expect(row.bound[3]).toBe('read_pii');
  });
});
