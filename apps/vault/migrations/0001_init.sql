-- Initial D1 schema for demo-mcp.
-- Two tables: PII profiles + JTI replay tracking.

CREATE TABLE IF NOT EXISTS profiles (
  owner_address TEXT PRIMARY KEY,
  full_name     TEXT NOT NULL,
  email         TEXT NOT NULL,
  phone         TEXT,
  notes         TEXT,
  updated_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS token_usage (
  jti        TEXT PRIMARY KEY,
  usage      INTEGER NOT NULL DEFAULT 0,
  first_seen TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
