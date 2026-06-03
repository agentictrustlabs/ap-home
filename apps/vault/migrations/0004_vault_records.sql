-- Spec 247 — generic per-agent JSON vault. One table holds arbitrary
-- JSON records for any Smart Agent, keyed by (owner_address, record_type).
-- The owner is always the delegation's delegator (the `principal` the
-- withDelegation wrapper recovers), so an agent can only ever read/write
-- its own namespace. record_type strings + the data_json shape are the
-- consuming app's vocabulary (ADR-0021); the substrate is generic.

CREATE TABLE IF NOT EXISTS vault_records (
  owner_address   TEXT NOT NULL,
  record_type     TEXT NOT NULL,
  data_json       TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at      TEXT,
  PRIMARY KEY (owner_address, record_type)
);

-- Live-record lookups by owner (list_vault_record) skip tombstones.
CREATE INDEX IF NOT EXISTS idx_vault_records_owner
  ON vault_records (owner_address)
  WHERE deleted_at IS NULL;
