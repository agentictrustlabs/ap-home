-- demo-a2a durable audit (spec 291 §6c). SAME schema as demo-mcp's
-- 0002_audit_events.sql so A2A + MCP audit rows share one queryable shape across
-- the durable destination. Append-only by convention: app code only INSERTs;
-- reviewers reject any UPDATE/DELETE.
--
-- Activate (infra, one-time): create the D1 DB, paste its id into wrangler.toml
-- [[d1_databases]] binding="DB", then `wrangler d1 migrations apply demo-a2a
-- --remote --env production`. Until the binding exists, buildAuditSink stays
-- console-only (env.DB undefined) — no behavior change.

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
