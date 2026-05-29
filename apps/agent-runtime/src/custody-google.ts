// THE GATE — Google × KMS custody (spec 235 §5).
//
// demo-a2a is the SOLE holder of the master, so it is the ONLY party that can
// derive a member's per-subject custodian C_sub and compute their Smart Agent
// address. These helpers are the security boundary for the three custody
// endpoints in index.ts:
//
//   /custody/google/resolve            (broker → a2a, bridge-secret) — derive only
//   /custody/google/bootstrap-and-claim (client → a2a, custody session) — deploy + claim
//   /custody/google/sign                (client → a2a, custody session) — sign a digest
//
// Invariants enforced here (spec 235 §9):
//   - A client-facing call NEVER derives/signs without a JWKS-verified,
//     custody-grade, iss/aud-pinned Google session for that exact (iss,sub).
//   - The OIDC (iss,sub) is read from the VERIFIED session, never the body.
//   - The SA we act for is DERIVED from (iss,sub) — never client-supplied; the
//     caller can only ask us to act for the agent their session already proves.
//   - JWKS fetch failure is fail-closed (ADR-0013: no silent fallback).

import { verifyAgentSession, importJwks, type VerifyKey } from '@agenticprimitives/connect';
import { deriveSubjectSigner, type KmsBackend } from '@agenticprimitives/key-custody';
import { createKmsViemAccount } from '@agenticprimitives/key-custody/kms-viem';
import type { Address, Hex } from '@agenticprimitives/types';

export interface OidcSubject {
  iss: string;
  sub: string;
}

/**
 * Parse an `oidcFacetId` (`"<iss>#<sub>"`, e.g.
 * `"https://accounts.google.com#1234"`). `iss` is an https URL (no `#`); split
 * on the LAST `#` so a `#` in the issuer can't shift the boundary.
 */
export function parseOidcPrincipalId(id: string): OidcSubject | null {
  const at = id.lastIndexOf('#');
  if (at <= 0 || at === id.length - 1) return null;
  const iss = id.slice(0, at);
  const sub = id.slice(at + 1);
  if (!iss || !sub) return null;
  return { iss, sub };
}

/** CAIP-10 eip155 id for an address on a chain (lowercased — the canonical form). */
export function caip10(chainId: number, address: Address): string {
  return `eip155:${chainId}:${address.toLowerCase()}`;
}

/** Length-aware constant-time string compare for the server-to-server bridge secret. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ─── Broker JWKS (cached, fail-closed) ────────────────────────────────────

interface JwksCache {
  url: string;
  keys: VerifyKey[];
  at: number;
}
let jwksCache: JwksCache | null = null;
const JWKS_TTL_MS = 5 * 60_000;

/**
 * Fetch + cache the broker's ES256 JWKS. Throws (fail-closed) when the JWKS is
 * unreachable or malformed — the gate maps that to a 503, never a bypass.
 */
async function brokerKeys(jwksUrl: string): Promise<VerifyKey[]> {
  const now = Date.now();
  if (jwksCache && jwksCache.url === jwksUrl && now - jwksCache.at < JWKS_TTL_MS) {
    return jwksCache.keys;
  }
  const res = await fetch(jwksUrl, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`broker JWKS fetch failed: HTTP ${res.status}`);
  const jwks = (await res.json()) as Parameters<typeof importJwks>[0];
  if (!jwks?.keys?.length) throw new Error('broker JWKS has no keys');
  const keys = await importJwks(jwks);
  jwksCache = { url: jwksUrl, keys, at: now };
  return keys;
}

export type GateResult =
  | { ok: true; subject: OidcSubject; sessionSub: string }
  | { ok: false; status: number; error: string };

export interface VerifyCustodySessionOpts {
  jwksUrl: string;
  expectedIss: string;
  expectedAud: string;
}

/**
 * Verify a client-supplied Google custody session against the broker JWKS and
 * enforce the custody-grade gate. On success, returns the OIDC subject read
 * from the VERIFIED session (`principal.id`) plus the session's claimed SA
 * (`sub`, CAIP-10) — the caller cross-checks the latter against the derived SA.
 */
export async function verifyCustodySession(token: string, opts: VerifyCustodySessionOpts): Promise<GateResult> {
  if (!token) return { ok: false, status: 401, error: 'missing session' };
  let keys: VerifyKey[];
  try {
    keys = await brokerKeys(opts.jwksUrl);
  } catch {
    return { ok: false, status: 503, error: 'broker JWKS unavailable (fail-closed)' };
  }
  const v = await verifyAgentSession(token, {
    keys,
    expectedIss: opts.expectedIss,
    expectedAud: opts.expectedAud,
  });
  if (!v.ok) return { ok: false, status: 401, error: `invalid session: ${v.reason}` };
  const s = v.session;
  // Custody-grade gate: only an on-chain-confirmed, custody-grade OIDC session
  // may move a member's KMS custodian (spec 235 §5 step 1).
  if (s.principal.kind !== 'oidc') return { ok: false, status: 403, error: 'session principal is not oidc' };
  if (s.principal.role !== 'custody-grade') return { ok: false, status: 403, error: 'session is not custody-grade' };
  if (s.assurance !== 'onchain-confirmed') return { ok: false, status: 403, error: 'session is not onchain-confirmed' };
  const subject = parseOidcPrincipalId(s.principal.id);
  if (!subject) return { ok: false, status: 400, error: 'malformed oidc principal id' };
  return { ok: true, subject, sessionSub: s.sub };
}

// ─── Per-subject custodian ─────────────────────────────────────────────────

export interface SubjectCustodian {
  /** The per-subject custodian address C_sub. */
  cSub: Address;
  /** Sign a 32-byte digest (e.g. a userOp hash) with C_sub. Returns a 65-byte
   *  EIP-191-wrapped ECDSA sig — accepted by AgentAccount._verifyEcdsa. */
  sign: (digest: Hex) => Promise<Hex>;
}

/**
 * Derive the per-subject custodian for a verified OIDC subject. `masterHex` is
 * `A2A_MASTER_PRIVATE_KEY` from the Worker env (passed explicitly — Workers
 * don't populate `process.env` for the master). The production guard on
 * `LocalSecp256k1Signer` still applies (refuses NODE_ENV=production unless
 * `A2A_ALLOW_LOCAL_MASTER_KEY=true`).
 */
export async function deriveSubjectCustodian(
  subject: OidcSubject,
  masterHex: string,
  backend: KmsBackend = 'local-aes',
): Promise<SubjectCustodian> {
  const signerBackend = deriveSubjectSigner({
    subject: { iss: subject.iss, sub: subject.sub },
    backend,
    config: { derivationSecretHex: masterHex },
  });
  const acct = await createKmsViemAccount(signerBackend);
  return {
    cSub: acct.address,
    sign: async (digest) => (await acct.signMessage({ message: { raw: digest } })) as Hex,
  };
}
