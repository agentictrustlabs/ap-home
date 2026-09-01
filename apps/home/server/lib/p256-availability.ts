// Can this chain verify a P-256 (WebAuthn) signature at all?
//
// `P256Verifier` uses the RIP-7212 precompile at 0x100 and nothing else — the Daimo fallback was
// deliberately removed (audit H7-C.2: a `try fast catch slow` security path with a squattable address,
// ADR-0013). The library's own note says chains without the precompile "MUST wire a separate,
// explicitly configured pure-Solidity P-256 verifier at the consumer layer".
//
// Until that is wired, a chain without 0x100 cannot verify ANY passkey. `staticcall` to an address with
// no code SUCCEEDS with empty returndata, so `verify` returns false rather than reverting — every
// assertion looks like a bad signature. Measured 2026-09-01 with one valid vector:
//   Base Sepolia → 0x…01      faithnet (34348) → 0x   (empty)
// On faithnet a passkey can be REGISTERED (that is authorized by an existing ECDSA custodian) but can
// never sign. The sign-in screen offered it anyway, so members burned attempts on something structurally
// impossible and were told their passkey "is not a custodian".
//
// Probed rather than configured: a flag would drift the moment a chain gains the precompile, and this is
// a property of the chain, not of the deployment's opinion about it.
const P256_PRECOMPILE = '0x0000000000000000000000000000000000000100';

/** A valid P-256 signature over a throwaway key — msgHash(32)||r(32)||s(32)||x(32)||y(32).
 *  A PUBLIC test vector, not a credential: it authorizes nothing and the key is not used anywhere.
 *  Verified to return 0x…01 on Base Sepolia, which is what makes an empty answer mean "no precompile"
 *  rather than "bad input". */
const VALID_VECTOR =
  '0xa55a30c45eef1ca4f86b092ef57be9712f0335b4407128f86122af9af502e990' +
  'ddb8f29f9c3737bd09dbe3f42978e6fe831dc367dbefb2b729db2ca60dc0ad20' +
  '2ac69ac24902f4577634884faa0cf3624fa43eee759555ac72b58f2ec26b534d' +
  'e37c08d0c8f32b0efbdd623afa9880ff5b4537325e9e464a226dc168be2574d5' +
  '37e85b05ae5d97170dd17a5efcfc3af28571b83b92a1bdea4aa2160fbc88594a';

const cache = new Map<string, boolean>();

/**
 * True when this chain can verify a WebAuthn signature. `null` when the probe itself could not be
 * completed — unknown is NOT "unsupported", so a transient RPC failure must not hide a working
 * credential method (ADR-0013).
 */
export async function passkeySigningAvailable(rpcUrl: string): Promise<boolean | null> {
  const hit = cache.get(rpcUrl);
  if (hit !== undefined) return hit;
  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'eth_call',
        params: [{ to: P256_PRECOMPILE, input: VALID_VECTOR }, 'latest'],
      }),
    });
    const j = (await res.json()) as { result?: string; error?: unknown };
    if (typeof j.result !== 'string') return null;
    // RIP-7212 answers a VALID signature with a 32-byte 1. Anything shorter (notably `0x`, what an
    // address with no code returns) means there is no verifier here.
    const ok = j.result.length >= 66 && BigInt(j.result) === 1n;
    cache.set(rpcUrl, ok);
    return ok;
  } catch {
    return null; // unknown — say nothing rather than hide a method that may work
  }
}
