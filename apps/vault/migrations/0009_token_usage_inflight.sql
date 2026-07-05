-- spec 290 §3 / MRT-1 (2026-07-04 self-audit) — two-phase JTI reserve column.
--
-- withDelegation defaults usageMode to 'reserve' whenever a Stage-2 soft rate
-- limiter is configured (with-delegation.ts:487) so a throttled 429 RELEASES the
-- reserved delegation use instead of permanently burning it. `reserveUsage` needs
-- an `inflight` counter alongside `usage`; without it verifyDelegationToken fails
-- closed ("usageMode='reserve' requires a JtiStore implementing reserveUsage") and
-- every delegation-gated call denies. D1 is SQLite dialect — mirrors the
-- createSqliteJtiStore migrate() (mcp-runtime/src/jti-stores.ts:152).
ALTER TABLE token_usage ADD COLUMN inflight INTEGER NOT NULL DEFAULT 0;
