// The private-scripture W3 vend: lbsb.svc issues a reader's credential for ONE settlement, claimed by the account that
// paid, bound to a fresh device key — and nothing in its input or its records names who holds the key.
import { describe, it, expect } from 'vitest';
import { encodeAbiParameters, keccak256, pad, toBytes, type Address, type Hex } from 'viem';
import { LocalEs256Signer, p256JwkThumbprint } from '@agenticprimitives/key-custody';
import { credentialDigestOf } from '@agenticprimitives/estate-projection';
import { vendReaderCredential, readerClaimDigest, dayNumber, purseSubject, SETTLEMENT_SPENT_PREFIX, type VendConfig } from '../src/reader-pass.js';
import type { IssuerFacetRecordV1 } from '../src/credential-issue.js';

const LBSB = '0x00ff8ccc7c7145289c8a42fe8870ec5d8cd68774' as Address;
const TREASURY = '0xdc3ef3d91ceb006099646e7cbb25cf74d747dcc6' as Address;
const USDC = '0xdaE09066A2cc32f6203605619137dcF01A9B49Ae' as Address;
const PURSE = '0x1111111111111111111111111111111111111111' as Address;
const OTHER = '0x2222222222222222222222222222222222222222' as Address;
const HASH = `0x${'ab'.repeat(32)}` as Hex;
const cfg: VendConfig = { issuerAgent: LBSB, treasury: TREASURY, asset: USDC, priceUnits: 1_000_000n, passDays: 30, audience: `eip155:34348:${LBSB}` };
const NOW = new Date('2026-10-17T12:00:00Z');
const sha256Hex = async (b: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', b))].map((x) => x.toString(16).padStart(2, '0')).join('');
const TRANSFER = keccak256(toBytes('Transfer(address,address,uint256)'));
const transferLog = (from: Address, to: Address, amount: bigint, asset: Address = USDC) => ({ address: asset, topics: [TRANSFER, pad(from), pad(to)] as Hex[], data: encodeAbiParameters([{ type: 'uint256' }], [amount]) });

function world(opts: { logs?: ReturnType<typeof transferLog>[]; status?: 'success' | 'reverted'; validSigner?: Address } = {}) {
  const issuingKey = LocalEs256Signer.generate();
  const device = LocalEs256Signer.generate().publicJwk();
  const facet: IssuerFacetRecordV1 = { type: 'ap.issuer-facet.v1', keyId: 'issuer-key:sd-jwt:lbsb-1', akcsKeyId: 'akcs-lbsb', credentialType: 'lbsb-reader', claimSchema: ['reader', 'valid_until'], vcSize: '1k', issuer: `eip155:34348:${LBSB}` };
  const records = new Map<string, unknown>([[`credential.issuer-facet:${facet.keyId}`, facet]]);
  const sigChecks: Array<{ signer: string; digest: Hex }> = [];
  const deps = {
    receiptOf: async () => ({ status: opts.status ?? 'success' as const, logs: opts.logs ?? [transferLog(PURSE, TREASURY, 1_000_000n)] }),
    isValidSig: async (signer: Address, digest: Hex) => { sigChecks.push({ signer, digest }); return signer.toLowerCase() === (opts.validSigner ?? PURSE).toLowerCase(); },
    readRecord: async (_s: string, rt: string) => records.get(rt) ?? null,
    writeRecord: async (_s: string, rt: string, r: unknown) => { records.set(rt, r); return { ok: true }; },
    survey: async () => [...records.keys()].map((recordType) => ({ recordType })),
    issuer: {
      issuingSign: async (_k: string, message: Uint8Array) => issuingKey.sign(message),
      issuerPublicJwk: async () => issuingKey.publicJwk() as unknown as Record<string, unknown>,
      mintIssuanceEvidence: async (_s: string, c: { digest: string }) => `ev.${c.digest}`,
      credentialDigestOf: async (jwt: string) => credentialDigestOf(jwt),
      thumbprintOf: (jwk: { x: string; y: string }) => p256JwkThumbprint(jwk),
      sha256Hex,
    },
    now: () => NOW,
  };
  return { deps, records, device, sigChecks };
}

describe('the reader-pass vend', () => {
  it('issues for a paid, payer-claimed settlement: claims in the facet layout, the pass length, nothing about the holder', async () => {
    const w = world();
    const out = await vendReaderCredential(w.deps, cfg, { settlementHash: HASH, payer: PURSE, deviceKey: w.device, claimSig: '0x01' });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.validUntil).toBe(dayNumber(NOW) + 30);
    expect(w.sigChecks[0]).toEqual({ signer: PURSE, digest: readerClaimDigest(HASH, p256JwkThumbprint(w.device), cfg.audience) });
    expect(w.records.get(`${SETTLEMENT_SPENT_PREFIX}${HASH}`)).toMatchObject({ status: 'issued', digest: out.digest });
    const issued = w.records.get(`credential.issued:${out.digest}`) as Record<string, unknown>;
    expect(issued).toMatchObject({ credentialType: 'lbsb-reader', deviceKeyThumbprint: p256JwkThumbprint(w.device), settlementHash: HASH });
    expect(issued).not.toHaveProperty('issuedTo');
    // The SD-JWT's disclosures carry the claim values; the issuer's records do not.
    const disclosed = (out.credential.disclosures as string[]).map((d) => Buffer.from(d, 'base64url').toString('utf8')).join(' ');
    expect(disclosed).toContain(String(dayNumber(NOW) + 30).padStart(7, '0'));
    expect(JSON.stringify([...w.records.values()])).not.toContain(String(dayNumber(NOW) + 30).padStart(7, '0'));
  });

  it('spends a settlement once', async () => {
    const w = world();
    const first = await vendReaderCredential(w.deps, cfg, { settlementHash: HASH, payer: PURSE, deviceKey: w.device, claimSig: '0x01' });
    expect(first.ok).toBe(true);
    const again = await vendReaderCredential(w.deps, cfg, { settlementHash: HASH, payer: PURSE, deviceKey: w.device, claimSig: '0x01' });
    expect(again).toMatchObject({ ok: false, code: 'settlement_spent' });
  });

  it('refuses a claim not signed by the account that paid — seeing the public settlement is not enough', async () => {
    const w = world({ validSigner: OTHER });
    const out = await vendReaderCredential(w.deps, cfg, { settlementHash: HASH, payer: PURSE, deviceKey: w.device, claimSig: '0x01' });
    expect(out).toMatchObject({ ok: false, code: 'claim_not_signed_by_payer' });
    expect(w.records.has(`${SETTLEMENT_SPENT_PREFIX}${HASH}`)).toBe(false);
  });

  it('refuses a settlement that underpays, pays someone else, uses another asset, comes from another payer, or reverted', async () => {
    for (const [logs, status] of [
      [[transferLog(PURSE, TREASURY, 999_999n)], 'success'],
      [[transferLog(PURSE, OTHER, 1_000_000n)], 'success'],
      [[transferLog(PURSE, TREASURY, 1_000_000n, OTHER)], 'success'],
      [[transferLog(OTHER, TREASURY, 1_000_000n)], 'success'],
      [[transferLog(PURSE, TREASURY, 1_000_000n)], 'reverted'],
    ] as const) {
      const w = world({ logs: [...logs], status });
      const out = await vendReaderCredential(w.deps, cfg, { settlementHash: HASH, payer: PURSE, deviceKey: w.device, claimSig: '0x01' });
      expect(out.ok).toBe(false);
    }
  });

  it('a purse is her login on its own derivation path', () => {
    expect(purseSubject('1234567890', 1)).toBe('1234567890#purse:1');
    expect(() => purseSubject('x', 0)).toThrow();
  });
});
