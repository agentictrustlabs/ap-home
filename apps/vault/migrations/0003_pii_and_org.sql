-- Phase 6f.6 — Real PII + Org sensitive-data resources for the Treasury
-- Service Agent demo (spec 211 Act 5/6). Replaces the inline mock
-- records served by demo-a2a's stub endpoints.

CREATE TABLE IF NOT EXISTS person_pii (
  subject_address   TEXT PRIMARY KEY,
  full_name         TEXT NOT NULL,
  email             TEXT NOT NULL,
  phone             TEXT,
  dob               TEXT,
  ssn_last4         TEXT,
  postal_address    TEXT,
  notes             TEXT,
  updated_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS org_sensitive (
  org_address               TEXT PRIMARY KEY,
  legal_name                TEXT NOT NULL,
  ein                       TEXT,
  incorporated_in           TEXT,
  ytd_revenue_usd           INTEGER,
  active_contracts          INTEGER,
  pending_litigation        INTEGER,
  primary_banking           TEXT,
  notes                     TEXT,
  updated_at                TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
