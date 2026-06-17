-- spec 277 — drop the pre-vault PII/data tables. All sensitive reads/writes
-- now flow through the encrypted `vault_objects` store (migration 0005) via the
-- demoVault adapter: person PII (`person-pii`), org-sensitive (`org-sensitive`),
-- and the generic per-agent vault (`vault:<type>`) are all AES-256-GCM sealed
-- there. The plaintext tables below held demo seed data only and have no
-- remaining readers (their db.ts accessors were removed in the same change), so
-- they are dropped rather than left as a parallel, unencrypted PII source.
--
-- NOT dropped: `profiles` (the separate low-risk get_profile tool), `token_usage`
-- (JTI replay), `audit_events` (append-only forensics), `vault_objects` (the vault).

DROP TABLE IF EXISTS person_pii;
DROP TABLE IF EXISTS org_sensitive;
DROP TABLE IF EXISTS vault_records;
