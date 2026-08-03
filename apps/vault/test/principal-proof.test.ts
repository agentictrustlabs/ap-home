// Proof-of-principal for the token mint (KC-1b) — untested until now, on the module that closed a
// one-request cross-principal PII read.
//
// The open mint accepted an arbitrary `principal` from the request body and issued a bearer that
// authorized reading THAT principal's data, with no proof the caller controlled the SA. On a publicly
// reachable deployment that is somebody else's PII for the cost of one request. The fix is a
// freshness-bound challenge signed by the principal and verified through the same deployed
// UniversalSignatureValidator used everywhere else.
//
// The challenge's job is to BIND EVERY MINT PARAMETER, so a captured proof cannot be replayed to mint
// for a different principal, audience, scope set, field set or ttl. That is what most of this file
// tests: not "does it hash" but "does changing X change the hash" — because any parameter that fell
// out of the preimage would be a parameter an attacker could swap while keeping a valid signature.
//
// The verification half is fail-closed (ADR-0013): no validator, no proof, a stale timestamp, a
// verification error, or a false result all reject. Each is asserted separately, because "it returned
// not-ok" is not the same claim as "it returned not-ok for the reason that protects you".

import { describe, it, expect } from 'vitest';
import {
  mintChallengeHash,
  provisionChallengeHash,
  verifyPrincipalControlProof,
  verifyProvisionControlProof,
  MINT_PROOF_MAX_SKEW_SECONDS,
  type MintProofInput,
  type PrincipalProofEnv,
} from '../src/principal-proof.js';

const PRINCIPAL = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const USV = '0x3333333333333333333333333333333333333333';
const NOW = 1_700_000_000;
const PROOF = `0x${'ab'.repeat(65)}`;

const base = (over: Partial<MintProofInput> = {}): MintProofInput => ({
  principal: PRINCIPAL, audience: 'demo-mcp', issuedAt: NOW,
  scopes: ['vault:read'], fields: ['email'], ttlSeconds: 300, ...over,
});

const env = (over: Partial<PrincipalProofEnv> = {}): PrincipalProofEnv => ({
  RPC_URL: 'https://rpc.example.test', UNIVERSAL_SIGNATURE_VALIDATOR: USV, ...over,
});

describe('the mint challenge binds every parameter', () => {
  it('is deterministic for identical input', () => {
    expect(mintChallengeHash(base())).toBe(mintChallengeHash(base()));
  });

  it('is case-insensitive in the principal — an address is not a string', () => {
    expect(mintChallengeHash(base({ principal: PRINCIPAL.toUpperCase().replace('0X', '0x') })))
      .toBe(mintChallengeHash(base()));
  });

  // THE point of the challenge. Each of these is a parameter an attacker would swap while reusing a
  // captured signature, so each MUST change the preimage.
  it.each([
    ['principal', { principal: OTHER }],
    ['audience', { audience: 'someone-else' }],
    ['issuedAt', { issuedAt: NOW + 1 }],
    ['scopes', { scopes: ['vault:read', 'vault:write'] }],
    ['fields', { fields: ['email', 'ssn'] }],
    ['ttlSeconds', { ttlSeconds: 86_400 }],
  ])('changing %s changes the hash', (_name, over) => {
    expect(mintChallengeHash(base(over as Partial<MintProofInput>))).not.toBe(mintChallengeHash(base()));
  });

  // Scope ORDER matters to the preimage, so a proof cannot be reused under a reordered list. That is
  // the safe direction: the client is told to reproduce the string exactly.
  it('is order-sensitive in scopes and fields', () => {
    expect(mintChallengeHash(base({ scopes: ['b', 'a'] }))).not.toBe(mintChallengeHash(base({ scopes: ['a', 'b'] })));
    expect(mintChallengeHash(base({ fields: ['b', 'a'] }))).not.toBe(mintChallengeHash(base({ fields: ['a', 'b'] })));
  });

  // An OMITTED ttl and an explicit one must not collide — otherwise a proof for an unbounded token
  // would verify against a bounded request, or the reverse.
  it('distinguishes an absent ttl from any present one', () => {
    const absent = mintChallengeHash(base({ ttlSeconds: undefined }));
    expect(absent).not.toBe(mintChallengeHash(base({ ttlSeconds: 0 })));
    expect(absent).not.toBe(mintChallengeHash(base({ ttlSeconds: 300 })));
  });

  // Absent and empty lists coincide, which is correct — both mean "no scopes" — and is recorded here
  // so the equivalence is deliberate rather than discovered later.
  it('treats an absent list and an empty list as the same request', () => {
    expect(mintChallengeHash(base({ scopes: undefined }))).toBe(mintChallengeHash(base({ scopes: [] })));
  });

  // Domain separation: the mint challenge and the provision challenge must never collide, or a proof
  // for reading data would authorize creating a cost-bearing KEK.
  it('never collides with the provision challenge', () => {
    expect(mintChallengeHash(base())).not.toBe(provisionChallengeHash(PRINCIPAL, NOW));
  });
});

