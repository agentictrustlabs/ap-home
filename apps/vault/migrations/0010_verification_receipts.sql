-- spec 303 W2 — verifier-retained verification receipts.
--
-- One row per withDelegation terminal decision (allow AND deny). `receipt_json`
-- is the PUBLIC commitment-only VerificationReceiptV1 (exportable, correlator-
-- free). `detail_json` is the PRIVATE opening material (raw principal/tool/
-- argsHash + receiptKey) — INTERIM residency: it belongs in the principal's
-- vault (spec 303 W2 follow-up); storing it here leaks nothing beyond the
-- existing audit_events rows (which already carry actor_id + tool per event),
-- but the vault write is the doctrine target. Append-only — no UPDATE/DELETE
-- path in application code; erasure = delete detail row (public receipt
-- degrades to an anonymous verdict).
CREATE TABLE IF NOT EXISTS verification_receipts (
  receipt_id     TEXT PRIMARY KEY,
  correlation_id TEXT,
  outcome        TEXT NOT NULL,           -- 'allow' | 'deny'
  tool           TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  receipt_json   TEXT NOT NULL,           -- public VerificationReceiptV1
  detail_json    TEXT                     -- private detail (interim; vault-destined)
);
CREATE INDEX IF NOT EXISTS idx_verification_receipts_correlation
  ON verification_receipts (correlation_id);
