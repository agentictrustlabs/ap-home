-- spec 303 W3 — verifier-retained verification receipts on the A2A ingress
-- (mirrors demo-mcp migration 0010). One row per message/send + resubmit
-- terminal decision. `receipt_json` = the PUBLIC commitment-only receipt;
-- `detail_json` = the PRIVATE opening material — INTERIM residency (vault-
-- destined; leaks nothing beyond the audit_events rows, which already carry
-- actor + skill). Append-only; erasure = delete the detail.
CREATE TABLE IF NOT EXISTS verification_receipts (
  receipt_id     TEXT PRIMARY KEY,
  correlation_id TEXT,
  outcome        TEXT NOT NULL,           -- 'allow' | 'deny'
  tool           TEXT NOT NULL,           -- 'a2a.<skill>'
  created_at     TEXT NOT NULL,
  receipt_json   TEXT NOT NULL,
  detail_json    TEXT
);
CREATE INDEX IF NOT EXISTS idx_verification_receipts_correlation
  ON verification_receipts (correlation_id);