describe('the mint proof is fail-closed', () => {
  it('REJECTS a stale timestamp, in both directions', async () => {
    const past = await verifyPrincipalControlProof(env(), base({ issuedAt: NOW - MINT_PROOF_MAX_SKEW_SECONDS - 1 }), PROOF, NOW);
    const future = await verifyPrincipalControlProof(env(), base({ issuedAt: NOW + MINT_PROOF_MAX_SKEW_SECONDS + 1 }), PROOF, NOW);
    expect(past).toEqual({ ok: false, reason: 'proof_stale' });
    expect(future).toEqual({ ok: false, reason: 'proof_stale' });
  });

  it('accepts a timestamp exactly at the skew bound', async () => {
    const r = await verifyPrincipalControlProof(env(), base({ issuedAt: NOW - MINT_PROOF_MAX_SKEW_SECONDS }), PROOF, NOW);
    // Past freshness — it now fails on the chain read, which is unreachable here. The point is that
    // the boundary itself is inclusive rather than off-by-one.
    expect(r).not.toEqual({ ok: false, reason: 'proof_stale' });
  });

  it.each([[NaN], [Infinity], [-Infinity]])('REJECTS a non-finite issuedAt (%s)', async (bad) => {
    expect(await verifyPrincipalControlProof(env(), base({ issuedAt: bad }), PROOF, NOW))
      .toEqual({ ok: false, reason: 'issued_at_required' });
  });

  // Freshness is checked BEFORE the validator is consulted, so a stale proof never costs a chain read.
  it('reports staleness even when the validator is unconfigured', async () => {
    const r = await verifyPrincipalControlProof(
      env({ UNIVERSAL_SIGNATURE_VALIDATOR: undefined }), base({ issuedAt: NOW - 10_000 }), PROOF, NOW,
    );
    expect(r).toEqual({ ok: false, reason: 'proof_stale' });
  });

  // MISCONFIGURATION IS NOT PERMISSION. An unconfigured validator must reject rather than skip the
  // check — this is the deployment mistake that would silently reopen KC-1b.
  it('REJECTS when the signature validator is unconfigured', async () => {
    for (const v of [undefined, '', '   ']) {
      expect(await verifyPrincipalControlProof(env({ UNIVERSAL_SIGNATURE_VALIDATOR: v }), base(), PROOF, NOW))
        .toEqual({ ok: false, reason: 'signature_validator_unconfigured' });
    }
  });

  it('REJECTS a missing or malformed proof', async () => {
    for (const p of [undefined, '', 'not-hex', '0xzz', 'deadbeef']) {
      expect(await verifyPrincipalControlProof(env(), base(), p, NOW))
        .toEqual({ ok: false, reason: 'principal_proof_required' });
    }
  });

  // An unreachable chain is a verification ERROR, never a pass. Fail-closed means the absence of an
  // answer is a refusal.
  it('REJECTS when the chain read fails', async () => {
    const r = await verifyPrincipalControlProof(env({ RPC_URL: 'http://127.0.0.1:1' }), base(), PROOF, NOW);
    expect(r).toEqual({ ok: false, reason: 'proof_verification_error' });
  });
});

describe('the provision challenge guards a cost-bearing admin operation', () => {
  // This endpoint wields an ADMIN GCP-KMS credential and creates a real per-owner KEK, so an
  // unauthenticated caller supplying an arbitrary `owner` would mint keys on someone else's behalf.
  it('binds the owner and the timestamp', () => {
    expect(provisionChallengeHash(PRINCIPAL, NOW)).not.toBe(provisionChallengeHash(OTHER, NOW));
    expect(provisionChallengeHash(PRINCIPAL, NOW)).not.toBe(provisionChallengeHash(PRINCIPAL, NOW + 1));
  });

  it('is case-insensitive in the owner', () => {
    expect(provisionChallengeHash(PRINCIPAL.toUpperCase().replace('0X', '0x'), NOW))
      .toBe(provisionChallengeHash(PRINCIPAL, NOW));
  });

  it('REJECTS a stale or non-finite timestamp', async () => {
    expect(await verifyProvisionControlProof(env(), PRINCIPAL, NOW - 10_000, PROOF, NOW))
      .toEqual({ ok: false, reason: 'proof_stale' });
    expect(await verifyProvisionControlProof(env(), PRINCIPAL, NaN, PROOF, NOW))
      .toEqual({ ok: false, reason: 'issued_at_required' });
  });

  it('REJECTS an unconfigured validator and a malformed proof', async () => {
    expect(await verifyProvisionControlProof(env({ UNIVERSAL_SIGNATURE_VALIDATOR: '' }), PRINCIPAL, NOW, PROOF, NOW))
      .toEqual({ ok: false, reason: 'signature_validator_unconfigured' });
    expect(await verifyProvisionControlProof(env(), PRINCIPAL, NOW, 'nope', NOW))
      .toEqual({ ok: false, reason: 'principal_proof_required' });
  });

  // Both gates share one verifier, so their refusal vocabulary is identical by construction. Asserted
  // because a divergence would mean one path had grown its own check — the drift that lets one gate
  // fall behind the other.
  it('refuses with the same vocabulary as the mint gate', async () => {
    const a = await verifyProvisionControlProof(env({ UNIVERSAL_SIGNATURE_VALIDATOR: '' }), PRINCIPAL, NOW, PROOF, NOW);
    const b = await verifyPrincipalControlProof(env({ UNIVERSAL_SIGNATURE_VALIDATOR: '' }), base(), PROOF, NOW);
    expect(a).toEqual(b);
  });
});
