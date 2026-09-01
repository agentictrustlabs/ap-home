// Can this chain verify a passkey signature at all?
//
// `P256Verifier` uses the RIP-7212 / EIP-7951 precompile at 0x100 and has no fallback (audit H7-C.2:
// the Daimo one was `try fast catch slow` on a security path, with a squattable address). On a chain
// without it, `staticcall` to an address with no code SUCCEEDS with empty returndata, so verification
// returns false rather than reverting — every assertion is indistinguishable from a bad signature.
//
// The consequence is worse than "sign-in fails": a passkey can still be REGISTERED, because adding one
// is authorized by an existing ECDSA custodian. So a member ends up with a credential that exists on
// their device, is registered on chain, and can never sign — and the discoverable picker keeps offering
// it. Faithnet ran that way until 2026-09-01. Minting a credential the chain cannot use is the thing to
// refuse, not to explain afterwards.
import { DEFAULT_RPC_URL } from './chain';

const P256_PRECOMPILE = '0x0000000000000000000000000000000000000100';

/** A valid P-256 signature over a throwaway key — msgHash(32)||r(32)||s(32)||x(32)||y(32).
 *  A PUBLIC test vector: it authorizes nothing, and the key is used nowhere. Verified to answer 0x…01
 *  on Base Sepolia, which is what makes an empty answer mean "no precompile" and not "bad input". */
const VALID_VECTOR =
  '0xa55a30c45eef1ca4f86b092ef57be9712f0335b4407128f86122af9af502e990' +
  'ddb8f29f9c3737bd09dbe3f42978e6fe831dc367dbefb2b729db2ca60dc0ad20' +
  '2ac69ac24902f4577634884faa0cf3624fa43eee759555ac72b58f2ec26b534d' +
  'e37c08d0c8f32b0efbdd623afa9880ff5b4537325e9e464a226dc168be2574d5' +
  '37e85b05ae5d97170dd17a5efcfc3af28571b83b92a1bdea4aa2160fbc88594a';

export const PASSKEYS_UNVERIFIABLE_MESSAGE =
  'This network cannot verify passkey signatures yet, so a passkey created here could never sign for ' +
  'your agent. Use another credential (wallet, email, phone or Google) — nothing is wrong with your ' +
  'device.';

let cached: boolean | null | undefined;

/** `true` verifiable · `false` definitely not · `null` could not be determined.
 *  A failed probe is NOT a negative answer and must never block a credential that would work. */
export async function passkeysVerifiableOnChain(): Promise<boolean | null> {
  if (cached !== undefined) return cached;
  try {
    const res = await fetch(DEFAULT_RPC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'eth_call',
        params: [{ to: P256_PRECOMPILE, input: VALID_VECTOR }, 'latest'],
      }),
    });
    const j = (await res.json()) as { result?: string };
    if (typeof j.result !== 'string') return null; // unknown: not cached, so a recovered RPC is picked up
    cached = j.result.length >= 66 && BigInt(j.result) === 1n;
    return cached;
  } catch {
    return null;
  }
}

/** Throw before a passkey is created on a chain that provably cannot verify one. Fails OPEN on an
 *  unknown answer: refusing a working credential because a probe timed out is the worse error. */
export async function assertPasskeysVerifiable(): Promise<void> {
  if ((await passkeysVerifiableOnChain()) === false) throw new Error(PASSKEYS_UNVERIFIABLE_MESSAGE);
}
