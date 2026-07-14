// VL-W3 — in-isolate DEK-unwrap cache (vault-read latency).
//
// Every vault read decrypts its per-record DEK by calling the owner's GCP Cloud KMS KEK
// (`decryptSessionDataKey` → cross-cloud KMS `:decrypt`, ~50-150ms + rate-limited). That KMS
// round-trip DOMINATES read latency and is the pressure behind the "reads back empty" flakes. A
// record's wrapped DEK + KEK version are IMMUTABLE until the record is rewritten, so the unwrap
// result is safely memoizable: cache (keyId + keyVersion + wrappedDek + aad) → plaintext DEK,
// short-TTL + per-isolate + NEVER persisted. Repeat reads then skip KMS entirely — the 5s inbox
// poll re-reading the same bodies, and demo-gs re-hydrations re-reading the same records.
//
// Security: this sits DOWNSTREAM of the per-op vault-key authorization gate — `authorizePersonVaultOp`
// runs its ERC-1271 verify BEFORE any decrypt, so a cached DEK can NEVER be reached for a revoked or
// unauthorized owner. The DEK already lives in isolate RAM transiently during every decrypt; caching
// only extends its lifetime within the SAME isolate (dies with it), keyed so no cross-owner reuse is
// possible (keyId is the per-owner KEK ref; aad binds owner+resource+classification). The short TTL
// bounds the window in which a just-disabled KEK could still decrypt via cache. No cross-isolate or
// persisted store, ever.
import type { DekWrapper } from '@agenticprimitives/vault';

interface Entry {
  dek: Uint8Array;
  exp: number;
}
const CACHE = new Map<string, Entry>();
const TTL_MS = 60_000;
const MAX = 512;

function b64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}

/**
 * Wrap a {@link DekWrapper} so `decryptSessionDataKey` (the KMS unwrap) is memoized in-isolate.
 * `generateSessionDataKey` (a FRESH DEK per write) is passed straight through — never cached.
 * A returned buffer is always a copy, so a caller can never mutate the cached DEK.
 */
export function cachingDekWrapper(inner: DekWrapper): DekWrapper {
  return {
    generateSessionDataKey: (input) => inner.generateSessionDataKey(input),
    async decryptSessionDataKey(input) {
      const now = Date.now();
      const key = `${input.keyId}\n${input.keyVersion}\n${b64(input.encryptedDataKey)}\n${JSON.stringify(input.aadContext)}`;
      const hit = CACHE.get(key);
      if (hit && hit.exp > now) return hit.dek.slice();
      const dek = await inner.decryptSessionDataKey(input);
      if (CACHE.size >= MAX) CACHE.clear(); // bounded; per-isolate + short-TTL, so a hard clear is fine
      CACHE.set(key, { dek: dek.slice(), exp: now + TTL_MS });
      return dek.slice();
    },
  };
}
