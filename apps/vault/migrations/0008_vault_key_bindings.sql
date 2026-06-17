-- spec 278 P4 — per-person vault key bindings. Each row is the host-side record
-- that a person Smart Account authorized THIS server to wield a specific per-person
-- KEK for a bounded scope (the `VaultKeyAuthorization` delegation it presents). NO
-- key material is stored — only the KEK resource ref + the signed authorization blob
-- + its anti-swap hash. Rows are created by the connected-custodian ceremony (P5);
-- until one exists for an owner, every vault operation for that owner fails closed
-- (VKB-D1: no global key for person data).

CREATE TABLE IF NOT EXISTS vault_key_bindings (
  owner_address          TEXT NOT NULL,   -- the person SA (the key domain)
  server_id              TEXT NOT NULL,   -- the host this binding authorizes (e.g. 'demo-mcp')
  vault_id               TEXT NOT NULL,
  kms_key_ref            TEXT NOT NULL,   -- the person's KEK resource name (GCP Cloud KMS)
  allowed_resources      TEXT NOT NULL,   -- JSON string[] of authorized resources
  classification_ceiling TEXT NOT NULL,
  ops                    TEXT NOT NULL,   -- JSON ('read'|'write')[]
  expires_at             TEXT NOT NULL,
  authorization_json     TEXT NOT NULL,   -- the signed VaultKeyAuthorization delegation (JSON)
  authorization_hash     TEXT NOT NULL,   -- sha256 anti-swap pin
  created_at             TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at             TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at             TEXT,
  PRIMARY KEY (owner_address, server_id)
);

-- Live-binding lookup by owner+server skips revoked rows.
CREATE INDEX IF NOT EXISTS idx_vault_key_bindings_live
  ON vault_key_bindings (owner_address, server_id)
  WHERE revoked_at IS NULL;
