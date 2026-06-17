-- spec 277 — fold get_profile onto the vault. The low-risk demo profile
-- (name/email/phone) was the last non-vault PII source: it lived in the plaintext
-- `profiles` table. get_profile now reads it from the encrypted `vault_objects`
-- store (resource `profile`, classification pii.low), sealed on first read via the
-- demoVault adapter — so the plaintext table has no remaining readers and is dropped.
--
-- After this, ALL person/org data demo-mcp serves is AES-256-GCM at rest in
-- `vault_objects`. Remaining tables: token_usage (JTI replay), audit_events
-- (append-only forensics), vault_objects (the vault), d1_migrations (ledger).

DROP TABLE IF EXISTS profiles;
