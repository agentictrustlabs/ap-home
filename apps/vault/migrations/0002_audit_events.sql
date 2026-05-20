-- Append-only audit events. Audit C3 pass 3b.
--
-- Schema mirrors @agenticprimitives/audit.AuditEvent — every column
-- maps 1:1 except `context` which is stored as a JSON-encoded TEXT
-- blob (D1 supports JSON1 but not as a typed column type).
--
-- Append-only by convention: there's no UPDATE / DELETE in the
-- application code. Reviewers should reject any PR that adds one.
--
-- Indices:
--   - PRIMARY KEY (id): immutable; collisions on UUID-shaped IDs are
--     vanishingly rare and would surface as an INSERT failure.
--   - (timestamp DESC): time-ordered scans for forensics.
--   - (correlation_id): pull all events for a single request flow.
--   - (action, outcome): action-by-outcome rollups.

CREATE TABLE IF NOT EXISTS audit_events (
  id              TEXT PRIMARY KEY,
  timestamp       TEXT NOT NULL,
  action          TEXT NOT NULL,
  outcome         TEXT NOT NULL CHECK (outcome IN ('success', 'denied', 'error')),
  correlation_id  TEXT,
  actor_type      TEXT,
  actor_id        TEXT,
  subject_type    TEXT,
  subject_id      TEXT,
  reason          TEXT,
  audience        TEXT,
  chain_id        INTEGER,
  digest          TEXT,
  context_json    TEXT,
  inserted_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_audit_events_timestamp
  ON audit_events (timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_audit_events_correlation
  ON audit_events (correlation_id);

CREATE INDEX IF NOT EXISTS idx_audit_events_action_outcome
  ON audit_events (action, outcome);
