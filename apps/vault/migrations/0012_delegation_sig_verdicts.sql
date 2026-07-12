-- Durable, cross-isolate cache of POSITIVE + deployed delegation signature verdicts.
--
-- The residual read-flake (after the vault-key hash-pin removed the other per-op RPC): every vault op
-- re-verified the delegation's ERC-1271/6492/ECDSA signature on-chain via `verifyDelegationToken`'s chain
-- reader, which only cached per-ISOLATE. Under Cloudflare isolate churn + polling, that RPC intermittently
-- rate-limited and valid reads flaked. But a valid signature over a FIXED delegation digest is immutable,
-- and a deployed SA never un-deploys — so a `valid && deployed` verdict can be cached forever, checked
-- on-chain ONCE. Keyed by sha256(signer:digest:signature) so any different/forged signature MISSES and is
-- re-verified. Revocation is NOT cached here (it must stay fresh — ADR-0013 revocation freshness).
CREATE TABLE IF NOT EXISTS delegation_sig_verdicts (
  verdict_key TEXT PRIMARY KEY,        -- sha256(signer:digest:signature), all lowercased
  chain_id    INTEGER NOT NULL,
  verified_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);
