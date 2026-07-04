// principal-proof.ts — KC-1b (seam audit) proof-of-principal for the demo authorization
// endpoint (`POST /oauth/token`).
//
// The open mint used to accept an arbitrary `principal` from the request body and issue a bearer that
// authorizes reading THAT principal's data — with no proof the caller controls the principal SA. On a
// publicly-reachable deployment (workers.dev) that is a one-request cross-principal PII read (KC-1b).
//
// Fix: the caller MUST prove control of the principal by signing a freshness-bound challenge that binds
// every mint parameter (principal + audience + issuedAt + scopes + fields + ttl). We verify the signature
// via the SAME deployed UniversalSignatureValidator demo-mcp uses everywhere else (ERC-1271/6492/ECDSA/
// WebAuthn), so any connection strategy the principal SA supports works. Fail-closed (ADR-0013): no
// validator, no proof, a stale timestamp, or an invalid signature all reject — no mint.

import { createPublicClient, http, keccak256, toBytes, type Address } from 'viem';

/** UniversalSignatureValidator `isValidSig` — same ABI as the vault-key + credential verifiers. */
const USV_ISVALIDSIG_ABI = [
  {
    type: 'function',
    name: 'isValidSig',
    stateMutability: 'view',
    inputs: [
      { name: 'signer', type: 'address' },
      { name: 'hash', type: 'bytes32' },
      { name: 'sig', type: 'bytes' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

export interface PrincipalProofEnv {
  RPC_URL: string;
  UNIVERSAL_SIGNATURE_VALIDATOR?: string;
}

/** Parameters the mint request signs over. `proof` is the principal SA's signature over the challenge. */
export interface MintProofInput {
  principal: string;
  audience: string;
  /** Unix seconds the proof was created — bounded against replay by MINT_PROOF_MAX_SKEW_SECONDS. */
  issuedAt: number;
  scopes?: string[];
  fields?: string[];
  ttlSeconds?: number;
}

/** ±window (seconds) the `issuedAt` must fall within of server time — bounds signature replay. */
export const MINT_PROOF_MAX_SKEW_SECONDS = 300;

/**
 * Canonical mint challenge. Binds EVERY mint parameter so a captured proof can't be replayed to mint for
 * a different principal, audience, scope set, field set, or ttl. The principal SA signs `keccak256` of this
 * byte string; the client MUST reproduce it exactly (principal lowercased, values joined as below).
 */
export function mintChallengeHash(i: MintProofInput): `0x${string}` {
  const canonical = [
    'demo-mcp:oauth-mint:v1',
    i.principal.toLowerCase(),
    i.audience,
    String(i.issuedAt),
    (i.scopes ?? []).join(','),
    (i.fields ?? []).join(','),
    i.ttlSeconds === undefined ? '' : String(i.ttlSeconds),
  ].join('\n');
  return keccak256(toBytes(canonical));
}

/**
 * Verify the caller controls `principal` by checking the ERC-1271 signature over the mint challenge.
 * Fail-closed: any missing input, stale timestamp, verification error, or false result → not ok.
 */
export async function verifyPrincipalControlProof(
  env: PrincipalProofEnv,
  input: MintProofInput,
  proof: string | undefined,
  nowSeconds: number,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const usv = env.UNIVERSAL_SIGNATURE_VALIDATOR?.trim();
  if (!usv) return { ok: false, reason: 'signature_validator_unconfigured' };
  if (!proof || !/^0x[0-9a-fA-F]+$/.test(proof)) return { ok: false, reason: 'principal_proof_required' };
  if (!Number.isFinite(input.issuedAt)) return { ok: false, reason: 'issued_at_required' };
  if (Math.abs(nowSeconds - input.issuedAt) > MINT_PROOF_MAX_SKEW_SECONDS) return { ok: false, reason: 'proof_stale' };
  const hash = mintChallengeHash(input);
  const client = createPublicClient({ transport: http(env.RPC_URL) });
  let valid = false;
  try {
    valid = (await client.readContract({
      address: usv as Address,
      abi: USV_ISVALIDSIG_ABI,
      functionName: 'isValidSig',
      args: [input.principal as Address, hash, proof as `0x${string}`],
    })) as boolean;
  } catch {
    return { ok: false, reason: 'proof_verification_error' };
  }
  return valid ? { ok: true } : { ok: false, reason: 'proof_invalid' };
}
