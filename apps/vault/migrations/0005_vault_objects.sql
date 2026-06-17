-- spec 277 Phase 2 — envelope-encrypted vault storage.
--
-- Replaces the plaintext person_pii / org_sensitive / vault_records read/write
-- path (those tables are retired; the adapter seeds fresh-encrypted here). One
-- row per (owner, resource). Ciphertext + wrapped DEK are stored base64 inline
-- (R2 split is a later refinement); crypto_meta is the VaultObjectEnvelopeV1
-- crypto block (alg, dekKid, keyVersion, aadHash) as JSON. No plaintext column.

CREATE TABLE IF NOT EXISTS vault_objects (
  owner_address   TEXT NOT NULL,
  resource        TEXT NOT NULL,
  classification  TEXT NOT NULL,
  ciphertext_b64  TEXT NOT NULL,
  wrapped_dek_b64 TEXT NOT NULL,
  crypto_meta     TEXT NOT NULL,   -- JSON: { alg, dekKid, keyVersion, aadHash }
  created_at      TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  updated_at      TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  deleted_at      TEXT,
  PRIMARY KEY (owner_address, resource)
);

CREATE INDEX IF NOT EXISTS idx_vault_objects_owner
  ON vault_objects (owner_address)
  WHERE deleted_at IS NULL;
