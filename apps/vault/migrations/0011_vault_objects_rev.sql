-- spec 322 W3 — optimistic concurrency for vault objects. Vault writes were last-writer-wins;
-- with multiple execution points this silently merges over concurrent state. `rev` increments on
-- every upsert; a caller MAY pass expectedRev and gets a typed conflict instead of a clobber.
-- The per-principal InteractionsDO remains the ORDERING authority (spec 322 §5); this is
-- defense-in-depth so any out-of-band writer is REJECTED, not silently merged.
ALTER TABLE vault_objects ADD COLUMN rev INTEGER NOT NULL DEFAULT 0;
